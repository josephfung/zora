# SPEC: Agent-Level Error Recovery

**Status:** Draft
**Author:** Implementation Agent
**Date:** 2026-02-22
**Gap IDs:** New (ERR-07 through ERR-12)

---

## 1. Problem Statement

Zora has infrastructure-level error recovery (provider failover, retry queues, circuit breakers) but lacks **agent-level error recovery** — the tight loop of *try → fail → read the error → fix → retry* that makes modern agents viable.

OpenClaw and other 2026-era frameworks treat errors as prompt context rather than chain-breakers. When an agent writes a script and the CSS selector fails, it reads the error, inspects the HTML again, rewrites the selector, and retries — all within the same execution. Zora partially supports this through the Claude Agent SDK's built-in tool loop, but has gaps at the orchestrator level that prevent full error recovery.

### What Works Today

| Layer | Mechanism | Status |
|-------|-----------|--------|
| **SDK inner loop** | Claude Agent SDK runs tool_use → execute → tool_result → next LLM turn | Working — errors within a single SDK session are visible to the LLM |
| **Provider failover** | FailoverController switches providers on rate limit/auth errors | Working — `orchestrator.ts:574-605` |
| **Retry queue** | Quadratic backoff retry for transient failures | Working — `retry-queue.ts` |
| **History preservation** | Full `taskContext.history` carried across failover/retry | Working — `orchestrator.ts:566, 592` |

### What's Missing

| Gap | Issue | Impact |
|-----|-------|--------|
| **ERR-07** | `_buildPrompt` doesn't surface the `error` field from `ToolResultEventContent` | Tool errors silently dropped on failover/restart |
| **ERR-08** | No error-aware re-prompting on session failure | Retry replays the same prompt that already failed |
| **ERR-09** | No configurable error budget per task | No cap on wasted compute from repeated failures |
| **ERR-10** | No error pattern detection within a session | Same error repeats N times without escalation |
| **ERR-11** | No partial-progress extraction on failure | Work done before failure is not summarized for the retry |
| **ERR-12** | No cross-session error learning | Same failure mode hits again on similar tasks |

---

## 2. Competitive Analysis: OpenClaw's Pattern

OpenClaw implements error recovery at two levels:

### Inner Loop (pi-agent-core SDK)
- Standard agentic tool loop — same as Claude Agent SDK
- Tool results (including stderr, non-zero exit codes) returned to LLM as structured content
- LLM sees the error and self-corrects within the same session
- **Zora equivalent: Already works via Claude Agent SDK**

### Outer Loop (pi-embedded-runner)
- Outer `while(true)` loop wraps individual LLM attempts (up to 160 iterations)
- On **context overflow**: compacts message history (up to 3 attempts), then truncates tool results
- On **auth/rate limit**: rotates to next auth profile automatically
- On **thinking-level issues**: falls back to simpler reasoning modes
- Tool errors from failed attempts are carried into the next attempt's context
- Max loop iterations prevent infinite recovery spirals
- Usage accumulated across retries for budget enforcement

**Key architectural insight**: OpenClaw's outer loop treats a failed LLM session not as a terminal event but as input to the next session. The error, the partial progress, and a modified strategy all feed into the retry prompt.

---

## 3. Specification

### ERR-07: Surface Tool Errors in History Replay

**Problem:** `ClaudeProvider._buildPrompt()` serializes `tool_result` events but only includes `event.content.result`, ignoring `event.content.error`. When a task fails over or restarts, the new provider sees tool results but not the error that caused the failure.

**Location:** `src/providers/claude-provider.ts:613-619`

**Current code:**
```typescript
} else if (isToolResultEvent(event)) {
  parts.push(`  <tool_result id="${event.content.toolCallId}">`);
  parts.push(JSON.stringify(event.content.result, null, 2));
  parts.push('  </tool_result>');
}
```

