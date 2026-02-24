# Security Hardening & Post-Release Quality Gaps

> **Source:** Independent codebase review (2026-02-15), vetted against current code.
> Only gaps confirmed as still present in the codebase are listed here.

---

## SEC-01: Dashboard API Unauthenticated

**Files:** `src/dashboard/server.ts`, `src/dashboard/auth-middleware.ts`
**Severity:** S1

`auth-middleware.ts` implements timing-safe Bearer token validation but is never mounted in `server.ts`. All API endpoints are public: `POST /api/task`, `POST /api/steer`, `GET /api/events` (SSE), `GET /api/quota`, `/api/jobs`, `/api/system`.

**Fix:** Mount auth middleware on all non-health routes. Add Bearer token to frontend axios calls. The middleware is already written and tested -- just needs to be wired.

---

## SEC-02: Path Traversal via Unsanitized jobId

**Files:** `src/steering/steering-manager.ts`, `src/steering/flag-manager.ts`
**Severity:** S1

`jobId` parameter used directly in `path.join()` for file path construction without validation. A crafted `jobId` containing `../` could write files outside the steering directory.

**Fix:** Validate jobId format (alphanumeric + hyphens only) before any path construction. Add a shared `validateJobId()` util.

---

## SEC-03: Security Components Never Instantiated

**Files:** `src/orchestrator/orchestrator.ts`, `src/security/*.ts`
**Severity:** S2

Four security modules exist as working code but are never imported or called by the orchestrator:
- `LeakDetector` -- scans for API keys, private keys in outputs
- `PromptDefense` -- 23 injection detection patterns
- `SecretsManager` -- encrypted credential storage
- `IntegrityGuardian` -- file hash baselines

**Fix:** Wire into orchestrator boot sequence. Call `sanitizeInput()` in submitTask, `validateOutput()` in execution-loop event processing, scan tool outputs before yielding.

---

## SEC-04: TOCTOU in Symlink Validation

**File:** `src/security/policy-engine.ts` (now `shell-validator.ts`)
**Severity:** S3

Symlink target resolved and validated, but target could change between validation and file operation.

**Fix:** Use `O_NOFOLLOW` flags or validate at operation time rather than ahead-of-time.

---

## PROV-01: Quota Status Always Returns Healthy

**Files:** All provider files
**Severity:** S2

All three providers return hardcoded `healthScore: 1.0, isExhausted: false` from `getQuotaStatus()`. Router cannot make informed decisions about provider health.

**Fix:** Track actual usage counts. Detect quota/rate-limit headers from API responses. Update health scores based on real data.

---

## PROV-02: No Circuit Breaker on Provider Failures

**Files:** All provider files
**Severity:** S2

Repeated errors don't deactivate providers. Failed requests continue until orchestrator failover (which only works once per task).

**Fix:** Implement circuit breaker pattern: open after N failures in time window, half-open after cooldown.

---

## OPS-06: Retry Backoff Has No Cap

**File:** `src/orchestrator/retry-queue.ts:81`
**Severity:** S2

Backoff formula: `Math.pow(retryCount, 2) * 60_000ms` (quadratic). Retry 10 = 100 min. Retry 20 = 400,000 min. No upper cap. Also, `Invalid Date` from deserialization causes silent permanent stuck.

**Fix:** Cap backoff at 24 hours. Validate Date on deserialization. Guard against `NaN` from `getTime()`.

---

## OPS-07: Daemon Shutdown Has No Timeout

**File:** `src/cli/daemon.ts`
**Severity:** S2

Shutdown sequence (Telegram -> dashboard -> orchestrator -> PID cleanup) has no overall timeout. Any hung step = zombie daemon holding PID file.

**Fix:** Add 30-second shutdown timeout. Force-exit after timeout.

---

## OPS-08: jobId Uses Date.now + Random

**File:** `src/cli/daemon.ts:78`
**Severity:** S3

`job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}` has collision risk under concurrent load.

**Fix:** Use `crypto.randomUUID()` instead.

---

## DASH-01: SSE Has No Reconnection Logic

**File:** `src/dashboard/frontend/src/App.tsx:275`
**Severity:** S3

`EventSource.onerror` logs a warning but doesn't reconnect. User sees stale data forever after disconnect.

**Fix:** Implement reconnection with exponential backoff. Show connection status indicator.

---

## STEER-01: Telegram /status Returns Hardcoded Response

**File:** `src/steering/telegram-gateway.ts:123`
**Severity:** S3

`/status <jobId>` returns `"Monitoring active (simulated)"` instead of querying SessionManager.

**Fix:** Wire to `sessionManager.getSession(jobId)` for real status.

---

## MEM-16: Item Cache Unbounded Growth

**File:** `src/memory/structured-memory.ts:35`
**Severity:** S3

`_itemCache: Map<string, MemoryItem>` grows without bound. Long-running processes with 10k+ items cause memory spikes.

**Fix:** Implement LRU cache with configurable max size (e.g., 1000 entries).

---

## ROUT-01: Heartbeat Tasks Bypass Policy Validation

**File:** `src/routines/heartbeat.ts`
**Severity:** S2

