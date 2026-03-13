/**
 * IrreversibilityScorerHook — scores tool calls for irreversibility (0-100).
 *
 * score < warn threshold    → allow, log debug
 * score ≥ warn threshold    → allow, log warn
 * score ≥ flag threshold    → deny with reason "approval_required:{score}"
 * score ≥ auto_deny (95+)   → deny with reason "auto_denied:{score}"
 */
import { createLogger } from '../../utils/logger.js';
import type { ToolHook, ToolCallContext, ToolHookResult } from '../tool-hook-runner.js';

const log = createLogger('irreversibility-scorer');

export interface IrreversibilityConfig {
  scores: Record<string, number>;    // action-key → 0-100
  thresholds: {
    warn: number;      // default 40
    flag: number;      // default 65
    auto_deny: number; // default 95
  };
}

/** Map tool names to action keys for scoring lookup */
function toolToAction(tool: string): string {
  const mapping: Record<string, string> = {
    bash: 'shell_exec',
    shell: 'shell_exec',
    execute_bash: 'shell_exec',
    run_command: 'shell_exec',
    write_file: 'write_file',
    create_file: 'write_file',
    edit_file: 'edit_file',
    str_replace_editor: 'edit_file',
    read_file: 'read_file',
    git_commit: 'git_commit',
    git_push: 'git_push',
    mkdir: 'mkdir',
    cp: 'cp',
    mv: 'mv',
    delete_file: 'file_delete',
    rm: 'file_delete',
    send_message: 'send_message',
    spawn_agent: 'spawn_agent',
    spawn_zora_agent: 'spawn_agent',
    http_request: 'http_request',
    fetch: 'http_request',
  };
  return mapping[tool] ?? tool;
}

export class IrreversibilityScorerHook implements ToolHook {
  readonly name = 'irreversibility-scorer';
  readonly phase = 'before' as const;

  constructor(private readonly _config: IrreversibilityConfig) {}

  async run(ctx: ToolCallContext): Promise<ToolHookResult> {
    const actionKey = toolToAction(ctx.tool);
    const score = this._config.scores[actionKey] ?? 50;  // default 50 for unknown

    if (score >= this._config.thresholds.auto_deny) {
      log.warn({ tool: ctx.tool, score, jobId: ctx.jobId }, 'Action auto-denied: max irreversibility');
      return { allow: false, reason: `auto_denied:${score} — irreversibility score ${score}/100 exceeds auto-deny threshold` };
    }

    if (score >= this._config.thresholds.flag) {
      log.warn({ tool: ctx.tool, score, jobId: ctx.jobId }, 'Action flagged for approval');
      return { allow: false, reason: `approval_required:${score}` };
    }

    if (score >= this._config.thresholds.warn) {
      log.warn({ tool: ctx.tool, score, jobId: ctx.jobId }, 'High-irreversibility action (allowed)');
    } else {
      log.debug({ tool: ctx.tool, score }, 'Irreversibility score');
    }

    return { allow: true };
  }
}

/** Default action scores — matches policy.toml [actions.scores] defaults */
export const DEFAULT_IRREVERSIBILITY_SCORES: Record<string, number> = {
  read_file:              5,
  write_file:             20,
  edit_file:              20,
  git_commit:             30,
  mkdir:                  10,
  cp:                     15,
  mv:                     40,
  git_push:               70,
  shell_exec:             50,
  shell_exec_destructive: 90,
  send_message:           80,
  spawn_agent:            15,
  file_delete:            95,
  http_request:           30,
};

export const DEFAULT_IRREVERSIBILITY_THRESHOLDS = {
  warn: 40,
  flag: 65,
  auto_deny: 95,
};