**Change:** Include the `error` field when present:
```typescript
} else if (isToolResultEvent(event)) {
  const content = event.content as ToolResultEventContent;
  if (content.error) {
    parts.push(`  <tool_result id="${content.toolCallId}" status="error">`);
    parts.push(`Error: ${content.error}`);
    if (content.result) {
      parts.push(`Output: ${JSON.stringify(content.result, null, 2)}`);
    }
    parts.push('  </tool_result>');
  } else {
    parts.push(`  <tool_result id="${content.toolCallId}">`);
    parts.push(JSON.stringify(content.result, null, 2));
    parts.push('  </tool_result>');
  }
}
```

Also include `error` events in history replay (currently absent):
```typescript
} else if (event.type === 'error') {
  const content = event.content as ErrorEventContent;
  parts.push('  <execution_error>');
  parts.push(`Error: ${content.message}`);
  if (content.subtype) parts.push(`Type: ${content.subtype}`);
  parts.push('  </execution_error>');
}
```

**Effort:** 30 minutes
**Files:** `src/providers/claude-provider.ts`
**Tests:** Verify `_buildPrompt` output includes error field; verify error events appear in history XML.

---

### ERR-08: Error-Aware Re-Prompting on Session Failure

**Problem:** When a task session ends with an error (`error_max_turns`, `error_during_execution`), the retry queue re-submits the task with the original prompt. The agent starts over without knowing what already failed or why.

**Location:** `src/orchestrator/orchestrator.ts:595-600` (retry enqueue), `src/orchestrator/retry-queue.ts` (retry execution)

**Design:**

Add an `ErrorRecoveryController` that sits between the orchestrator and the retry path. When a task fails, it:

1. **Analyzes the failure** — Categorizes based on the error event and execution history
2. **Extracts partial progress** — Summarizes what was accomplished before the failure
3. **Generates a recovery prompt** — Wraps the original task with error context and guidance
4. **Submits the modified task** — Either directly or through the retry queue

