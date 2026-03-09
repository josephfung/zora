/**
 * CLI Integration Tests — `zora-agent ask`
 *
 * These tests spawn the real `zora-agent` binary and verify end-to-end behavior:
 *
 *   1. Smoke: --help and --version work without any config.
 *   2. Config: `status` and `doctor` commands work with ~/.zora/config.toml.
 *   3. Env-var stripping: binary starts and reaches the LLM call (doesn't hang
 *      at startup) when CLAUDECODE=1 / CLAUDE_CODE_ENTRYPOINT=cli are set.
 *      This is the regression test for the 0.10.4 hang.
 *   4. Ask (slow, opt-in): full `zora-agent ask` round-trip via the LLM.
 *
 * Tiers:
 *   - Always runs: smoke tests (no config needed).
 *   - Runs when ~/.zora/config.toml exists: config commands + env-var stripping.
 *   - Opt-in (ZORA_INTEGRATION=1): full LLM ask tests (~30-120s each).
 *
 * Usage:
 *   npm run test:unit -- tests/integration/cli-ask.test.ts
 *   ZORA_INTEGRATION=1 npm run test:unit -- tests/integration/cli-ask.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ─── Helpers ────────────────────────────────────────────────────────────────

const ZORA_CONFIG = path.join(os.homedir(), '.zora', 'config.toml');
const SESSIONS_DIR = path.join(os.homedir(), '.zora', 'sessions');
const BINARY = 'zora-agent';

function listSessionFiles(): string[] {
  try {
    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(SESSIONS_DIR, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {
    return [];
  }
}

function parseJsonl(filePath: string): Record<string, unknown>[] {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

function binaryExists(): boolean {
  const result = spawnSync('which', [BINARY], { encoding: 'utf8' });
  return result.status === 0;
}

/**
 * Starts `zora-agent ask` and checks whether the process generates
 * stdout/stderr output within `startupMs` milliseconds. If it does,
 * the binary is confirmed to have started (env-var stripping worked).
 * The process is killed after `startupMs`.
 *
 * Returns: { started: boolean, stdout: string, stderr: string }
 */
function probeStartup(
  args: string[],
  env: NodeJS.ProcessEnv,
  startupMs = 12_000,
): Promise<{ started: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let resolved = false;

    const child = spawn(BINARY, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

    const done = () => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGTERM');
      resolve({
        started: stdoutChunks.length > 0 || stderrChunks.length > 0,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
      });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString());
      // Once we see orchestrator output, the binary is confirmed started.
      done();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    child.on('error', () => done());
    child.on('close', () => done());

    setTimeout(done, startupMs);
  });
}

// ─── Skip conditions ─────────────────────────────────────────────────────────

const configExists = fs.existsSync(ZORA_CONFIG);
const binExists = binaryExists();
const runIntegration = process.env['ZORA_INTEGRATION'] === '1';

// ─── 1. Smoke tests (always run, no config needed) ──────────────────────────

