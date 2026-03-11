# Contrarian Audit

Date: 2026-03-07

Scope: repo-wide audit of runtime code, security posture, tech debt, and stubs, excluding `ingest_cybergraph`.

Method: static code inspection of `src/`, selected tests, and security/docs claims. I did not run the test suite for this audit.

## Executive Summary

The repo has several strong building blocks, but the security story is materially better in documentation than in runtime wiring. The core SDK path has real guardrails, yet multiple advertised protections are optional, partially wired, or entirely inert. The biggest contrarian takeaway is not "the code is sloppy"; it is "the code contains serious security primitives, but too many of them are parked off to the side."

Highest-risk themes:

- Dashboard protection is optional, and the daemon can be rebound away from localhost with `ZORA_BIND_HOST`.
- Network policy exists in config and presets, but the default execution loop still exposes `WebSearch` and `WebFetch` without any network-policy enforcement.
- The audit system is mostly a verifier/reader today, not an always-on runtime recorder. If fully wired as written, it would also persist raw tool args/results.
- Several user-visible capabilities are still stubs or "paper features": `request_permissions`, the hook system, `/api/policy`, and TLCI `dbQuery`.

What is solid:

- Shell tokenization and chained-command splitting in `src/security/shell-validator.ts` are stronger than average.
- Mainline file/shell access control in `PolicyEngine.createCanUseTool()` is materially better than a naive prefix check.
- The skill scanner is one of the more mature components in the repo.

## Findings

### 1. Dashboard auth is optional, but the dashboard can be rebound off localhost

Severity: Critical

Why it matters:

- The dashboard exposes task submission, steering injection, job history, health, quota, and SSE streams.
- Auth is skipped entirely when `dashboardToken` is unset (`src/dashboard/server.ts:80-89`).
- The daemon passes `host: process.env.ZORA_BIND_HOST` into the dashboard server (`src/cli/daemon.ts:80-95`), and the server will bind to that host instead of `127.0.0.1` (`src/dashboard/server.ts:444-449`).
- Once rebound to `0.0.0.0` or a LAN IP without a token, the APIs at `/api/task`, `/api/steer`, `/api/history`, `/api/jobs`, and `/api/events` become remotely reachable (`src/dashboard/server.ts:240-330`, `src/dashboard/server.ts:352-381`).

Contrarian point:

- The code assumes "localhost-only" as a trust boundary, but the daemon already has a runtime escape hatch that defeats that assumption.

Recommendation:

- Refuse non-loopback binds unless a token is configured.
- Generate a dashboard token by default during `init`.
- Treat unauthenticated mode as development-only and make it explicit in config, not implicit by omission.

### 2. Network policy is declared in presets and types, but it is not enforced in the execution loop

Severity: Critical

Why it matters:

- The policy model includes `network.allowed_domains`, `network.denied_domains`, and `network.max_request_size` (`src/types.ts:653-686`).
- Presets explicitly configure those fields, for example `allowed_domains = ['https://*']` in safe/balanced/power (`src/cli/presets.ts:69-73`, `src/cli/presets.ts:106-110`).
- `ExecutionLoop` still enables `WebSearch` and `WebFetch` by default (`src/orchestrator/execution-loop.ts:115-118`, `src/orchestrator/execution-loop.ts:166-175`).
- `PolicyEngine.createCanUseTool()` contains explicit checks for `Bash`, `Read`, `Write`, `Edit`, `Glob`, and `Grep`, but no branch for `WebSearch` or `WebFetch` (`src/security/policy-engine.ts:520-585`).
- A repo-wide search found no production enforcement of `allowed_domains`, `denied_domains`, or `max_request_size`.

Contrarian point:

- The policy schema and docs create the impression that outbound network access is governed. In practice, the default SDK tool list outruns the policy engine.

Recommendation:

- Add explicit `WebSearch`/`WebFetch` enforcement in `createCanUseTool()`.
- Disable network tools by default unless the policy enables them.
- Enforce domain allow/deny lists in one place instead of relying on documentation.

### 3. The audit log is mostly a CLI reader/verifier today, not a runtime source of truth

Severity: High

Why it matters:

- README and SECURITY claim that every action is written to a tamper-proof log (`README.md:96-105`, `SECURITY.md:225-249`).
- `AuditLogger` does implement a hash-chained log and a Claude SDK post-tool hook (`src/security/audit-logger.ts:168-210`).
- But the only production construction I found is inside the CLI `audit` command for reading/verifying (`src/cli/audit-commands.ts:35-60`).
- `PolicyEngine` exposes `setAuditLogger()` (`src/security/policy-engine.ts:116-121`), yet `Orchestrator.boot()` never constructs an `AuditLogger` or calls that setter (`src/orchestrator/orchestrator.ts:162-179`).