```typescript
// New file: src/orchestrator/error-recovery.ts

export interface RecoveryStrategy {
  /** Modified prompt with error context prepended */
  prompt: string;
  /** Whether to keep full history or summarize it */
  historyMode: 'full' | 'summarized' | 'truncated';
  /** Adjusted max turns for retry (may be higher if close to limit) */
  maxTurns?: number;
  /** Hints for the agent about what to try differently */
  guidance: string;
}

export interface ErrorRecoveryConfig {
  /** Enable error recovery (default: true) */
  enabled: boolean;
  /** Max recovery attempts per task before giving up (default: 3) */
  maxAttempts: number;
  /** Max percentage of original budget to spend on recovery (default: 50) */
  maxRecoveryBudgetPct: number;
  /** Whether to summarize history on retry to save context (default: true) */
  summarizeOnRetry: boolean;
}

export class ErrorRecoveryController {
  constructor(private config: ErrorRecoveryConfig) {}

  /**
   * Analyze a failed task and produce a recovery strategy.
   * Returns null if recovery is not possible or not advisable.
   */
  analyzeFailure(
    taskContext: TaskContext,
    error: ErrorEventContent,
    attemptNumber: number,
  ): RecoveryStrategy | null {
    // Don't recover if we've exceeded max attempts
    if (attemptNumber >= this.config.maxAttempts) return null;

    // Don't recover from permanent errors (auth, policy violations)
    if (error.isAuthError) return null;

    // Analyze the execution history for patterns
    const analysis = this._analyzeHistory(taskContext.history);

    // Build recovery guidance based on failure type
    const guidance = this._buildGuidance(error, analysis);

    // Build the recovery prompt
    const prompt = this._buildRecoveryPrompt(
      taskContext.task,
      error,
      analysis,
      guidance,
      attemptNumber,
    );

    return {
      prompt,
      historyMode: this._selectHistoryMode(analysis, attemptNumber),
      maxTurns: this._adjustMaxTurns(taskContext, error),
      guidance,
    };
  }

  private _analyzeHistory(history: AgentEvent[]): HistoryAnalysis {
    const toolCalls = history.filter(e => e.type === 'tool_call');
    const toolErrors = history.filter(e =>
      e.type === 'tool_result' &&
      (e.content as ToolResultEventContent).error
    );
    const textEvents = history.filter(e => e.type === 'text');

    // Detect repeated error patterns
    const errorMessages = toolErrors.map(e =>
      (e.content as ToolResultEventContent).error!
    );
    const repeatedErrors = this._findRepeatedPatterns(errorMessages);

    // Extract progress markers (text outputs that indicate completed steps)
    const progressMarkers = textEvents.map(e =>
      (e.content as TextEventContent).text
    );

    return {
      totalToolCalls: toolCalls.length,
      totalToolErrors: toolErrors.length,
      errorRate: toolCalls.length > 0
        ? toolErrors.length / toolCalls.length
        : 0,
      repeatedErrors,
      progressMarkers,
      lastToolError: toolErrors.length > 0
        ? (toolErrors[toolErrors.length - 1].content as ToolResultEventContent).error!
        : null,
      hitMaxTurns: history.some(e =>
        e.type === 'error' &&
        (e.content as ErrorEventContent).subtype === 'error_max_turns'
      ),
    };
  }

  private _buildGuidance(
    error: ErrorEventContent,
    analysis: HistoryAnalysis,
  ): string {
    const lines: string[] = [];

    // Max turns guidance
    if (analysis.hitMaxTurns) {
      lines.push(
        'Previous attempt ran out of turns. Be more direct — reduce exploratory steps, '
        + 'focus on the most promising approach, and avoid re-reading files you already examined.'
      );
    }

    // High error rate guidance
    if (analysis.errorRate > 0.5) {
      lines.push(
        `Previous attempt had a ${Math.round(analysis.errorRate * 100)}% tool error rate. `
        + 'Consider a fundamentally different approach rather than retrying the same strategy.'
      );
    }

    // Repeated error guidance
    if (analysis.repeatedErrors.length > 0) {
      for (const pattern of analysis.repeatedErrors) {
        lines.push(
          `The error "${pattern.message}" occurred ${pattern.count} times. `
          + 'Do not retry this same approach — try an alternative.'
        );
      }
    }

    // Execution error guidance
    if (error.subtype === 'error_during_execution') {
      lines.push(
        'The previous session ended with an execution error. '
        + 'Check assumptions and validate the environment before proceeding.'
      );
    }

    return lines.join('\n');
  }

  private _buildRecoveryPrompt(
    originalTask: string,
    error: ErrorEventContent,
    analysis: HistoryAnalysis,
    guidance: string,
    attemptNumber: number,
  ): string {
    const parts: string[] = [];

    parts.push('<error_recovery>');
    parts.push(`This is recovery attempt ${attemptNumber + 1} of ${this.config.maxAttempts}.`);
    parts.push('');
    parts.push('<previous_failure>');
    parts.push(`Error: ${error.message}`);
    if (error.subtype) parts.push(`Type: ${error.subtype}`);
    parts.push(`Tool calls attempted: ${analysis.totalToolCalls}`);
    parts.push(`Tool errors encountered: ${analysis.totalToolErrors}`);
    if (analysis.lastToolError) {
      parts.push(`Last tool error: ${analysis.lastToolError}`);
    }
    parts.push('</previous_failure>');
    parts.push('');

    if (analysis.progressMarkers.length > 0) {
      parts.push('<progress_so_far>');
      // Include last few progress markers to show what was accomplished
      const recent = analysis.progressMarkers.slice(-5);
      for (const marker of recent) {
        // Truncate long text to keep prompt manageable
        parts.push(marker.length > 500 ? marker.slice(0, 500) + '...' : marker);
      }
      parts.push('</progress_so_far>');
      parts.push('');
    }

    parts.push('<recovery_guidance>');
    parts.push(guidance);
    parts.push('</recovery_guidance>');
    parts.push('</error_recovery>');
    parts.push('');
    parts.push(`Original Task: ${originalTask}`);

    return parts.join('\n');
  }

  private _selectHistoryMode(
    analysis: HistoryAnalysis,
    attemptNumber: number,
  ): 'full' | 'summarized' | 'truncated' {
    // First retry: keep full history so agent sees what happened
    if (attemptNumber === 0) return 'full';
    // High error rate or many tool calls: summarize to save context
    if (analysis.errorRate > 0.3 || analysis.totalToolCalls > 50) return 'summarized';
    // Later retries: truncate to avoid context overflow
    if (attemptNumber >= 2) return 'truncated';
    return 'full';
  }

  private _adjustMaxTurns(
    task: TaskContext,
    error: ErrorEventContent,
  ): number | undefined {
    // If we hit max turns, give 50% more on retry
    if (error.subtype === 'error_max_turns') {
      const original = task.maxTurns ?? 200;
      return Math.min(original + Math.floor(original * 0.5), 500);
    }
    return undefined;
  }

  private _findRepeatedPatterns(
    errors: string[],
  ): Array<{ message: string; count: number }> {
    const counts = new Map<string, number>();
    for (const err of errors) {
      // Normalize error messages (remove line numbers, paths) for grouping
      const normalized = err
        .replace(/line \d+/gi, 'line N')
        .replace(/:\d+:\d+/g, ':N:N')
        .replace(/\/[\w/.-]+/g, '<path>')
        .slice(0, 200);
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .filter(([, count]) => count >= 2)
      .map(([message, count]) => ({ message, count }));
  }
}

interface HistoryAnalysis {
  totalToolCalls: number;
  totalToolErrors: number;
  errorRate: number;
  repeatedErrors: Array<{ message: string; count: number }>;
  progressMarkers: string[];
  lastToolError: string | null;
  hitMaxTurns: boolean;
}
```

