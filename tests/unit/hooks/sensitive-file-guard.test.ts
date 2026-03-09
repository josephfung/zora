import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { SensitiveFileGuardHook } from '../../../src/hooks/built-in/sensitive-file-guard.js';
import type { ToolCallContext } from '../../../src/hooks/tool-hook-runner.js';

const HOME = os.homedir();

const ctx = (tool: string, args: Record<string, unknown>): ToolCallContext => ({
  jobId: 'test', tool, arguments: args,
});

// ─── File tool blocking ───────────────────────────────────────────────────────

describe('SensitiveFileGuardHook: Read tool', () => {
  const blocked = [
    [`${HOME}/.zora/secrets.env`,       'secrets.env (absolute)'],
    ['~/.zora/secrets.env',             'secrets.env (tilde)'],
    [`${HOME}/.env`,                    '.env (home)'],
    ['.env',                            '.env (relative)'],
    ['.env.local',                      '.env.local'],
    ['.env.production',                 '.env.production'],
    ['.envrc',                          '.envrc'],
    [`${HOME}/.ssh/id_rsa`,             'SSH private key'],
    [`${HOME}/.ssh/config`,             'SSH config'],
    [`${HOME}/.gnupg/secring.gpg`,      'GPG key'],
    [`${HOME}/.aws/credentials`,        'AWS credentials'],
    [`${HOME}/.aws/config`,             'AWS config'],
    ['/some/path/server.pem',           'PEM file'],
    ['/certs/my-cert.p12',              'PKCS#12'],
    [`${HOME}/.ssh/id_ed25519`,         'Ed25519 key'],
    [`${HOME}/.ssh/id_ecdsa`,           'ECDSA key'],
  ];

  for (const [filePath, label] of blocked) {
    it(`blocks: ${label}`, async () => {
      const result = await SensitiveFileGuardHook.run(ctx('Read', { file_path: filePath }));
      expect(result.allow, `Expected ${filePath} to be blocked`).toBe(false);
      expect(result.reason).toMatch(/blocked/i);
    });
  }

  const allowed = [
    [`${HOME}/.zora/config.toml`,     'Zora config (not secrets)'],
    [`${HOME}/.zora/policy.toml`,     'Zora policy'],
    [`${HOME}/.zora/SOUL.md`,         'Zora identity'],
    [`${HOME}/Dev/myproject/src/index.ts`, 'normal source file'],
    ['/tmp/test.txt',                  'tmp file'],
    [`${HOME}/notes.md`,               'regular markdown'],
  ];

  for (const [filePath, label] of allowed) {
    it(`allows: ${label}`, async () => {
      const result = await SensitiveFileGuardHook.run(ctx('Read', { file_path: filePath }));
      expect(result.allow, `Expected ${filePath} to be allowed`).toBe(true);
    });
  }
});

describe('SensitiveFileGuardHook: Grep tool', () => {
  it('blocks grep on .ssh directory', async () => {
    const result = await SensitiveFileGuardHook.run(
      ctx('Grep', { pattern: 'host', path: `${HOME}/.ssh` }),
    );
    expect(result.allow).toBe(false);
  });

  it('allows grep on normal directories', async () => {
    const result = await SensitiveFileGuardHook.run(
      ctx('Grep', { pattern: 'import', path: `${HOME}/Dev/project/src` }),
    );
    expect(result.allow).toBe(true);
  });
});

describe('SensitiveFileGuardHook: Glob tool', () => {
  it('blocks glob pattern that includes .ssh', async () => {
    const result = await SensitiveFileGuardHook.run(
      ctx('Glob', { pattern: `${HOME}/.ssh/**` }),
    );
    expect(result.allow).toBe(false);
  });
});

// ─── Shell tool blocking ──────────────────────────────────────────────────────

describe('SensitiveFileGuardHook: Bash tool', () => {
  const blockedShell = [
    [`cat ~/.zora/secrets.env`,                 'cat secrets.env (tilde)'],
    [`cat ${HOME}/.zora/secrets.env`,           'cat secrets.env (absolute)'],
    [`head -20 ~/.env`,                         'head .env'],
    [`tail ~/.env.local`,                       'tail .env.local'],
    [`cat ~/.ssh/id_rsa`,                       'cat SSH key'],
    [`base64 ~/.aws/credentials`,               'base64 AWS creds'],
    [`xxd ~/.gnupg/secring.gpg`,                'xxd GPG key'],
    [`openssl rsa -in server.pem -text`,        'openssl read PEM'],
    [`strings /home/user/id_ed25519`,           'strings on private key'],
  ];

  for (const [cmd, label] of blockedShell) {
    it(`blocks shell: ${label}`, async () => {
      const result = await SensitiveFileGuardHook.run(ctx('bash', { command: cmd }));
      expect(result.allow, `Expected "${cmd}" to be blocked`).toBe(false);
    });
  }

  const allowedShell = [
    [`ls -la ~/.zora/`,                         'ls (not a read command)'],
    [`cat ~/.zora/config.toml`,                  'cat config.toml (allowed)'],
    [`cat ${HOME}/Dev/project/README.md`,        'cat normal file'],
    [`echo "hello world"`,                       'echo'],
    [`git log --oneline`,                        'git log'],
    [`npm test`,                                  'npm test'],
  ];

  for (const [cmd, label] of allowedShell) {
    it(`allows shell: ${label}`, async () => {
      const result = await SensitiveFileGuardHook.run(ctx('bash', { command: cmd }));
      expect(result.allow, `Expected "${cmd}" to be allowed`).toBe(true);
    });
  }
});

// ─── Path traversal resistance ────────────────────────────────────────────────

describe('SensitiveFileGuardHook: path traversal resistance', () => {
  it('blocks traversal to .ssh via ..', async () => {
    const result = await SensitiveFileGuardHook.run(
      ctx('Read', { file_path: `${HOME}/.zora/../../.ssh/id_rsa` }),
    );
    expect(result.allow).toBe(false);
  });

  it('blocks traversal in shell command', async () => {
    const result = await SensitiveFileGuardHook.run(
      ctx('bash', { command: `cat ${HOME}/.zora/../../.env` }),
    );
    expect(result.allow).toBe(false);
  });
});

// ─── Other tools pass through ─────────────────────────────────────────────────

describe('SensitiveFileGuardHook: non-file tools pass through', () => {
  it('allows http_request unconditionally', async () => {
    const result = await SensitiveFileGuardHook.run(
      ctx('http_request', { url: 'https://api.example.com', method: 'GET' }),
    );
    expect(result.allow).toBe(true);
  });

  it('allows memory tools unconditionally', async () => {
    const result = await SensitiveFileGuardHook.run(
      ctx('save_memory', { content: 'some data' }),
    );
    expect(result.allow).toBe(true);
  });
});