Contrarian point:

- The repo has a good audit logger implementation and still does not appear to have an always-on audit pipeline in the main runtime path.

Recommendation:

- Instantiate `AuditLogger` during orchestrator boot.
- Wire it into policy events, tool execution hooks, and steering/task submission events.
- Downgrade the docs until the runtime path matches the claim.

### 4. If the audit logger were wired as written, it would persist raw tool args and outputs

Severity: High

Why it matters:

- ADR-006 claims audit data minimization and redaction/hashing of sensitive fields (`docs/adr/ADR-006-security-architecture.md:31-34`).
- The current `createPostToolUseHook()` writes raw `toolInput` and raw `toolResponse` into the audit entry (`src/security/audit-logger.ts:187-201`).
- That is the opposite of "redacts or hashes sensitive fields."

Contrarian point:

- The current gap is worse than "audit logging is missing." The implemented hook also encodes the wrong privacy behavior.

Recommendation:

- Redact through `LeakDetector` before persistence.
- Hash large or sensitive payloads, and keep only a compact forensic envelope.

### 5. Tool-output injection defense is implemented but not actually in the execution path

Severity: High

Why it matters:

- `sanitizeToolOutput()` and `validateOutput()` exist and are documented as key defenses (`src/security/prompt-defense.ts:98-170`, `SECURITY.md:212-215`).
- A repo-wide search found production usage of `sanitizeInput()` in `Orchestrator.submitTask()` (`src/orchestrator/orchestrator.ts:443`), but no production call sites for `sanitizeToolOutput()` or `validateOutput()`.
- Current runtime behavior scans tool call args and tool results for leaked secrets, but only logs warnings; it does not sanitize the content before the model sees it (`src/orchestrator/orchestrator.ts:597-620`).

Contrarian point:

- The repo documents tool-output injection defense as if it is active. The current runtime path does not support that claim.

Recommendation:

- Sanitize tool results before they enter the next model turn.
- Validate suspicious tool invocations before execution, not just after.

### 6. `request_permissions` is a stub presented as a real tool

Severity: High

Why it matters:

- The custom tool description says the user will be asked to approve the permission request (`src/orchestrator/orchestrator.ts:1203-1204`).
- The handler never calls `expandPolicy()`, never invokes any approval callback, and always returns `granted: false, pending: true` (`src/orchestrator/orchestrator.ts:1214-1239`).
- This means the LLM is taught to rely on a capability escalation path that does not exist.

Contrarian point:

- This is more dangerous than a missing feature because it creates false affordances inside the agent loop.

Recommendation:

- Either wire it to a real approval flow plus `PolicyEngine.expandPolicy()` or remove it from the exposed toolset.

### 7. Hooks are parsed and surfaced in CLI, but there is no production registration path

Severity: High

Why it matters:

- `config.toml` hook entries are parsed into `config.hooks` (`src/config/loader.ts:98-110`).
- The CLI advertises `hooks list` and `hooks test` (`src/cli/hook-commands.ts:35-106`).
- `HookRunner` supports `beforeToolExecute`, `afterToolExecute`, and `onTaskEnd` (`src/hooks/hook-runner.ts:89-132`).
- `Orchestrator` only invokes `runOnTaskStart()` and `runOnTaskEnd()` (`src/orchestrator/orchestrator.ts:486`, `src/orchestrator/orchestrator.ts:896-910`).
- A repo-wide search found no production call site that registers config-defined hooks into `_hookRunner`.

Contrarian point:

- The hook system currently behaves like a partially mocked feature: config schema, CLI, types, and runner exist, but the runtime never loads the configured hooks.

Recommendation:

- Add a boot-time hook loader that maps `config.hooks` to actual handlers.
- If shell-script hooks are not ready, stop advertising them in CLI/docs.

### 8. TLCI code tools create a weaker parallel execution plane

Severity: High if exposed later, Medium in current repo state

Why it matters:

