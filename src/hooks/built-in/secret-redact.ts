/**
 * SecretRedactHook — Redacts API keys and secrets from tool arguments before execution.
 * Modifies args in the before phase so secrets never reach the LLM or logs.
 */

import type { ToolHook, ToolCallContext, ToolHookResult } from '../tool-hook-runner.js';

const SECRET_KEY_PATTERN = /key|token|secret|password|auth|bearer|credential/i;
const SECRET_VALUE_PATTERN = /^(sk-|ghp_|xox[baprs]-|eyJ|AIza)[A-Za-z0-9_-]{10,}/;

function redactDeep(key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    if (SECRET_KEY_PATTERN.test(key) || SECRET_VALUE_PATTERN.test(value)) return '[REDACTED]';
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => redactDeep(String(i), item));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(k, v)])
    );
  }
  return value;
}

function redactObj(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, redactDeep(k, v)])
  ) as Record<string, unknown>;
}

export const SecretRedactHook: ToolHook = {
  name: 'secret-redact',
  phase: 'before',

  async run(ctx: ToolCallContext): Promise<ToolHookResult> {
    const modifiedArgs = redactObj(ctx.arguments);
    const changed = JSON.stringify(modifiedArgs) !== JSON.stringify(ctx.arguments);
    return { allow: true, modifiedArgs: changed ? modifiedArgs : undefined };
  },
};
