# Signal Secure Channel — Implementation Plan

**Spec:** `/Users/ryaker/Dev/Zora_Sims/SPEC-signal-secure-channel.md`
**Status:** Waiting for PR #141 to merge, then begin Phase 0
**Branch to create:** `feature/signal-secure-channel`
**Last updated:** 2026-03-09

---

## Critical Path & Dependency Graph

```
[GATE: PR #141 merged to main]
         │
         ▼
[P0] src/types/channel.ts          ← blocking everything; serial first
         │
    ┌────┴─────────────────────────────────────────────┐
    │           WAVE 1 — 4 agents in parallel           │
    │                                                   │
    ▼            ▼               ▼              ▼       │
A: signal-   B: channel-     C: quarantine   D: config  │
   identity     identity-       processor     schema +  │
   .ts          registry.ts     .ts           casbin/   │
               (loads TOML)    (haiku LLM)   model.conf │
    │            │
    └────────────┤
                 ▼
         [WAVE 2 — serial: registry must be ready]
         E: channel-policy-gate.ts   (casbin, needs registry)
                 │
                 ▼
         F: capability-resolver.ts   (needs gate + registry)
                 │
         ┌───────┴───────────────────────────┐
         │        WAVE 3 — 3 in parallel     │
         ▼             ▼                     ▼
   G: orchestrator  H: execution-loop   I: signal-intake-adapter.ts
      .ts modify       .ts modify            + signal-response-gateway.ts
      (channelContext)  (tool allowlist)      (signal-sdk wiring)
         │             │                     │
         └─────────────┴─────────────────────┘
                             │
                             ▼
                    [WAVE 4 — 4 in parallel]
         J: rate-limit   K: audit-log   L: metrics   M: TOML validation
```

---

## WSJF Priority (for non-parallelizable decisions)

| Rank | Item | WSJF | Rationale |
|------|------|------|-----------|
| 1 | `types/channel.ts` | 28 | Blocks everything |
| 2 | `signal-identity.ts` | 16 | Small, unblocks adapter |
| 3 | `config schema + casbin model` | 14 | Unblocks policy gate |
| 4 | `TOML validation` | 13 | Fail-fast on bad config = security |
| 5 | `capability-resolver.ts` | 11.5 | Unblocks wiring |
| 6 | `execution-loop.ts` mod | 11.5 | INVARIANT-2 enforcement |
| 7 | `channel-identity-registry.ts` | 11 | Unblocks gate |
| 8 | `orchestrator.ts` mod | 11 | Wires capability end-to-end |
| 9 | `channel-policy-gate.ts` | 8.3 | Core security gate |
| 10 | `quarantine-processor.ts` | 8.0 | INVARIANT-4 |
| 11 | `audit-log` | 9.0 | Security requirement before demo |
| 12 | `signal-intake-adapter.ts` | 5.25 | Needs all above first |
| 13 | `rate-limiting` | 7.5 | Phase 5 |
| 14 | `prompt-injection-scanner.ts` | 7.0 | Optional layer |
| 15 | `metrics/SRE` | 5.0 | Polish |

---

## Phase 0 — Prerequisites (~30 min, serial)

**Trigger:** PR #141 merged to main.

```bash
git checkout main && git pull
git checkout -b feature/signal-secure-channel
npm install signal-sdk casbin
java -version   # Must show 25+; if not: brew install openjdk@25
echo "config/channel-policy.toml" >> .gitignore
ls node_modules/signal-sdk/bin/  # Verify signal-cli binary downloaded
```

---

## Phase 1 — Foundation (~2 days)

### Serial: types first

**File:** `src/types/channel.ts`

```typescript
export interface ChannelIdentity {
  type: "signal";
  phoneNumber: string;       // E.164 format: "+14155551234"
  signalUuid?: string;
  displayName?: string;
  isLinkedDevice: boolean;
}

export interface ChannelMessage {
  id: string;
  from: ChannelIdentity;
  channelId: string;         // "direct" | group UUID
  channelType: "direct" | "group";
  content: string;
  timestamp: Date;
  attachments?: string[];
}

export interface CapabilitySet {
  senderPhone: string;
  channelId: string;
  role: string;              // "trusted_admin" | "trusted_user" | "read_only" | "denied"
  allowedTools: string[];
  destructiveOpsAllowed: boolean;
  actionBudget: number;
  paramConstraints?: {
    bash?: { commandAllowlist?: string[]; commandBlocklist?: string[] };
    write_file?: { pathAllowlist?: string[] };
  };
}

export interface ScopedTask {
  intent: StructuredIntent;
  capability: CapabilitySet;
  channelMessage: ChannelMessage;
}

export interface StructuredIntent {
  goal: string;
  params: Record<string, unknown>;
  taintLevel: "trusted" | "channel_sourced";
}
```