HEARTBEAT.md tasks (unchecked markdown checkboxes) executed as LLM prompts without policy enforcement, cost limits, or approval. Any write to HEARTBEAT.md = task execution.

**Fix:** Route heartbeat tasks through PolicyEngine. Add cost ceiling per heartbeat cycle.

---

## MEM-17: MCP Bridge to Mem0/OpenMemory Not Implemented

**Files:** `src/memory/`, `src/config/`
**Severity:** S3

No integration with Mem0 or OpenMemory MCP servers. Memory is local-only (file-based). Blocks cloud sync and cross-device memory sharing.

**Fix:** Add MCP client bridge that syncs local memory items to a configured Mem0 endpoint.

---

## MEM-18: No SHA-256 Integrity Baselines on MEMORY.md

**Files:** `src/memory/`, `src/security/integrity-guardian.ts`
**Severity:** S3

Read-only enforcement on MEMORY.md is filesystem-level only. No hash verification to detect tampering. IntegrityGuardian exists but isn't wired for memory files.

**Fix:** Generate SHA-256 baselines for MEMORY.md on creation. Verify on each read. Wire IntegrityGuardian.

---

## ASI-01: Intent Capsule Has No Allowed Action Categories

**Files:** `src/orchestrator/orchestrator.ts:413`, `src/security/intent-capsule.ts`
**Severity:** S1
**Context:** Directly addresses the OpenClaw compaction scenario (Summer Yue, Feb 22 2026 — 8.8M impressions). Agent lost "don't action" constraint during context compaction and deleted an inbox.

`createCapsule()` is called with only the sanitized prompt — no `allowedActionCategories` ever passed:

```typescript
// orchestrator.ts:413
this._intentCapsuleManager.createCapsule(sanitizedPrompt);
// ↑ allowedActionCategories defaults to [] — category blocking never fires
```

Without categories, drift detection falls back to keyword overlap only. If the user's prompt contains action words (e.g. "suggest what you would *delete*"), those keywords appear in the mandate and subsequent delete actions score as *consistent*. The structural block is never engaged.

**Fix:**
1. Add `inferCategories(mandate: string): string[]` to `IntentCapsuleManager` that parses constraint signals:
   - "don't action" / "suggest only" / "preview" / "dry run" → `['read']`
   - "don't delete" / "read only" → `['read', 'write']`
   - "confirm before" → set `allowedActionCategories: []` + wire `always_flag` for all actions
2. Call it in `submitTask()`:
   ```typescript
   const inferredCategories = this._intentCapsuleManager.inferCategories(sanitizedPrompt);
   this._intentCapsuleManager.createCapsule(sanitizedPrompt, {
     allowedActionCategories: inferredCategories,
   });
   ```

---

## ASI-02: Drift Detection is Advisory-Only in Headless Mode

**Files:** `src/security/policy-engine.ts:622–634`
**Severity:** S1
**Context:** Same compaction scenario. Agent running unattended (phone, API, Telegram) has no `flagCallback`. Drift fires but silently allows the action.

```typescript
// policy-engine.ts:633
// If no flag callback, log but allow (to avoid breaking non-interactive flows)
```

In the exact scenario where compaction is most dangerous — long-running, unattended, headless — drift detection produces a log line and then permits the destructive action. The constraint is decorative.

**Fix:**
1. Add `driftBlockingMode: 'advisory' | 'strict' | 'paranoid'` to `ZoraPolicy` config (default: `'strict'`).
2. Wire into `createCanUseTool()` drift block:
   ```typescript
   if (!driftResult.consistent && !this._flagCallback) {
     if (this._driftBlockingMode === 'strict') {
       const destructive = ['delete', 'write', 'bash', 'unknown'].includes(driftAction);
       if (destructive) {
         return { behavior: 'deny', message: `Goal drift blocked (strict): ${driftResult.reason}` };
       }
     } else if (this._driftBlockingMode === 'paranoid') {
       return { behavior: 'deny', message: `Goal drift blocked (paranoid): ${driftResult.reason}` };
     }
     // advisory: log only (existing behavior)
   }
   ```
3. Expose in `policy.toml` under `[security]`:
   ```toml
   drift_blocking_mode = "strict"  # advisory | strict | paranoid
   ```

This is the fastest fix. One config field + ~10 lines closes the headless enforcement gap without requiring NLP changes.

---

## ASI-03: Active Intent Capsule Not Persisted Across Failover or Restart

**Files:** `src/orchestrator/orchestrator.ts`, `src/security/intent-capsule.ts`
**Severity:** S2

The active capsule lives only in `IntentCapsuleManager._activeCapsule` (in-process memory). If the process crashes mid-task and restarts (failover path, `RetryQueue` replay, or daemon restart), the capsule is null. Drift detection silently disables itself — `checkDrift()` returns `{ consistent: true, confidence: 0 }` with no active capsule.

**Fix:**
1. On `createCapsule()`, serialize the capsule to `ObservationStore` (or a dedicated `capsule-store`) keyed by `jobId`.
2. In `_executeWithProvider()` failover/retry path, reload the capsule by `jobId` before continuing execution.
3. On `clearCapsule()` (session end), delete the persisted entry.

**Priority order for implementation:** ASI-02 → ASI-01 → ASI-03
