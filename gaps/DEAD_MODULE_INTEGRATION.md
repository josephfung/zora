# Dead Module Integration Spec
## Why These Modules Exist But Aren't Running

Six modules were built to spec, passed tests, and were then left unconnected to the runtime path.
This document defines the exact wiring required for each one — what file, what function, what line.

---

## The Pattern That Keeps Killing Features

Every orphan follows the same death cycle:

1. Module written, tested in isolation → passes review
2. Module re-exported from a barrel (`security/index.ts`, `skills/index.ts`)
3. The barrel is never imported by anything in the runtime path
4. Module is "done" but not "wired" — distinction never tracked

**Fix going forward:** A module is not DONE until its integration point has a live import and the
boot sequence exercises it. The tracker must reflect this. Items below should have been marked
`in-progress` until the wiring PR landed.

---

## Module 1: `src/security/capability-tokens.ts`
**Priority: P1 — Worker isolation is broken without this**

### What it does
Creates `WorkerCapabilityToken` objects scoped from policy (allowed paths, commands, tools, expiry).
`enforceCapability()` checks a proposed action against the token before allowing it.

### Why it's dead
`createCapabilityToken()` and `enforceCapability()` are never called. The `WorkerCapabilityToken`
type flows through `types.ts` and the orchestrator references it, but no token is ever created per job
and no enforcement gate exists.

### Where to wire it

**File: `src/orchestrator/orchestrator.ts`**

**Step 1 — Add import** (alongside existing security imports at line ~58):
```ts
import { createCapabilityToken, enforceCapability } from '../security/capability-tokens.js';
```

**Step 2 — Add instance field** (alongside `_intentCapsuleManager`, `_leakDetector` ~line 108):
```ts
// Per-job capability tokens (keyed by jobId)
private _activeTokens = new Map<string, WorkerCapabilityToken>();
```

**Step 3 — Create token at task start, in `submitTask()` after `jobId` is assigned** (~line 396):
```ts
const capToken = createCapabilityToken(jobId, this._policy);
this._activeTokens.set(jobId, capToken);
```

**Step 4 — Enforce in `canUseTool` closure built in `submitTask()`** (at `_policyEngine.createCanUseTool()` call ~line 516):
```ts
// Replace the raw policy canUseTool with a token-aware wrapper
const policyCanUseTool = this._policyEngine.createCanUseTool();
const canUseTool: CanUseTool = (tool, input) => {
  const token = this._activeTokens.get(jobId);
  if (token) {
    // Check path actions
    const pathArg = (input as Record<string, unknown>)['path'] as string | undefined;
    if (pathArg) {
      const result = enforceCapability(token, { type: 'path', target: pathArg });
      if (!result.allowed) return false;
    }
    // Check command actions
    const cmdArg = (input as Record<string, unknown>)['command'] as string | undefined;
    if (cmdArg) {
      const result = enforceCapability(token, { type: 'command', target: cmdArg });
      if (!result.allowed) return false;
    }
  }
  // Fall through to policy engine for remaining checks
  return policyCanUseTool(tool, input);
};
```

**Step 5 — Clean up token on task completion** (in `submitTask()` finally block or after execution):
```ts
this._activeTokens.delete(jobId);
```

**Tests to add:** `tests/security/capability-tokens.integration.test.ts`
- Verify token blocks path outside allowed_paths
- Verify token expires after 30m
- Verify policy canUseTool still runs after token allows

---

## Module 2: `src/security/integrity-guardian.ts`
**Priority: P2 — Silent tampering of SOUL.md / policy.toml goes undetected**

### What it does
Computes SHA-256 baselines for `SOUL.md`, `MEMORY.md`, `policy.toml`, `config.toml` and a
combined hash of the tool registry. Detects tampering on subsequent boots.

### Why it's dead
`IntegrityGuardian` is re-exported from `security/index.ts` which has zero importers in the
runtime path. Note: `MemoryManager` has its OWN inline integrity check only on `MEMORY.md`
(see `_saveIntegrityHash()` / `INTEGRITY_FILENAME`). `IntegrityGuardian` covers the broader
set including policy and config files — these have no integrity checking at all today.