**Integration point — orchestrator.ts error path (line 574-605):**

```typescript
// In the error handler, before enqueuing in retry queue:
if (this._errorRecovery.config.enabled) {
  const attemptNumber = taskContext._recoveryAttempt ?? 0;
  const strategy = this._errorRecovery.analyzeFailure(
    taskContext,
    errorContent,
    attemptNumber,
  );

  if (strategy) {
    const recoveryCtx: TaskContext = {
      ...taskContext,
      task: strategy.prompt,
      history: this._applyHistoryMode(taskContext.history, strategy.historyMode),
      maxTurns: strategy.maxTurns ?? taskContext.maxTurns,
      _recoveryAttempt: attemptNumber + 1,
    };

    // Route through normal submission — may pick a different provider
    const provider = await this._router.selectProvider(recoveryCtx);
    return this._executeWithProvider(
      provider, recoveryCtx, onEvent, 0, injectionDepth, compressor
    );
  }
}

// Fall through to existing retry queue logic if recovery not possible
```

**Effort:** 4 hours
**Files:** New `src/orchestrator/error-recovery.ts`, modify `src/orchestrator/orchestrator.ts`
**Tests:** Unit tests for `ErrorRecoveryController`; integration test that a max_turns failure retries with modified prompt; test that auth errors don't trigger recovery; test that max attempts is respected.

---

### ERR-09: Error Budget Per Task

**Problem:** No mechanism to cap how much compute is wasted on a task that keeps failing. A task that burns through 3 providers + 3 retries × 200 turns each = 1,800 LLM turns with no oversight.

**Design:**

Add error budget tracking to `TaskContext` and enforce it in the orchestrator.

