# SPEC-002: Agent-Level Error Recovery (Architect Revision)

**Status:** Approved for Implementation
**Architect:** Gemini (Veteran Architect Mode)
**Date:** 2026-02-22
**Target System:** Zora Orchestration Engine

---

## 1. Executive Summary

Current recovery logic in Zora is "lossy." When an agent fails or retries, it often loses the specific failure context (State Continuity) or enters infinite loops of identical failing behavior (Groundhog Day). This spec implements a multi-layered recovery strategy: Hard Budgets, State Continuity via Context Resumption, and a Global Negative Cache to prevent fleet-wide systemic failures.

---

## 2. Design Principles (Revised)

- **State Continuity First:** Resuming a task must use the exact TaskContext of the failure, not a reconstructed prompt.
- **Negative Learning:** Knowledge of what doesn't work is as valuable as what does.
- **Entropy-Based Termination:** If the agent is talking but the state isn't changing, kill the task.
- **Sanitized Transparency:** Errors must be visible to the LLM but stripped of injection vectors.

---

## 3. Component Specifications

### [KEEP FROM ORIGINAL] ERR-09: Hard Recovery Budget

**Files:** `src/types.ts`, `src/orchestrator/orchestrator.ts`

**Behavior:**
- Add the `errorBudget` object to `TaskContext`.
- **Enforcement:** The Orchestrator must check `budgetConsumed` against `maxBudget` before every provider call.
- **Slope Detection (New):** If `Context.history.length` increases by 3 turns without a new `tool_call` or a change in `memoryContext`, emit `error_budget_exceeded` with subtype `stale_state_loop`.

```typescript
interface ErrorBudget {
  maxBudget: number;         // max retry attempts
  budgetConsumed: number;    // retries consumed so far
  maxTurns: number;          // turn hard limit
  turnsConsumed: number;     // turns consumed so far
}
```

---

### [MODIFIED] ERR-07: Safe Error Replay & Normalization

**Files:** `src/providers/base-provider.ts`, `src/lib/error-normalizer.ts`

**Behavior:**
- Instead of raw strings, use an `ErrorNormalizer` to categorize the error.
- **Normalization:** Map raw stderr/exception to categories: `AUTH_FAILURE`, `SYNTAX_ERROR`, `TIMEOUT`, `NOT_FOUND`, `UNKNOWN`.
- **Safe Replay:** Wrap replayed errors in `<failure_report>` tags. Truncate to 400 chars. Redact PII using `LeakDetector`.

**Prompt Structure:**
```xml
<tool_result id="call_123" status="error">
  <failure_report category="SYNTAX_ERROR">
    The python interpreter returned: "IndentationError: expected an indented block"
  </failure_report>
</tool_result>
```

**Security:** The parser must treat `<failure_report>` as a terminal leaf node. It cannot be used to close other tags (protection against prompt injection in error strings).

---

### [KEEP FROM ORIGINAL] ERR-08: Resume Path via TaskContext

**Files:** `src/orchestrator/orchestrator.ts`

**Behavior:**
- Implement `private async _resumeTask(context: TaskContext)`.
- This method skips the "Planning/Classification" phase and immediately re-injects the existing `history` and `memoryContext` into the provider loop.
- **Requirement:** The retry-queue must persist the full serialized `TaskContext` to the database, not just the original prompt.

---

### [NEW] ERR-12 Lite: Global Negative Cache (Cross-Session Learning)

**Problem:** Prevent agents from repeating expensive, known-failing tool calls across different sessions.

**Files:** `src/services/negative-cache.ts`

**Behavior:**
- **Signature Generation:** `hash(tool_name + normalized_args)`.
- **Persistence:** File-based persistence (Path: `~/.zora/state/negative-cache.json`). TTL: 24 hours.
- **Threshold:** If a signature has > 5 failures in the last 60 minutes, it is marked as "Hot-Failing."
- **Intervention:** Before `Provider.execute()`, the Orchestrator checks the cache. If "Hot-Failing," it injects a system hint:
  ```
  SYSTEM: The planned tool call '[tool_name]' with these specific parameters is currently failing system-wide. Attempt an alternative approach or verify dependencies.
  ```