### Where to wire it

**File: `src/orchestrator/orchestrator.ts`**

**Step 1 — Add import**:
```ts
import { IntegrityGuardian } from '../security/integrity-guardian.js';
```

**Step 2 — Add field**:
```ts
private _integrityGuardian!: IntegrityGuardian;
```

**Step 3 — Initialize in `boot()` after `_policyEngine` is set up** (~line 188):
```ts
this._integrityGuardian = new IntegrityGuardian(this._baseDir);

// First boot: save baseline. Subsequent boots: check integrity.
const integrityBaselinesPath = path.join(this._baseDir, 'state/integrity-baselines.json');
const baselinesExist = await fs.promises.access(integrityBaselinesPath).then(() => true).catch(() => false);

if (!baselinesExist) {
  await this._integrityGuardian.saveBaseline();
  log.info('Integrity baselines established');
} else {
  const result = await this._integrityGuardian.checkIntegrity();
  if (!result.valid) {
    for (const mismatch of result.mismatches) {
      log.warn({ file: mismatch.file }, 'Integrity mismatch detected — file may have been tampered with');
    }
    // Non-fatal: warn but continue. Escalate to notifications if severity warrants.
    this._notifications.sendAlert?.('integrity_warning', result.mismatches);
  }
}
```

**Step 4 — Re-baseline after intentional config updates** (expose a method):
```ts
async rebaselineIntegrity(): Promise<void> {
  this._assertBooted();
  await this._integrityGuardian.saveBaseline();
  log.info('Integrity baselines updated');
}
```

**Step 5 — Wire into CLI** (`src/cli/doctor.ts` — already checks system health):
```ts
// In the doctor command, add integrity check output
const integrity = await orchestrator.integrityGuardian.checkIntegrity();
if (!integrity.valid) {
  console.warn('⚠ Integrity mismatches:', integrity.mismatches);
} else {
  console.log('✓ Config integrity: clean');
}
```

---

## Module 3: `src/security/secrets-manager.ts`
**Priority: P2 — No encrypted secrets storage; agents currently use plaintext env vars**

### What it does
AES-256-GCM encrypted secrets at `~/.zora/secrets.enc`. JIT decryption: decrypt → return →
dereference immediately. Master key from PBKDF2 (env var or future keytar integration).

### Why it's dead
Requires a master password that was never plumbed. No one initializes it.
`SecretRedactHook` (already wired) does output redaction — `SecretsManager` is the complement:
it's where those secrets are stored and retrieved safely.

### Where to wire it

**File: `src/orchestrator/orchestrator.ts`**

**Step 1 — Add import**:
```ts
import { SecretsManager } from '../security/secrets-manager.js';
```

**Step 2 — Add field**:
```ts
private _secretsManager?: SecretsManager;
```

**Step 3 — Initialize in `boot()` if master password is available**:
```ts
const masterPassword = process.env['ZORA_MASTER_PASSWORD'];
if (masterPassword) {
  this._secretsManager = new SecretsManager(this._baseDir, masterPassword);
  await this._secretsManager.init();
  log.info('SecretsManager initialized');
} else {
  log.warn('ZORA_MASTER_PASSWORD not set — encrypted secrets storage unavailable');
}
```

**Step 4 — Expose via public getter**:
```ts
get secretsManager(): SecretsManager | undefined {
  return this._secretsManager;
}
```

**Step 5 — Wire secret names into `SecretRedactHook`** (so stored secrets are auto-redacted in output):
In `boot()`, after SecretsManager init:
```ts
if (this._secretsManager) {
  const names = await this._secretsManager.listSecretNames();
  for (const name of names) {
    const value = await this._secretsManager.getSecret(name);
    if (value) SecretRedactHook.addPattern(value);
  }
}
```

**Step 6 — Wire CLI commands** (`src/cli/` — new file `secret-commands.ts`):
```
zora secret set <name> <value>
zora secret get <name>
zora secret list
zora secret delete <name>
```

**Note on master password:** Until keytar is integrated, document that `ZORA_MASTER_PASSWORD`
must be set in the user's shell profile. Add to `zora doctor` output if unset.

---