- `submitWorkflow()` exists, but I found no current CLI/dashboard call path into it. This is latent risk, not a confirmed current exploit surface.
- TLCI Tier 1 dispatch executes `runCodeToolStep()` directly (`src/orchestrator/orchestrator.ts:973-990`).
- `CodeToolRunner` is outside the main SDK permission path and can do HTTP fetch/post, file reads/writes, local directory listing, arithmetic execution, and stubbed DB access (`src/orchestrator/code-tool-runner.ts:1-16`, `src/orchestrator/code-tool-runner.ts:187-244`, `src/orchestrator/code-tool-runner.ts:274-287`).
- `runFileOp()` does not consult `PolicyEngine`; it only compares `path.normalize()` to the raw string and then reads/writes directly (`src/orchestrator/code-tool-runner.ts:187-229`).
- `runHttpFetch()` / `runHttpPost()` do not consult the declared network policy; they only block obvious local/private hosts (`src/orchestrator/code-tool-runner.ts:25-48`, `src/orchestrator/code-tool-runner.ts:62-107`).
- `runCompute()` still uses `new Function(...)` despite the comment claiming "safe arithmetic only" (`src/orchestrator/code-tool-runner.ts:13`, `src/orchestrator/code-tool-runner.ts:236-244`).

Contrarian point:

- TLCI is architecturally framed as a cost optimization layer. In practice it also reintroduces a second, weaker policy surface.

Recommendation:

- Route Tier 1 file/network actions through the same policy engine and audit pipeline as SDK tools.
- Do not expose `submitWorkflow()` until that convergence is done.

### 9. The dashboard security panel can fabricate policy data

Severity: Medium

Why it matters:

- The frontend requests `/api/policy` (`src/dashboard/frontend/src/components/SecuritySettings.tsx:41`).
- When that fails, it renders hardcoded fallback policy data, including broad access like `~/Documents` and `~/Desktop` (`src/dashboard/frontend/src/components/SecuritySettings.tsx:45-54`).
- I found no `/api/policy` route in `DashboardServer`.

Contrarian point:

- A security panel that silently invents policy state erodes operator trust fast.

Recommendation:

- Add a real `/api/policy` endpoint backed by `PolicyEngine`.
- Remove the fabricated fallback entirely; error loudly instead.

### 10. Several security modules are implemented but inert in production

Severity: Medium

Included here:

- `SecretsManager` is implemented (`src/security/secrets-manager.ts:1-70`), but repo-wide search found only its definition and unit tests, no production instantiation.
- `IntegrityGuardian` is implemented (`src/security/integrity-guardian.ts:1-90`), but repo-wide search found no production boot wiring.
- `PolicyEngine.setAuditLogger()` exists (`src/security/policy-engine.ts:116-121`) but is not used in orchestrator boot (`src/orchestrator/orchestrator.ts:162-179`).

Contrarian point:

- Unused security code is not neutral. It inflates confidence, increases maintenance cost, and lets documentation drift away from reality.

Recommendation:

- Either wire these modules into the boot path with tests or remove/de-document them until they are real.

## Stub Inventory (excluding `ingest_cybergraph`)

- `request_permissions` custom tool returns a pending envelope but performs no approval or policy expansion (`src/orchestrator/orchestrator.ts:1203-1239`).
- TLCI `dbQuery` is explicitly stubbed and returns `{ rows: [], stub: true }` unless a caller injects `context.execute` (`src/orchestrator/code-tool-runner.ts:274-287`).
- The hook feature is effectively stubbed at the system level: config and CLI exist, but there is no production registration path.
- Dashboard `/api/policy` is absent while the UI pretends it exists and falls back to fabricated data (`src/dashboard/frontend/src/components/SecuritySettings.tsx:41-54`).

## Tech Debt Themes

- Security promises are distributed across README, SECURITY.md, ADRs, and code, but there is no single "runtime truth" test proving the protections are actually active.
- The repo has at least two execution planes: main SDK tools and TLCI code tools. They do not share the same enforcement model.
- Feature surfaces arrive before operational completion: hooks, permission requests, dashboard policy display, and parts of TLCI.
- There is a recurring pattern of "implemented primitive, missing integration." That is the main debt shape in this repo.

## Recommended Order of Operations

1. Close the dashboard exposure gap.
2. Enforce network policy for `WebSearch`/`WebFetch` and disable them by default until that exists.
3. Wire runtime audit logging, then fix audit redaction before shipping the stronger claims.
4. Remove or finish `request_permissions`.
5. Either finish hook loading/execution or hide the feature.
6. Converge TLCI Tier 1 actions onto `PolicyEngine` and the audit path before exposing `submitWorkflow()`.
7. Stop claiming active protections in docs until runtime wiring and tests prove them.

## Bottom Line

The repo is not devoid of security engineering; it has real security engineering stranded in incomplete integration layers. The contrarian risk is therefore not "there are no defenses." It is "the codebase already contains enough defenses to make the docs sound true, while the runtime still behaves as if several of those defenses were optional or not yet finished."