describe('CLI smoke tests', () => {
  it.skipIf(!binExists)('--help exits 0 and shows usage', () => {
    const result = spawnSync(BINARY, ['--help'], { encoding: 'utf8', timeout: 5_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/zora-agent/);
  });

  it.skipIf(!binExists)('--version exits 0 and prints semver', () => {
    const result = spawnSync(BINARY, ['--version'], { encoding: 'utf8', timeout: 5_000 });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ─── 2. Config commands (require ~/.zora/config.toml, no LLM) ───────────────

describe.skipIf(!configExists || !binExists)('CLI config commands', () => {
  it('status exits 0 and lists providers', () => {
    const result = spawnSync(BINARY, ['status'], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/Providers:/);
  }, 15_000);

  it('doctor exits 0 and shows report', () => {
    const result = spawnSync(BINARY, ['doctor'], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/Zora Doctor Report/);
  }, 15_000);
});

// ─── 3. Env-var stripping regression (require config, no full LLM wait) ──────
//
// This is the regression test for the 0.10.4 hang.
//
// Root cause: CLAUDE_CODE_ENTRYPOINT=cli caused the claude-agent-sdk to enter
// interactive CLI mode. The async generator never yielded → process hung forever.
// Fix: bin/zora-agent shell wrapper uses `exec env -u` to strip these vars
// BEFORE Node.js loads any modules (in-process delete was too late due to
// static imports triggering SDK initialization at module load time).
//
// The test spawns `zora-agent ask` with all three Claude Code env vars set and
// verifies the process STARTS (produces output within 12s). In the old broken
// state, the process hung at startup — the LLM call was never reached.
// Here we kill the process after confirming startup (we don't wait for LLM reply).
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!configExists || !binExists)('CLI env-var stripping (regression: 0.10.4 hang)', () => {
  it('binary starts successfully when CLAUDECODE=1 and CLAUDE_CODE_ENTRYPOINT=cli are set', async () => {
    const probe = await probeStartup(
      ['ask', 'respond with exactly: PING'],
      {
        ...process.env,
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      },
      12_000,
    );

    // In the broken state (0.10.4), the binary hung at startup and produced
    // NO output within 12 seconds. After the fix, it starts the orchestrator
    // and produces stdout (JSON log lines) within a second or two.
    expect(probe.started, [
      'Binary produced no output within 12 seconds.',
      'This likely means the env-var stripping regression is back.',
      `stderr: ${probe.stderr.slice(0, 500)}`,
    ].join('\n')).toBe(true);
  }, 20_000);

  it('binary starts successfully with no Claude Code env vars (baseline)', async () => {
    const env = { ...process.env };
    delete env['CLAUDECODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];
    delete env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'];

    const probe = await probeStartup(
      ['ask', 'respond with exactly: PING'],
      env,
      12_000,
    );

    expect(probe.started, `stderr: ${probe.stderr.slice(0, 500)}`).toBe(true);
  }, 20_000);
});

// ─── 4. Full LLM round-trip (opt-in: ZORA_INTEGRATION=1) ────────────────────

describe.skipIf(!runIntegration || !configExists || !binExists)(
  'CLI ask: full LLM round-trip (ZORA_INTEGRATION=1)',
  () => {
    let sessionsBefore: string[];

    beforeAll(() => {
      sessionsBefore = listSessionFiles();
    });

    it(
      'exits 0 and writes a session log with task.end success=true',
      () => {
        const result = spawnSync(
          BINARY,
          ['ask', '--model', 'claude-haiku', 'respond with exactly: ZORA_TEST_PING'],
          { encoding: 'utf8', timeout: 120_000, env: { ...process.env } },
        );

        expect(result.error).toBeUndefined();
        expect(result.status, `stderr: ${result.stderr}`).toBe(0);

        const sessionsAfter = listSessionFiles();
        const newFiles = sessionsAfter.filter(f => !sessionsBefore.includes(f));
        expect(newFiles.length, 'Expected at least one new session file').toBeGreaterThan(0);

        const events = parseJsonl(newFiles[0]!);
        const taskEnd = events.find(e => e['type'] === 'task.end') as
          | { content: { success: boolean } }
          | undefined;
        expect(taskEnd, 'Missing task.end event').toBeDefined();
        expect(taskEnd!['content']['success']).toBe(true);
      },
      125_000,
    );

    it(
      'exits 0 when CLAUDECODE env vars are set (end-to-end with LLM)',
      () => {
        const before = listSessionFiles();

        const result = spawnSync(
          BINARY,
          ['ask', '--model', 'claude-haiku', 'respond with exactly: ENV_STRIP_OK'],
          {
            encoding: 'utf8',
            timeout: 120_000,
            env: {
              ...process.env,
              CLAUDECODE: '1',
              CLAUDE_CODE_ENTRYPOINT: 'cli',
              CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            },
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.status, `stderr: ${result.stderr}`).toBe(0);

        const after = listSessionFiles();
        const newFiles = after.filter(f => !before.includes(f));
        if (newFiles.length > 0) {
          const events = parseJsonl(newFiles[0]!);
          const taskEnd = events.find(e => e['type'] === 'task.end') as
            | { content: { success: boolean } }
            | undefined;
          expect(taskEnd, 'Missing task.end event').toBeDefined();
          expect(taskEnd!['content']['success']).toBe(true);
        }
      },
      125_000,
    );
  },
);
