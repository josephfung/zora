/**
 * AuditLogHook — Appends every tool call + result to ~/.zora/audit.jsonl.
 * Fires in 'after' phase so result is available.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ToolHook, ToolCallContext, ToolHookResult } from '../tool-hook-runner.js';

function redactSecrets(obj: unknown, depth = 0): unknown {
  if (depth > 5 || obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return obj.replace(/(?:key|token|secret|password|auth|bearer)\s*[:=]\s*[^\s,}"']+/gi, (m) => {
      const colonIdx = m.search(/[:=]/);
      return m.slice(0, colonIdx + 1) + ' [REDACTED]';
    });
  }
  if (Array.isArray(obj)) return obj.map(v => redactSecrets(v, depth + 1));
  if (typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
        const sensitive = /key|token|secret|password|auth|bearer/i.test(k);
        return [k, sensitive ? '[REDACTED]' : redactSecrets(v, depth + 1)];
      })
    );
  }
  return obj;
}

export class AuditLogHook implements ToolHook {
  name = 'audit-log';
  phase = 'after' as const;

  constructor(private readonly _logPath = path.join(os.homedir(), '.zora', 'audit.jsonl')) {}

  async run(ctx: ToolCallContext): Promise<ToolHookResult> {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      jobId: ctx.jobId,
      tool: ctx.tool,
      arguments: redactSecrets(ctx.arguments),
      result: redactSecrets(ctx.result),
      durationMs: ctx.durationMs,
    });

    await fs.mkdir(path.dirname(this._logPath), { recursive: true });
    await fs.appendFile(this._logPath, entry + '\n', 'utf-8');

    return { allow: true };
  }
}