### Wave 1 — 4 agents in parallel (after types committed)

**Agent A:** `src/channels/signal/signal-identity.ts`
- Normalize phone to E.164
- Map signal-sdk envelope fields to `ChannelIdentity`
- `msg.envelope.sourceNumber` → `phoneNumber`
- `msg.envelope.sourceUuid` → `signalUuid`

**Agent B:** `src/channels/channel-identity-registry.ts`
- Load `config/channel-policy.toml` using `@iarna/toml` or `smol-toml`
- Hot-reload on `SIGHUP` (re-read file, update in-memory map)
- Methods: `getUsers()`, `getCapabilitySets()`, `reload()`

**Agent C:** `src/channels/quarantine-processor.ts`
- Call Haiku (`claude-haiku-4-5-20251001`) with no tools
- System prompt: extract intent only, set `suspicious: true` on injection patterns
- Output: `StructuredIntent` with `taintLevel: "channel_sourced"`
- If `suspicious`, reject task, alert sender

**Agent D:** Config files (no code deps, pure config)
- `config/casbin/model.conf` — RBAC-with-domains model (exact content from spec §7.2)
- `config/channel-policy.example.toml` — reference config (exact content from spec §6)

### Wave 2 — serial after B completes

**E:** `src/channels/channel-policy-gate.ts`
- Casbin enforcer wrapping registry
- `canIntake(senderPhone, channelId): Promise<boolean>`
- `getRole(senderPhone, channelId): string | null`
- Build Casbin policy from registry at startup + on hot-reload

**F:** `src/channels/capability-resolver.ts`
- `resolve(senderPhone, channelId): CapabilitySet`
- Calls gate.getRole() → looks up capability_sets[role]
- Returns denied CapabilitySet if role is null
- `reload()`: delegates to registry.reload() + gate rebuild

*Acceptance gate: Unit tests pass for policy with 3 user/channel combinations*

---

## Phase 2 — Wiring (~2 days, Wave 3 parallel)

All 3 independent touch points — run simultaneously:

**Agent G:** `src/orchestrator/orchestrator.ts`
- Add to `SubmitTaskOptions`:
  ```typescript
  channelContext?: {
    capability: CapabilitySet;
    channelMessage: ChannelMessage;
  }
  ```
- When present: pass `capability.allowedTools` to ExecutionLoop, override budget, set dryRun if `!destructiveOpsAllowed`

**Agent H:** `src/orchestrator/execution-loop.ts`
- Add `toolAllowlist?: string[]` param
- Filter registered tools before SDK invocation:
  ```typescript
  const effectiveTools = toolAllowlist
    ? allRegisteredTools.filter(t => toolAllowlist!.includes(t.name))
    : allRegisteredTools;
  ```
- INVARIANT-2: filter happens before any SDK call, not after

**Agent I:** Signal adapters
- `src/channels/signal/signal-intake-adapter.ts`
  - Wrap `SignalCli` from signal-sdk
  - Lifecycle: `start()`, `stop()`, exponential backoff reconnect (max 5 retries)
  - Message dedup (signal-cli can redeliver)
  - Reject messages > 10,000 chars (DoS)
  - Map envelope → `ChannelMessage`
  - Log sender + channel on receipt (never content)
- `src/channels/signal/signal-response-gateway.ts`
  - `send(to, channelId, content): Promise<void>`
  - Truncate at 3,800 chars: append `[truncated — full output saved]`
  - Write full output to daily note file for retrieval
  - Group replies: quote original message

Then wire in `src/index.ts` (or wherever Zora daemon starts):
- Import `startSignalChannel` function
- Call only if `config.signal` section present
- Expected startup logs per spec §8:
  ```
  [signal] Connecting to signal-cli daemon...
  [signal] Daemon ready on port 9200
  [signal] Listening for messages on +1BOT_NUMBER
  [policy] Loaded N users, 3 capability sets from channel-policy.toml
  [policy] Casbin model loaded from config/casbin/model.conf
  [zora] Signal channel active
  ```

*Acceptance gate: All 6 startup log lines visible with `npm run dev`*

---

## Phase 3 — Hardening (~1 day, Wave 4 parallel)

**Agent J:** Rate limiting (`src/channels/signal/rate-limiter.ts`)
- Max 10 tasks/hour per sender
- In-memory Map, prune on each check
- If exceeded: respond "Rate limit reached. Try again in X minutes."

**Agent K:** Audit log (`src/channels/audit-log.ts`)
- Append-only file (`~/.zora/audit/signal-YYYY-MM-DD.log`)
- Events: `intake_accepted`, `intake_denied`, `task_started`, `task_completed`, `tool_call`, `tool_call_blocked`, `budget_exceeded`, `quarantine_flagged`, `provider_failover`, `config_reloaded`
- INVARIANT-6: no delete/truncate code path anywhere