## Module 4: `src/memory/reflector-worker.ts`
**Priority: P2 — Session-tier memory overflow drops observations instead of persisting them**

### What it does
When session-tier observations exceed their token budget:
1. Calls LLM to extract persistent facts from observations
2. Writes facts to StructuredMemory as typed MemoryItems
3. Condenses remaining observations to cross-session tier

Also runs on daily note consolidation to extract structured knowledge before archiving.

### Why it's dead
`ReflectorWorker` is never instantiated. `ContextCompressor` explicitly logs "Reflector integration
is handled by the orchestrator (OM-05/OM-07)" at line 296 — but the orchestrator never implements it.
`consolidateDailyNotes()` accepts an optional `reflectFn` but is always called without one.

### Where to wire it

**File: `src/orchestrator/orchestrator.ts`**

**Step 1 — Add import**:
```ts
import { ReflectorWorker } from '../memory/reflector-worker.js';
```

**Step 2 — Add field**:
```ts
private _reflectorWorker?: ReflectorWorker;
```

**Step 3 — Initialize in `boot()` AFTER the `compressFn` is defined** (~line 425, inside the
`if (this._config.memory?.compression?.enabled)` block):
```ts
// The compressFn already exists here — use the same one for reflection
this._reflectorWorker = new ReflectorWorker(compressFn, this._memoryManager);
log.info('ReflectorWorker initialized');
```

**Problem:** `compressFn` is currently defined locally inside `submitTask()`, not in `boot()`.
It needs to be extracted to a private method or a boot-time field so it can be reused.

**Refactor needed — extract `_buildCompressFn()`:**
```ts
private _buildCompressFn(): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const compressLoop = new ExecutionLoop({
      systemPrompt: 'You are a conversation observer. Compress messages into concise, dated observations. Respond with ONLY the observations.',
      permissionMode: 'default',
      cwd: process.cwd(),
    });
    const events: AgentEvent[] = [];
    for await (const event of compressLoop.run({ prompt, maxTurns: 3 })) {
      events.push(event);
    }
    const done = events.findLast(e => e.type === 'done') as DoneEventContent | undefined;
    return done?.result ?? '';
  };
}
```

Then in `boot()`:
```ts
if (this._config.memory?.compression?.enabled) {
  const compressFn = this._buildCompressFn();
  this._reflectorWorker = new ReflectorWorker(compressFn, this._memoryManager);
  // ... existing ContextCompressor setup uses compressFn too
}
```

**Step 4 — Pass reflectFn to `consolidateDailyNotes()`** (currently called without it at lines ~311, 325):
```ts
// Replace bare call:
// await this._memoryManager.consolidateDailyNotes(7);

// With reflection-aware call:
const reflectFn = this._reflectorWorker
  ? async (content: string) => {
      await this._reflectorWorker!.reflect(content, `consolidation_${Date.now()}`);
    }
  : undefined;
await this._memoryManager.consolidateDailyNotes(7, reflectFn);
```

**Step 5 — Handle session-tier overflow signal from ContextCompressor:**
The comment at `context-compressor.ts:296` says "Reflector integration is handled by orchestrator."
Add a callback to `ContextCompressor` constructor options:
```ts
// In ContextCompressor options (context-compressor.ts):
onSessionTierFull?: (observations: string, sessionId: string) => Promise<void>;

// In Orchestrator.submitTask() when building the compressor:
compressor = new ContextCompressor(
  this._config.memory.compression,
  this._observationStore,
  compressFn,
  jobId,
  this._reflectorWorker
    ? async (obs, sid) => { await this._reflectorWorker!.reflectAndPersist(obs, sid, this._observationStore); }
    : undefined,
);
```

---

## Module 5: `src/skills/subagent-loader.ts`
**Priority: P3 — Subagent delegation is a documented feature that doesn't work**

### What it does
Scans `.zora/subagents/<name>/SUBAGENT.md` at project and global layers. Each SUBAGENT.md
defines `description`, `allowed_tools`, and a `system_prompt`. Prevents nesting by stripping
`delegate_to_subagent` from `allowedTools`.

### Why it's dead
`loadSubagents()` is exported from `skills/index.ts` but never called by any tool, CLI command,
or orchestrator path. There is no `delegate_to_subagent` tool that would call it.

