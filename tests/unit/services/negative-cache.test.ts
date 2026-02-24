import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NegativeCache } from '../../../src/services/negative-cache.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// Use a temp dir per test run to avoid state pollution
async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zora-negative-cache-test-'));
  return dir;
}

describe('NegativeCache', () => {
  let tempDir: string;
  let cache: NegativeCache;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    cache = new NegativeCache(tempDir);
    await cache.init();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns isHotFailing=false when no failures recorded', async () => {
    const result = await cache.check('read_api', { url: 'https://example.com' });
    expect(result.isHotFailing).toBe(false);
  });

  it('does not mark hot-failing for <= 5 failures', async () => {
    for (let i = 0; i < 5; i++) {
      await cache.recordFailure('read_api', { url: 'https://example.com' });
    }
    const result = await cache.check('read_api', { url: 'https://example.com' });
    expect(result.isHotFailing).toBe(false);
    expect(result.failureCount).toBe(5);
  });

  it('marks hot-failing after > 5 failures', async () => {
    for (let i = 0; i < 6; i++) {
      await cache.recordFailure('read_api', { url: 'https://example.com' });
    }
    const result = await cache.check('read_api', { url: 'https://example.com' });
    expect(result.isHotFailing).toBe(true);
    expect(result.failureCount).toBe(6);
  });

  it('hot-failing hint contains the tool name', async () => {
    for (let i = 0; i < 6; i++) {
      await cache.recordFailure('read_api', { url: 'https://example.com' });
    }
    const result = await cache.check('read_api', { url: 'https://example.com' });
    expect(result.hint).toContain('read_api');
    expect(result.hint).toContain('SYSTEM:');
  });

  it('clears failures after recordSuccess', async () => {
    for (let i = 0; i < 6; i++) {
      await cache.recordFailure('read_api', { url: 'https://example.com' });
    }
    await cache.recordSuccess('read_api', { url: 'https://example.com' });
    const result = await cache.check('read_api', { url: 'https://example.com' });
    expect(result.isHotFailing).toBe(false);
  });

  it('uses different signatures for different args', async () => {
    for (let i = 0; i < 6; i++) {
      await cache.recordFailure('read_api', { url: 'https://example.com/a' });
    }
    const result = await cache.check('read_api', { url: 'https://example.com/b' });
    expect(result.isHotFailing).toBe(false);
  });

  it('produces the same signature regardless of arg key ordering', async () => {
    for (let i = 0; i < 6; i++) {
      await cache.recordFailure('tool', { a: 1, b: 2 });
    }
    const result = await cache.check('tool', { b: 2, a: 1 });
    expect(result.isHotFailing).toBe(true);
  });

  it('persists failures across instances', async () => {
    for (let i = 0; i < 6; i++) {
      await cache.recordFailure('read_api', { url: 'https://example.com' });
    }

    // Create a new cache instance pointing to the same dir
    const cache2 = new NegativeCache(tempDir);
    await cache2.init();
    const result = await cache2.check('read_api', { url: 'https://example.com' });
    expect(result.isHotFailing).toBe(true);
  });

  it('size reflects number of tracked signatures', async () => {
    expect(cache.size).toBe(0);
    await cache.recordFailure('tool_a', { x: 1 });
    expect(cache.size).toBe(1);
    await cache.recordFailure('tool_b', { x: 1 });
    expect(cache.size).toBe(2);
  });

  it('prunes expired TTL entries on load', async () => {
    // Manually write a state file with expired timestamps
    const stateDir = path.join(tempDir, 'state');
    await fs.mkdir(stateDir, { recursive: true });
    const expiredTs = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago (beyond 24h TTL)
    const record = {
      'deadbeef': {
        timestamps: [expiredTs],
        toolName: 'old_tool',
        firstSeenAt: expiredTs,
      },
    };
    await fs.writeFile(
      path.join(stateDir, 'negative-cache.json'),
      JSON.stringify(record, null, 2),
    );

    // Load a fresh cache instance — expired entry should be pruned
    const freshCache = new NegativeCache(tempDir);
    await freshCache.init();
    expect(freshCache.size).toBe(0);
  });
});