```typescript
// Addition to TaskContext
interface TaskContext {
  // ... existing fields ...

  /** Error budget tracking (managed by orchestrator) */
  errorBudget?: {
    /** Maximum total turns across all attempts */
    maxTotalTurns: number;
    /** Maximum total cost in USD across all attempts */
    maxTotalCostUsd: number;
    /** Turns consumed so far (across retries/failovers) */
    turnsConsumed: number;
    /** Cost consumed so far */
    costConsumed: number;
    /** Number of recovery attempts made */
    recoveryAttempts: number;
  };
}
```

**Budget enforcement points:**
1. Before retry/recovery: check `turnsConsumed < maxTotalTurns`
2. After each `result` event: update `turnsConsumed` and `costConsumed`
3. On budget exceeded: emit error event with `subtype: 'error_budget_exceeded'`, skip recovery

**Default budget:** 500 total turns, configurable per-task and in `config.toml`:
```toml
[error_recovery]
enabled = true
max_attempts = 3
max_total_turns = 500
max_recovery_budget_pct = 50
summarize_on_retry = true
```

**Effort:** 2 hours
**Files:** `src/types.ts` (TaskContext extension), `src/orchestrator/orchestrator.ts` (enforcement), `src/orchestrator/error-recovery.ts` (budget checks)

---

### ERR-10: Error Pattern Detection Within a Session

**Problem:** When the SDK's inner tool loop encounters the same error repeatedly (e.g., a selector keeps failing, a file keeps not existing), the LLM may keep trying the same approach without realizing it's stuck. The orchestrator sees these events flowing by but doesn't intervene.

**Design:**

Add an `ErrorPatternDetector` that monitors the event stream during execution and injects steering messages when it detects repeated failures.

```typescript
// New file: src/orchestrator/error-pattern-detector.ts

export class ErrorPatternDetector {
  private recentErrors: Array<{ error: string; timestamp: Date }> = [];
  private readonly windowSize = 10;  // Track last N tool errors
  private readonly threshold = 3;    // Alert after N similar errors

  /**
   * Feed a tool_result event. Returns a steering message if a
   * repeated error pattern is detected, null otherwise.
   */
  ingest(event: AgentEvent): string | null {
    if (event.type !== 'tool_result') return null;
    const content = event.content as ToolResultEventContent;
    if (!content.error) return null;

    const normalized = this._normalize(content.error);
    this.recentErrors.push({ error: normalized, timestamp: new Date() });

    // Trim to window
    if (this.recentErrors.length > this.windowSize) {
      this.recentErrors.shift();
    }

    // Check for repeated pattern
    const count = this.recentErrors.filter(e => e.error === normalized).length;
    if (count >= this.threshold) {
      this.recentErrors = []; // Reset after alert to prevent spam
      return (
        `[System] The same error has occurred ${count} times in the last ${this.windowSize} `
        + `tool calls: "${content.error.slice(0, 200)}". `
        + `Try a fundamentally different approach instead of retrying the same strategy.`
      );
    }

    return null;
  }

  private _normalize(error: string): string {
    return error
      .replace(/line \d+/gi, 'line N')
      .replace(/:\d+:\d+/g, ':N:N')
      .replace(/\/[\w/.-]+/g, '<path>')
      .toLowerCase()
      .slice(0, 200);
  }
}
```

**Integration — inject into `_executeWithProvider` event loop:**

```typescript
// After existing tool_result handling:
if (event.type === 'tool_result') {
  const steeringHint = errorDetector.ingest(event);
  if (steeringHint) {
    const steerEvent: AgentEvent = {
      type: 'steering',
      timestamp: new Date(),
      content: {
        text: steeringHint,
        source: 'error-pattern-detector',
        author: 'system',
      },
    };
    bufferedWriter.append(steerEvent);
    taskContext.history.push(steerEvent);
    if (onEvent) onEvent(steerEvent);
  }
}
```

**Note:** This uses the existing steering injection mechanism (same as `SteeringManager`), so the LLM already knows how to interpret steering events.