### Where to wire it

**File: `src/tools/subagent-tool.ts` (new file)**

Create a `createSubagentTool()` function that returns a `CustomToolDefinition`:
```ts
import { loadSubagents } from '../skills/subagent-loader.js';
import type { CustomToolDefinition } from '../orchestrator/execution-loop.js';

export function createSubagentTool(
  submitTask: (opts: { prompt: string; systemPrompt?: string }) => Promise<string>,
  policyEngine: PolicyEngine,
): CustomToolDefinition {
  return {
    name: 'delegate_to_subagent',
    description: 'Delegate a self-contained task to a named subagent. The subagent runs with its declared tool subset and cannot spawn further subagents.',
    input_schema: {
      type: 'object',
      properties: {
        subagent_name: { type: 'string', description: 'Name of the subagent (from .zora/subagents/<name>/)' },
        task: { type: 'string', description: 'The task to delegate' },
      },
      required: ['subagent_name', 'task'],
    },
    handler: async (input) => {
      const name = input['subagent_name'] as string;
      const task = input['task'] as string;

      const subagents = await loadSubagents();
      const subagent = subagents.find(s => s.name === name);
      if (!subagent) {
        return { error: `Subagent '${name}' not found. Available: ${subagents.map(s => s.name).join(', ')}` };
      }

      // Run with subagent's system prompt and restricted tool set
      const result = await submitTask({
        prompt: task,
        systemPrompt: subagent.systemPrompt,
        // allowedTools would be enforced via capability token
      });
      return { result };
    },
  };
}
```

**File: `src/orchestrator/orchestrator.ts` — wire into `_createCustomTools()`**:
```ts
import { createSubagentTool } from '../tools/subagent-tool.js';

// In _createCustomTools():
const subagentTool = createSubagentTool(
  (opts) => this.submitTask({ prompt: opts.prompt }),
  this._policyEngine,
);
return [...permissionTools, ...memoryTools, recallContextTool, ...skillTools, planWorkflowTool, subagentTool];
```

**Wire into CLI** (`src/cli/skill-commands.ts` — add subagent subcommand):
```
zora subagent list              # lists loaded subagents
zora subagent info <name>       # shows description, allowed tools, system prompt
```

---

## Execution Order

These integrations have dependencies between them. Wire in this order:

```
1. capability-tokens   ← no deps, standalone enforcement gate
2. integrity-guardian  ← no deps, boot-time check
3. secrets-manager     ← no deps, requires env var plumbing
4. reflector-worker    ← depends on compressFn refactor (extract _buildCompressFn)
5. subagent-loader     ← depends on capability-tokens (token scoping per subagent)
```

---

## Tracker Entries to Add

Add these as new gap entries in `gaps/wsjf-scores.json`:

| ID | Title | WSJF | Status |
|----|-------|------|--------|
| SEC-10 | Wire capability-tokens enforcement into submitTask | 18 | open |
| SEC-11 | Wire IntegrityGuardian into boot sequence | 12 | open |
| SEC-12 | Initialize SecretsManager + CLI commands | 10 | open |
| MEM-20 | Wire ReflectorWorker into consolidation + session overflow | 15 | open |
| SKILL-02 | Wire subagent-loader into delegate_to_subagent tool | 8 | open |

---

## What "Done" Means For Each

| Module | Definition of Done |
|--------|-------------------|
| capability-tokens | `enforceCapability()` called in the `canUseTool` closure of every `submitTask()` call; integration test proves denied path is blocked |
| integrity-guardian | `checkIntegrity()` called in `boot()`; `zora doctor` shows integrity status; mismatch produces a log warn |
| secrets-manager | `zora secret set/get/list/delete` works; stored secrets appear in SecretRedactHook scan list on boot |
| reflector-worker | `consolidateDailyNotes()` called with `reflectFn`; session-tier overflow triggers `reflectAndPersist()`; MemoryItems appear in structured memory after consolidation |
| subagent-loader | `delegate_to_subagent` tool appears in `zora tools list`; calling it with a valid SUBAGENT.md name executes the task with the subagent's system prompt |
