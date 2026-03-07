/**
 * ShellSafetyHook — Blocks dangerous shell command patterns.
 * Applies to the 'bash' tool (and any alias: 'shell', 'run_command').
 */

import type { ToolHook, ToolCallContext, ToolHookResult } from '../tool-hook-runner.js';

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+-[a-z]*r[a-z]*\s+\/(?!\s*tmp)/i, reason: 'rm -rf on non-tmp path' },
  { pattern: /:\s*\(\s*\)\s*\{.*\}/,                  reason: 'fork bomb pattern' },
  { pattern: /\|\s*bash\b|\|\s*sh\b/i,                reason: 'pipe-to-shell' },
  { pattern: /curl\s+.*\|\s*(bash|sh)\b/i,             reason: 'curl-pipe-to-shell' },
  { pattern: /wget\s+.*\|\s*(bash|sh)\b/i,             reason: 'wget-pipe-to-shell' },
  { pattern: /chmod\s+777\s+\//i,                      reason: 'chmod 777 on root path' },
  { pattern: /mkfs\b/i,                                reason: 'filesystem format command' },
  { pattern: />\s*\/dev\/sd[a-z]/i,                    reason: 'write to block device' },
];

export const ShellSafetyHook: ToolHook = {
  name: 'shell-safety',
  phase: 'before',
  tools: ['bash', 'shell', 'run_command', 'execute_bash'],

  async run(ctx: ToolCallContext): Promise<ToolHookResult> {
    const cmd = String(ctx.arguments['command'] ?? ctx.arguments['cmd'] ?? '');

    for (const { pattern, reason } of BLOCKED_PATTERNS) {
      if (pattern.test(cmd)) {
        return { allow: false, reason: `Blocked shell command: ${reason}` };
      }
    }

    return { allow: true };
  },
};
