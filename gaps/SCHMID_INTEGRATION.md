# Schmid ia-agents Integration — Detail Specs

> Source: [github.com/philschmid/ia-agents](https://github.com/philschmid/ia-agents)
> Analysis: `gaps/SCHMID_IA_AGENTS_IDEAS.md`
> Date: 2026-02-16

---

## ORCH-12: Lifecycle Hook System

**WSJF: 4.0 | Effort: 2-3 days | Blocks: ORCH-13, ORCH-16**

### Problem

Zora's `ExecutionLoop` accepts `hooks?: Partial<Record<string, SdkHookMatcher[]>>` but nothing wires it. Users and subsystems have no mechanism to register lifecycle hooks.

### Implementation

Create `src/hooks/hook-types.ts`:

```typescript
export interface HookContext {
  jobId: string;
  task: string;
  provider?: string;
  turn?: number;
}

export interface BeforeToolResult {
  allow: boolean;
  args?: Record<string, unknown>;
  reason?: string;
}

export interface ZoraHooks {
  onTaskStart: (ctx: HookContext) => Promise<HookContext>;
  beforeToolExecute: (ctx: HookContext, tool: string, args: Record<string, unknown>) => Promise<BeforeToolResult>;
  afterToolExecute: (ctx: HookContext, tool: string, result: unknown) => Promise<unknown>;
  onTaskEnd: (ctx: HookContext, result: string) => Promise<string | null>;
}

export type HookEvent = keyof ZoraHooks;

export interface HookRegistration {
  event: HookEvent;
  match?: string;           // glob pattern for tool name filtering
  handler: ZoraHooks[HookEvent];
  priority?: number;        // lower = earlier, default 100
}

export interface HookConfigEntry {
  event: HookEvent;
  match?: string;
  script: string;           // path to shell script for non-TS users
}
```

Create `src/hooks/hook-runner.ts` (~150 lines):

```typescript
import type { HookRegistration, HookEvent, HookContext, BeforeToolResult } from './hook-types.js';

export class HookRunner {
  private hooks: Map<HookEvent, HookRegistration[]> = new Map();

  register(reg: HookRegistration): void {
    const list = this.hooks.get(reg.event) ?? [];
    list.push(reg);
    list.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    this.hooks.set(reg.event, list);
  }

  async runOnTaskStart(ctx: HookContext): Promise<HookContext> { /* chain handlers */ }
  async runBeforeToolExecute(ctx: HookContext, tool: string, args: Record<string, unknown>): Promise<BeforeToolResult> { /* short-circuit on allow:false */ }
  async runAfterToolExecute(ctx: HookContext, tool: string, result: unknown): Promise<unknown> { /* chain handlers */ }
  async runOnTaskEnd(ctx: HookContext, result: string): Promise<string | null> { /* null = no re-injection */ }
}
```

### Wiring Points

1. **Orchestrator.submitTask()** (~line 315): Call `hookRunner.runOnTaskStart()` before routing
2. **Orchestrator._executeWithProvider()** (~line 418): Map `beforeToolExecute`/`afterToolExecute` into SDK's `hooks` option on `ZoraExecutionOptions`
3. **After result return** (~line 572): Call `hookRunner.runOnTaskEnd()`, if non-null re-submit
4. **Config loading**: Parse `[[hooks]]` sections from config.toml into `HookConfigEntry[]`, create shell-based handlers

### Config Surface (config.toml)

```toml
[[hooks]]
event = "beforeToolExecute"
match = "Bash"
script = "~/.zora/hooks/validate-bash.sh"

[[hooks]]
event = "onTaskEnd"
script = "~/.zora/hooks/extract-memories.sh"
```

### Tests

- Unit: HookRunner registration order, priority sorting, short-circuit on `allow: false`
- Unit: Shell script handler invocation (mock child_process)
- Integration: Hook fires during `Orchestrator.submitTask()` with mock provider
- Benchmark: Hook overhead < 50ms per invocation chain

### Files to Create/Modify

- **Create**: `src/hooks/hook-types.ts`, `src/hooks/hook-runner.ts`, `src/hooks/index.ts`
- **Modify**: `src/orchestrator/orchestrator.ts` (wire hooks), `src/config/loader.ts` (parse [[hooks]])

---

## ORCH-13: Hook CLI Commands (list/test)

**WSJF: 5.0 | Effort: 0.5 day | Depends: ORCH-12**

### Problem

After ORCH-12, users need introspection into registered hooks.

### Implementation

Add to `src/cli/daemon.ts` (or a new `src/cli/hooks.ts`):

```
zora hooks list          → table of registered hooks (event, match, script/handler)
zora hooks test <event>  → dry-run a hook event with sample data, show output
```

### Tests

- CLI output format test (list shows table)
- Test command with mock hook that returns modified args

### Files to Modify

- `src/cli/daemon.ts` — add `hooks` subcommand routing

---

## ORCH-14: transformContext Callback for History Pruning

**WSJF: 5.67 | Effort: 1 day | Independent**

### Problem

`TaskContext.history` grows unboundedly during execution. Long tasks bloat the context window. No mechanism to trim history mid-execution.

### Implementation

Add to `ZoraExecutionOptions` in `src/orchestrator/execution-loop.ts`:

```typescript
export interface ZoraExecutionOptions {
  // ... existing fields ...
  transformContext?: (history: AgentEvent[], turn: number) => AgentEvent[];
}
```

Default implementation in a helper:

```typescript
export function defaultTransformContext(history: AgentEvent[], turn: number): AgentEvent[] {
  const MAX_EVENTS = 50;
  if (history.length <= MAX_EVENTS) return history;

  return history.filter((event, idx) => {
    const age = history.length - idx;
    // Always keep last 20 events
    if (age <= 20) return true;
    // Drop thinking events older than 10
    if (event.type === 'thinking' && age > 10) return false;
    // Keep text and done events
    if (event.type === 'text' || event.type === 'done') return true;
    // Summarize old tool results (replace content with truncated version)
    if (event.type === 'tool_result' && age > 30) {
      event.content = { toolCallId: (event.content as any).toolCallId, result: '[pruned]' };
    }
    return age <= MAX_EVENTS;
  });
}
```

### Wiring

In `ExecutionLoop.execute()`, before each SDK turn, call `transformContext` on the accumulated history. Wire via SDK's `onInteractionStart` hook or by filtering history before passing to the next SDK call.

### Tests

- Unit: `defaultTransformContext` prunes correctly at various history sizes
- Unit: Custom callback is invoked with correct turn number
- Integration: Long session doesn't OOM (history stays bounded)

### Files to Modify

- `src/orchestrator/execution-loop.ts` — add option + wire callback
- `src/types.ts` — (optional) export `TransformContextFn` type

---

## ORCH-15: Zod-Based Tool Factory

**WSJF: 5.0 | Effort: 0.5 day | Independent**

### Problem

`CustomToolDefinition.input_schema` is `Record<string, unknown>`. Schema errors caught at LLM call time instead of registration time.

### Implementation

Create `src/tools/tool-factory.ts` (~40 lines):

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { CustomToolDefinition } from '../orchestrator/execution-loop.js';

export function tool<T extends z.ZodType>(
  name: string,
  description: string,
  schema: T,
  handler: (input: z.infer<T>) => Promise<unknown>,
): CustomToolDefinition {
  const jsonSchema = zodToJsonSchema(schema, { target: 'openApi3' });
  return {
    name,
    description,
    input_schema: jsonSchema as Record<string, unknown>,
    handler: async (raw: Record<string, unknown>) => {
      const parsed = schema.parse(raw);  // Throws ZodError at registration time
      return handler(parsed);
    },
  };
}
```

### Dependencies

Add `zod` and `zod-to-json-schema` to package.json (zod may already be present).

### Tests

- Unit: `tool()` produces valid JSON schema from Zod schema
- Unit: Handler receives parsed/validated input
- Unit: Invalid input throws ZodError (not silent fail)

### Files to Create/Modify

- **Create**: `src/tools/tool-factory.ts`, `src/tools/index.ts`
- **Modify**: `package.json` (add zod deps if missing)

---

## ORCH-16: maxInjectionLoops Guard

**WSJF: 11.0 | Effort: 0.5 day | Depends: ORCH-12**

### Problem

`onTaskEnd` hook (ORCH-12) can return a follow-up string to re-inject into the loop. Without a guard, this creates infinite loops.

### Implementation

Add ~15 lines to `Orchestrator.submitTask()`:

```typescript
const MAX_INJECTION_LOOPS = 3;
let injectionCount = 0;

// After calling hookRunner.runOnTaskEnd():
const followUp = await this.hookRunner.runOnTaskEnd(hookCtx, result);
if (followUp && injectionCount < MAX_INJECTION_LOOPS) {
  injectionCount++;
  // Re-submit with followUp as the new task
  return this.submitTask({ ...options, task: followUp });
}
if (followUp && injectionCount >= MAX_INJECTION_LOOPS) {
  log.warn(`maxInjectionLoops (${MAX_INJECTION_LOOPS}) reached, dropping follow-up`);
}
```

### Config

Make `MAX_INJECTION_LOOPS` configurable via `agent.max_injection_loops` in config.toml (default: 3).

### Tests

- Unit: Loop terminates at 3 re-injections
- Unit: Counter resets between independent tasks
- Unit: Warning logged when cap hit

### Files to Modify

- `src/orchestrator/orchestrator.ts` — add counter + guard in submitTask

---

## TYPE-09: Three-Layer Skill Precedence

**WSJF: 5.0 | Effort: 1 day | Blocks: TYPE-10**

### Problem

`SkillLoader` scans `~/.claude/skills/` only — single layer. No project-level skills, no built-in defaults.

### Implementation

Modify `src/skills/skill-loader.ts`:

```typescript
import os from 'node:os';
import path from 'node:path';

const SKILL_LAYERS = [
  path.join(process.cwd(), '.zora', 'skills'),     // Project-level (highest priority)
  path.join(os.homedir(), '.zora', 'skills'),       // User-global
  path.join(__dirname, '..', 'skills'),             // Built-in (lowest priority)
];

export async function loadSkillsLayered(): Promise<SkillInfo[]> {
  const seen = new Set<string>();
  const skills: SkillInfo[] = [];

  for (const layer of SKILL_LAYERS) {
    const layerSkills = await loadSkills(layer);
    for (const skill of layerSkills) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        skills.push({ ...skill, layer }); // Add layer source info
      }
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
```

Extend `SkillInfo`:

```typescript
export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  layer?: string;  // which precedence layer this came from
}
```

### Tests

- Unit: Project skill overrides global skill of same name
- Unit: Built-in skill appears when no project/global override exists
- Unit: Missing directories are silently skipped

### Files to Modify

- `src/skills/skill-loader.ts` — add `loadSkillsLayered()`, extend `SkillInfo`

---

## TYPE-10: Subagent Definition Loading + Isolation

**WSJF: 3.75 | Effort: 1.5 days | Depends: TYPE-09**

### Problem

No subagent definitions. No way to declare tool-restricted agent personas.

### Implementation

Subagent definitions live in `.zora/subagents/<name>/AGENT.md` with YAML frontmatter:

```yaml
---
name: code-reviewer
description: Reviews code for quality issues
allowed_tools:
  - Read
  - Grep
  - Glob
max_turns: 10
---

You are a code reviewer. Review the provided code...
```

Create `src/skills/subagent-loader.ts`:

```typescript
export interface SubagentDefinition {
  name: string;
  description: string;
  allowedTools: string[];
  maxTurns: number;
  systemPrompt: string;
  path: string;
}

const SUBAGENT_LAYERS = [
  path.join(process.cwd(), '.zora', 'subagents'),
  path.join(os.homedir(), '.zora', 'subagents'),
];

export async function loadSubagents(): Promise<SubagentDefinition[]> { /* scan layers */ }
```

Wire into `ExecutionLoop`:

- Subagent gets its own `ExecutionLoop` instance
- `allowedTools` restricts which tools the SDK exposes
- Cannot spawn nested subagents (strip `delegate_to_subagent` from allowed tools)
- No access to parent conversation history

### Tests

- Unit: Frontmatter parsing extracts allowed_tools
- Unit: Two-layer precedence (project overrides global)
- Unit: Nested subagent spawning is blocked
- Integration: Subagent execution with restricted tools

### Files to Create/Modify

- **Create**: `src/skills/subagent-loader.ts`
- **Modify**: `src/orchestrator/execution-loop.ts` (add subagent spawning method)
- **Modify**: `src/skills/index.ts` (re-export)

---

## TYPE-11: Lifecycle Event Pairs (start/end) + Deltas

**WSJF: 2.75 | Effort: 1 day | Blocks: TYPE-12**

### Problem

Zora has 7 event types but no start/end pairs, no delta events, no per-turn usage tracking.

### Implementation

Extend `AgentEventType` in `src/types.ts`:

```typescript
export type AgentEventType =
  // Existing
  | 'thinking' | 'tool_call' | 'tool_result' | 'text' | 'error' | 'done' | 'steering'
  // New: lifecycle markers
  | 'task.start' | 'task.end'
  | 'turn.start' | 'turn.end'
  | 'text.delta'
  | 'tool.start' | 'tool.end';
```

Add new content interfaces:

```typescript
export interface TaskStartContent {
  jobId: string;
  task: string;
  provider: string;
}

export interface TaskEndContent {
  jobId: string;
  duration_ms: number;
  total_turns: number;
  total_cost_usd: number;
}

export interface TurnStartContent {
  turn: number;
  provider: string;
}

export interface TurnEndContent {
  turn: number;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
}

export interface TextDeltaContent {
  delta: string;
  accumulated: string;
}

export interface ToolStartContent {
  toolCallId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ToolEndContent {
  toolCallId: string;
  tool: string;
  duration_ms: number;
  success: boolean;
}
```

Add type guards for new event types.

### Mapping in ClaudeProvider

In `src/providers/claude-provider.ts`, map SDK messages to new event types:

- Before SDK call: emit `turn.start`
- On SDK `content_block_start`: emit `tool.start` for tool_use blocks
- On SDK `content_block_delta`: emit `text.delta` for text blocks
- On SDK `content_block_stop`: emit `tool.end` for tool_use blocks
- After SDK call: emit `turn.end` with usage from response

### Tests

- Unit: All new event types have type guards
- Unit: TurnEndContent carries usage stats
- Integration: Full task emits matched start/end pairs

### Files to Modify

- `src/types.ts` — add event types + content interfaces + type guards
- `src/providers/claude-provider.ts` — emit new events in `_mapSDKMessage()`
- `src/orchestrator/orchestrator.ts` — emit `task.start`/`task.end` in `submitTask()`

---

## TYPE-12: Verbosity Filtering (terse/normal/verbose)

**WSJF: 3.0 | Effort: 0.5 day | Depends: TYPE-11**

### Problem

All event types are emitted to all consumers. CLI/dashboard/Telegram get overwhelming output.

### Implementation

Create `src/utils/event-filter.ts`:

```typescript
import type { AgentEvent, AgentEventType } from '../types.js';

export type VerbosityLevel = 'terse' | 'normal' | 'verbose';

const TERSE_TYPES: Set<AgentEventType> = new Set(['text', 'done', 'error']);
const NORMAL_TYPES: Set<AgentEventType> = new Set([
  ...TERSE_TYPES, 'tool_call', 'tool_result', 'task.start', 'task.end',
]);
// verbose = everything

export function filterEvents(
  events: AsyncIterable<AgentEvent>,
  level: VerbosityLevel,
): AsyncIterable<AgentEvent> {
  if (level === 'verbose') return events;

  const allowedTypes = level === 'terse' ? TERSE_TYPES : NORMAL_TYPES;

  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of events) {
        if (allowedTypes.has(event.type)) yield event;
      }
    },
  };
}
```

### Wiring

- Dashboard SSE: Apply `filterEvents()` before sending to client (default: `normal`)
- CLI output: Apply based on `--verbose` / `--terse` flags
- Config: `agent.verbosity = "normal"` in config.toml

### Tests

- Unit: terse only passes text/done/error
- Unit: normal includes tool events
- Unit: verbose passes everything including deltas and thinking

### Files to Modify

- **Create**: `src/utils/event-filter.ts`
- **Modify**: `src/dashboard/server.ts` — apply filter to SSE stream
- **Modify**: `src/cli/daemon.ts` — add verbosity flag