**Storage TTL:** Cache entries must have a TTL of 24 hours to prevent "stale failure" memory.

---

### [NEW] ERR-10: In-Session Repeat Detection (Circuit Breaker)

**Files:** `src/orchestrator/error-pattern-detector.ts`

**Behavior:**
- Maintain a rolling window of the last 5 `tool_results`.
- If the same signature (Tool + Args) appears twice with an error, the Orchestrator must inject a Hard Steering Hint:
  ```
  You have attempted [ToolName] with these arguments twice and failed. You MUST change your parameters or use a different tool.
  ```

---

## 4. Implementation Order & Dependencies

### Phase 1: Foundations
1. Implement `ErrorNormalizer` and `errorBudget` types.
2. Update Orchestrator to enforce budgets.

### Phase 2: State Continuity
3. Refactor Orchestrator to support `_resumeTask`.
4. Update `RetryQueue` to handle full `TaskContext` serialization.

### Phase 3: Intelligence
5. Implement `NegativeCache` service (ERR-12 Lite).
6. Add `ErrorPatternDetector` to the tool loop.

---

## 5. Security & Performance Guardrails

- **No-Execute Error Tags:** The parser must treat `<failure_report>` as a terminal leaf node. It cannot be used to close other tags.
- **Storage TTL:** ERR-12 Lite cache entries must have a TTL of 24 hours to prevent "stale failure" memory.
- **Token Cap:** Replayed error history is capped at 10% of the total token window. If history exceeds this, oldest error details are pruned first.

---

## 6. Acceptance Criteria

| Criterion | Test |
|-----------|------|
| **Resumption** | A task failing due to a 504 Timeout recovers with its full conversation history intact |
| **Budgeting** | A task set to `max_turns: 5` terminates exactly at turn 6 with a `budget_exceeded` event |
| **Learning** | If User A fails a tool call 5 times, User B receives a "System-wide failure" warning |
| **Sanity** | No raw PII or un-sanitized stack traces appear in the final LLM prompt |

---

## 7. Team Topology

Following Team Topologies principles, this spec is implemented by three stream-aligned teams with an enabling team:

| Team | Focus | Components |
|------|-------|------------|
| **Stream Team A — Foundation** | Types, normalization infrastructure | `types.ts` (errorBudget), `error-normalizer.ts` |
| **Stream Team B — Orchestration** | Budget enforcement, resume path | `orchestrator.ts` (ERR-09, ERR-08) |
| **Complicated-Subsystem Team** | Pattern detection, cross-session caching | `error-pattern-detector.ts`, `negative-cache.ts` |
| **Enabling Team — Quality** | Tests, validation | Unit + integration tests |

Teams A and the Complicated-Subsystem Team work in parallel on Phase 1/3. Stream Team B depends on Team A completing the type additions before integrating.

---

## 8. Files Changed

| File | Change Type | Gap |
|------|-------------|-----|
| `src/types.ts` | Modified | ERR-09 |
| `src/lib/error-normalizer.ts` | New | ERR-07 |
| `src/orchestrator/error-pattern-detector.ts` | New | ERR-10 |
| `src/services/negative-cache.ts` | New | ERR-12 Lite |
| `src/orchestrator/orchestrator.ts` | Modified | ERR-08, ERR-09, ERR-10, ERR-12 |
| `src/orchestrator/retry-queue.ts` | Modified | ERR-08 |
| `tests/unit/orchestrator/error-pattern-detector.test.ts` | New | ERR-10 |
| `tests/unit/services/negative-cache.test.ts` | New | ERR-12 |
| `tests/unit/lib/error-normalizer.test.ts` | New | ERR-07 |
