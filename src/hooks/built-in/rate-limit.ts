/**
 * RateLimitHook — Throttles per-tool call rates using a sliding window.
 */

import type { ToolHook, ToolCallContext, ToolHookResult } from '../tool-hook-runner.js';

export interface RateLimitConfig {
  tool: string;
  maxCalls: number;
  windowMs: number;
}

export class RateLimitHook implements ToolHook {
  name = 'rate-limit';
  phase = 'before' as const;

  private readonly _windows = new Map<string, number[]>();

  constructor(private readonly _limits: RateLimitConfig[]) {}

  async run(ctx: ToolCallContext): Promise<ToolHookResult> {
    const limit = this._limits.find(l => l.tool === ctx.tool || l.tool === '*');
    if (!limit) return { allow: true };

    const now = Date.now();
    const key = ctx.tool;
    const calls = (this._windows.get(key) ?? []).filter(t => now - t < limit.windowMs);
    calls.push(now);
    this._windows.set(key, calls);

    if (calls.length > limit.maxCalls) {
      return {
        allow: false,
        reason: `Rate limit: ${ctx.tool} exceeds ${limit.maxCalls} calls per ${limit.windowMs}ms`,
      };
    }

    return { allow: true };
  }
}
