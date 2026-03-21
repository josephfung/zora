/**
 * Adversarial tests for SEC-FIX-2: _shouldFlag routes to ApprovalQueue when no callback.
 *
 * Verifies that when always_flag matches an action and no flagCallback is registered,
 * the PolicyEngine routes through the ApprovalQueue instead of silently passing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PolicyEngine } from '../../../src/security/policy-engine.js';
import type { ZoraPolicy } from '../../../src/types.js';
import type { ApprovalQueue } from '../../../src/core/approval-queue.js';

function makePolicy(alwaysFlagActions: string[]): ZoraPolicy {
  return {
    filesystem: {
      allowed_paths: ['~/Projects', '/tmp'],
      denied_paths: [],
      resolve_symlinks: false,
      follow_symlinks: false,
    },
    shell: {
      mode: 'allowlist',
      allowed_commands: ['git', 'npm', 'bash'],
      denied_commands: [],
      split_chained_commands: false,
      max_execution_time: '5m',
    },
    actions: {
      reversible: [],
      irreversible: [],
      always_flag: alwaysFlagActions,
    },
    network: {
      allowed_domains: [],
      denied_domains: [],
      max_request_size: '1mb',
    },
  };
}

function makeApprovalQueueSpy(approved: boolean): ApprovalQueue {
  return {
    isEnabled: vi.fn().mockReturnValue(true),
    request: vi.fn().mockResolvedValue(approved),
  } satisfies Pick<ApprovalQueue, 'isEnabled' | 'request'> as unknown as ApprovalQueue;
}

describe('PolicyEngine._shouldFlag routes to ApprovalQueue (SEC-FIX-2)', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine(makePolicy(['git_push']));
  });

  it('calls approvalQueue.request() when always_flag matches and no flagCallback is set', async () => {
    const mockQueue = makeApprovalQueueSpy(true);
    engine.setApprovalQueue(mockQueue);

    const canUseTool = engine.createCanUseTool();
    const result = await canUseTool('Bash', { command: 'git push origin main' }, { signal: new AbortController().signal });

    expect(mockQueue.request).toHaveBeenCalledOnce();
    expect(mockQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      action: 'git_push',
      score: expect.any(Number),
      tool: 'Bash',
    }));
    // Approved → allow
    expect(result.behavior).toBe('allow');
  });

  it('denies the action when approvalQueue.request() returns false', async () => {
    const mockQueue = makeApprovalQueueSpy(false);
    engine.setApprovalQueue(mockQueue);

    const canUseTool = engine.createCanUseTool();
    const result = await canUseTool('Bash', { command: 'git push origin main' }, { signal: new AbortController().signal });

    expect(mockQueue.request).toHaveBeenCalledOnce();
    expect(result.behavior).toBe('deny');
    expect(result.message).toContain('git_push');
  });

  it('does NOT call approvalQueue when always_flag does not match the action', async () => {
    const mockQueue = makeApprovalQueueSpy(true);
    engine.setApprovalQueue(mockQueue);

    const canUseTool = engine.createCanUseTool();
    // 'npm test' → action category 'shell_exec', not in always_flag list
    await canUseTool('Bash', { command: 'npm test' }, { signal: new AbortController().signal });

    expect(mockQueue.request).not.toHaveBeenCalled();
  });

  it('uses flagCallback over approvalQueue when both are registered', async () => {
    const mockQueue = makeApprovalQueueSpy(true);
    const flagCallback = vi.fn().mockResolvedValue(true);

    engine.setApprovalQueue(mockQueue);
    engine.setFlagCallback(flagCallback);

    const canUseTool = engine.createCanUseTool();
    await canUseTool('Bash', { command: 'git push origin main' }, { signal: new AbortController().signal });

    // flagCallback should be called, NOT approvalQueue (flagCallback takes priority)
    expect(flagCallback).toHaveBeenCalledOnce();
    expect(mockQueue.request).not.toHaveBeenCalled();
  });

  it('denies action when approvalQueue is disabled (isEnabled returns false) — fail-closed', async () => {
    const mockQueue = {
      isEnabled: vi.fn().mockReturnValue(false),
      request: vi.fn().mockResolvedValue(false),
    } satisfies Pick<ApprovalQueue, 'isEnabled' | 'request'> as unknown as ApprovalQueue;
    engine.setApprovalQueue(mockQueue);

    const canUseTool = engine.createCanUseTool();
    const result = await canUseTool('Bash', { command: 'git push origin main' }, { signal: new AbortController().signal });

    // Disabled queue → fail-closed: deny when no enforcement path is available
    expect(mockQueue.request).not.toHaveBeenCalled();
    expect(result.behavior).toBe('deny');
  });

  it('wildcard always_flag catches any action and routes to approvalQueue', async () => {
    const wildcardEngine = new PolicyEngine(makePolicy(['*']));
    const mockQueue = makeApprovalQueueSpy(true);
    wildcardEngine.setApprovalQueue(mockQueue);

    const canUseTool = wildcardEngine.createCanUseTool();
    // Any tool classified by _classifyAction should trigger the queue
    await canUseTool('Write', { file_path: '/tmp/test.txt' }, { signal: new AbortController().signal });

    expect(mockQueue.request).toHaveBeenCalledOnce();
    expect(mockQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      action: 'write_file',
      score: expect.any(Number),
    }));
  });
});