**Effort:** 2 hours
**Files:** New `src/orchestrator/error-pattern-detector.ts`, modify `src/orchestrator/orchestrator.ts`
**Tests:** Unit tests for pattern detection; integration test that repeated errors trigger steering; test that threshold and window are configurable.

---

### ERR-11: Partial Progress Extraction on Failure

**Problem:** When a task fails after doing substantial work (e.g., wrote 3 of 5 files, ran tests, found bugs), the retry starts from scratch. The execution history is preserved but raw — hundreds of events that fill the context window.

**Design:**

Add a `ProgressExtractor` that summarizes what was accomplished before the failure. This feeds into ERR-08's recovery prompt.

```typescript
// New file: src/orchestrator/progress-extractor.ts

export class ProgressExtractor {
  /**
   * Extract a concise summary of progress from execution history.
   * Used by ErrorRecoveryController to build recovery prompts.
   */
  extract(history: AgentEvent[]): ProgressSummary {
    const toolCalls = this._extractToolCalls(history);
    const successfulTools = toolCalls.filter(t => !t.error);
    const failedTools = toolCalls.filter(t => t.error);

    // Identify files created/modified
    const fileOps = successfulTools
      .filter(t => ['Write', 'Edit', 'Bash'].includes(t.tool))
      .map(t => this._describeFileOp(t));

    // Identify commands run successfully
    const commands = successfulTools
      .filter(t => t.tool === 'Bash')
      .map(t => this._describeCommand(t));

    // Identify the last successful step
    const lastSuccess = successfulTools.length > 0
      ? this._describeToolCall(successfulTools[successfulTools.length - 1])
      : null;

    // Identify what failed
    const failurePoint = failedTools.length > 0
      ? this._describeToolCall(failedTools[failedTools.length - 1])
      : null;

    return {
      stepsCompleted: successfulTools.length,
      stepsFailed: failedTools.length,
      fileOps,
      commands,
      lastSuccess,
      failurePoint,
      summary: this._buildSummary(
        successfulTools, failedTools, fileOps, commands
      ),
    };
  }

  private _buildSummary(
    successes: ToolCallInfo[],
    failures: ToolCallInfo[],
    fileOps: string[],
    commands: string[],
  ): string {
    const lines: string[] = [];

    if (fileOps.length > 0) {
      lines.push(`Files modified: ${fileOps.join(', ')}`);
    }
    if (commands.length > 0) {
      lines.push(`Commands run: ${commands.slice(-5).join(', ')}`);
    }
    lines.push(
      `Progress: ${successes.length} successful tool calls, `
      + `${failures.length} failures`
    );

    return lines.join('\n');
  }

  // ... helper methods for extracting tool call info ...
}

interface ProgressSummary {
  stepsCompleted: number;
  stepsFailed: number;
  fileOps: string[];
  commands: string[];
  lastSuccess: string | null;
  failurePoint: string | null;
  summary: string;
}

interface ToolCallInfo {
  tool: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
}
```

**Effort:** 2 hours
**Files:** New `src/orchestrator/progress-extractor.ts`
**Tests:** Unit tests with sample histories; verify summary is concise; verify it handles empty history.

---

### ERR-12: Cross-Session Error Learning

**Problem:** If a task fails because "package X is not installed" or "API endpoint Y returns 403", the same failure will hit again on similar tasks. No mechanism to remember failure patterns across sessions.

**Design:**

Store error patterns in Zora's existing `StructuredMemory` system. When a task fails, extract a learnable observation. When a new task starts, query for relevant past failures.

```typescript
// Integration with existing MemoryManager

// On task failure (in error recovery flow):
await memoryManager.addItem({
  type: 'observation',
  content: `Task "${task.task.slice(0, 100)}" failed: ${error.message}. `
    + `Root cause: ${analysis.lastToolError ?? 'unknown'}. `
    + `Approach that didn't work: ${analysis.failedApproach ?? 'unknown'}.`,
  tags: ['error-pattern', errorCategory],
  source: 'error-recovery',
});