**Agent L:** Metrics
- Counters: intake_count, policy_deny_count, quarantine_block_count, execution_errors
- Expose to existing SRE exporter (port 9103-9106 range — check PORT_REGISTRY.md)

**Agent M:** TOML config validation
- On startup: validate `channel-policy.toml` structure
- Fail fast with clear error (missing phone, bad role names, etc.)
- Use zod or manual validation (no new deps if possible)

Optional (separate ticket after launch):
- `src/channels/prompt-injection-scanner.ts` — llm-guard REST sidecar, call `/analyze`, block if high-risk

---

## Security Invariant Checklist (before merge to main)

```
[ ] INVARIANT-1: No tool exec without CapabilitySet (unit test: mock cap, verify tool blocked)
[ ] INVARIANT-2: Allowlist applied before SDK invocation (code review execution-loop.ts)
[ ] INVARIANT-3: Unknown sender → NO response (run INT-04, check audit log only)
[ ] INVARIANT-4: Channel content → QuarantineProcessor only (trace path in code review)
[ ] INVARIANT-5: Capability not expanded on failover (run INT-08)
[ ] INVARIANT-6: Audit log append-only (grep codebase for any truncate/delete on audit file)
[ ] INVARIANT-7: Daemon crash → intake stops (kill signal-cli pid, verify no messages processed)
```

---

## Files Changed in Existing Code (minimal surface)

| File | Change | ~Lines |
|------|--------|--------|
| `src/orchestrator/orchestrator.ts` | Add `channelContext` to `SubmitTaskOptions` | 20 |
| `src/orchestrator/execution-loop.ts` | `toolAllowlist` filter before SDK | 10 |
| `src/index.ts` | Call `startSignalChannel()` if signal config | 15 |
| `src/config/index.ts` | Add `SignalConfig` + `ChannelPolicyConfig` schema | 30 |
| `.gitignore` | Add `config/channel-policy.toml` | 1 |

All other changes are **net-new files** — no risk to existing functionality.

---

## Integration Test Checklist (all must pass before external demo)

```
[ ] INT-01: Basic response (admin → "2+2" → "4")
[ ] INT-02: File read works (trusted_admin reads /tmp file)
[ ] INT-03: Read-only cannot write (file must NOT exist after attempt)
[ ] INT-04: Unknown sender silently dropped (no Signal response, only audit log)
[ ] INT-05a: Group scope allows write for trusted_user
[ ] INT-05b: DM scope denies write for same trusted_user
[ ] INT-06a/b/c: All 3 injection payloads blocked (suspicious=true)
[ ] INT-07: Action budget stops task at N tool calls
[ ] INT-08: Failover preserves capability set (not expanded)
[ ] INT-09: Hot-reload adds new user without restart
[ ] INT-10: Safety number change triggers alert + stops intake
```

---

## One-Time Device Setup (before any tests)

```bash
# Run once on the machine where Zora runs
npx signal-sdk link --name "zora-agent"
# → Scan QR in Signal mobile: Settings → Linked Devices → Link New Device
# Credentials persist in ~/.local/share/signal-cli/

# Smoke test the link:
node -e "
const { SignalCli } = require('signal-sdk');
const s = new SignalCli('+1YOUR_BOT_NUMBER');
s.connect().then(async () => {
  await s.sendMessage('+1YOUR_PHONE', 'Zora linked device active');
  await s.disconnect();
});
"
```

---

## Kickoff Prompt for Zora

Use this prompt to start Phase 0 + Phase 1 via `zora-agent ask`:

```
Implement Phase 1 of the Signal secure channel integration for Zora.
Spec: /Users/ryaker/Dev/Zora_Sims/SPEC-signal-secure-channel.md
Plan: /Users/ryaker/Dev/AgentDev/gaps/SIGNAL_SECURE_CHANNEL_PLAN.md

Steps:
1. Create branch: feature/signal-secure-channel from main
2. Run: npm install signal-sdk casbin (in ~/Dev/AgentDev)
3. Add config/channel-policy.toml to .gitignore
4. Implement src/types/channel.ts (all types from plan §Phase 1)
5. Implement these 4 files in parallel worktrees:
   - src/channels/signal/signal-identity.ts
   - src/channels/channel-identity-registry.ts
   - src/channels/quarantine-processor.ts
   - config/casbin/model.conf + config/channel-policy.example.toml
6. Commit each file with descriptive message
7. Run npm run lint + npm test after each commit

Do NOT touch orchestrator.ts or execution-loop.ts yet — that is Phase 2.
Do NOT start signal-sdk device linking — that requires user interaction.
```