// On task start (in submitTask, alongside existing memory context loading):
const errorPatterns = await memoryManager.query({
  tags: ['error-pattern'],
  relevantTo: task.task,
  limit: 3,
});

if (errorPatterns.length > 0) {
  taskContext.memoryContext.push(
    '<past_failures>\n'
    + errorPatterns.map(p => `- ${p.content}`).join('\n')
    + '\n</past_failures>'
  );
}
```

**Effort:** 2 hours
**Files:** `src/orchestrator/orchestrator.ts` (memory integration), `src/orchestrator/error-recovery.ts` (error pattern storage)
**Tests:** Test that failure patterns are stored; test that relevant patterns are retrieved on new tasks; test that irrelevant patterns are not injected.

---

## 4. Implementation Order

Dependencies flow downward — implement in this order:

```
ERR-07  (tool error visibility in prompt)     ← No dependencies, immediate fix
  ↓
ERR-11  (progress extraction)                 ← Feeds into ERR-08
  ↓
ERR-08  (error-aware re-prompting)            ← Core recovery loop, uses ERR-07 + ERR-11
  ↓
ERR-09  (error budget)                        ← Guards ERR-08 from infinite loops
  ↓
ERR-10  (in-session pattern detection)        ← Independent, uses steering injection
  ↓
ERR-12  (cross-session learning)              ← Uses memory system, lowest priority
```

**Total estimated effort:** 12.5 hours
**Critical path (ERR-07 + ERR-08 + ERR-09):** 6.5 hours

---

## 5. Configuration

Add to `config.toml`:

```toml
[error_recovery]
# Enable the error recovery system
enabled = true

# Maximum recovery attempts per task before giving up
max_attempts = 3

# Maximum total LLM turns across all recovery attempts
max_total_turns = 500

# Whether to summarize execution history on retry (saves context tokens)
summarize_on_retry = true

# Error pattern detection: minimum repeated errors before steering injection
pattern_threshold = 3

# Error pattern detection: window of recent tool results to track
pattern_window = 10

# Store failure patterns in memory for cross-session learning
learn_from_failures = true
```

---

## 6. Observability

Each recovery attempt emits structured events:

```typescript
// New event types
type: 'recovery.start'    // Recovery attempt initiated
type: 'recovery.strategy' // Strategy selected (with guidance)
type: 'recovery.success'  // Task succeeded on recovery attempt N
type: 'recovery.exhausted'// All recovery attempts failed
type: 'recovery.budget'   // Error budget exceeded
```

These flow through the existing event pipeline (dashboard, session persistence, hooks).

---

## 7. Security Considerations

- **Recovery budget prevents abuse:** Caps total compute spent on recovery
- **Auth errors never trigger recovery:** Prevents infinite retry on revoked credentials
- **Policy violations never trigger recovery:** Agent cannot retry a blocked action via recovery
- **Steering injection uses existing mechanism:** Same security boundary as human steering
- **Error patterns in memory are tagged:** Can be excluded from memory queries if needed

---

## 8. Testing Strategy

| Test | Type | Validates |
|------|------|-----------|
| `_buildPrompt` includes error field | Unit | ERR-07 |
| Recovery prompt includes failure analysis | Unit | ERR-08 |
| Max attempts respected | Unit | ERR-08 |
| Budget exceeded stops recovery | Unit | ERR-09 |
| Pattern detector fires on threshold | Unit | ERR-10 |
| Pattern detector respects window | Unit | ERR-10 |
| Progress extractor handles empty history | Unit | ERR-11 |
| Progress extractor summarizes file ops | Unit | ERR-11 |
| Full recovery flow: fail → analyze → retry → succeed | Integration | ERR-07 + ERR-08 |
| Budget exceeded across failover + recovery | Integration | ERR-09 |
| Auth error skips recovery entirely | Integration | ERR-08 |
| Error pattern stored in memory | Integration | ERR-12 |
