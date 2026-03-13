#!/usr/bin/env node
/**
 * Zora Daemon — Background process that runs the Orchestrator and Dashboard.
 *
 * Launched by `zora-agent start` via child_process.fork().
 * Handles SIGTERM/SIGINT for graceful shutdown.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolveConfig } from '../config/loader.js';
import { resolvePolicy } from '../config/policy-loader.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { DashboardServer } from '../dashboard/server.js';
import { ClaudeProvider } from '../providers/claude-provider.js';
import { GeminiProvider } from '../providers/gemini-provider.js';
import { OllamaProvider } from '../providers/ollama-provider.js';
import type { ZoraPolicy, ZoraConfig, LLMProvider } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { TelegramGateway } from '../steering/telegram-gateway.js';
import type { TelegramConfig } from '../steering/telegram-gateway.js';
import { ApprovalQueue, DEFAULT_APPROVAL_CONFIG } from '../core/approval-queue.js';
import { initGlobalCooldown, DEFAULT_COOLDOWN_CONFIG } from '../core/agent-cooldown.js';
import { runSecurityAuditSilent } from './security-commands.js';

// Allow claude CLI to run as a subprocess even when launched from a Claude Code session.
// Claude Code sets CLAUDECODE to prevent nesting, but the Zora daemon legitimately
// needs to invoke claude as a provider subprocess.
delete process.env['CLAUDECODE'];

// Prevent EPIPE from crashing the process (e.g. broken pipe to signal-cli stdin/stdout).
// Log and continue — the intake adapter's reconnect logic handles the actual recovery.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    log.warn({ err: err.message }, 'EPIPE — signal-cli pipe broken; reconnect will handle it');
  } else {
    log.error({ err }, 'Uncaught exception — shutting down');
    process.exit(1);
  }
});

const log = createLogger('daemon');

function createProviders(config: ZoraConfig): LLMProvider[] {
  const providers: LLMProvider[] = [];
  for (const pConfig of config.providers) {
    if (!pConfig.enabled) continue;
    switch (pConfig.type) {
      case 'claude-sdk':
        providers.push(new ClaudeProvider({ config: pConfig }));
        break;
      case 'gemini-cli':
        providers.push(new GeminiProvider({ config: pConfig }));
        break;
      case 'ollama':
        providers.push(new OllamaProvider({ config: pConfig }));
        break;
    }
  }
  return providers;
}

async function main() {
  // Resolve project directory from env (set by CLI start command) or cwd
  const projectDir = process.env.ZORA_PROJECT_DIR ?? process.cwd();

  // Three-layer config resolution: defaults → global → project
  let config: ZoraConfig;
  let sources: string[];
  try {
    const resolved = await resolveConfig({ projectDir });
    config = resolved.config;
    sources = resolved.sources;
  } catch (err) {
    log.error({ err }, 'Config resolution failed. Run `zora-agent init` first.');
    process.exit(1);
  }
  log.info({ sources }, 'Config resolved');

  // Two-layer policy resolution: global → project
  let policy: ZoraPolicy;
  try {
    policy = await resolvePolicy({ projectDir });
  } catch {
    log.error('Policy not found at ~/.zora/policy.toml. Run `zora-agent init` first.');
    process.exit(1);
  }

  // Determine baseDir: project .zora/ if it exists, else global
  const projectZora = path.join(projectDir, '.zora');
  const configDir = fs.existsSync(projectZora) ? projectZora : path.join(os.homedir(), '.zora');

  // Security audit gate — block on FAILs unless explicitly skipped
  const skipAudit = process.env['ZORA_SKIP_SECURITY_AUDIT'] === '1';
  if (skipAudit) {
    log.warn('Security audit skipped (ZORA_SKIP_SECURITY_AUDIT=1) — running with potentially unsafe configuration');
  } else {
    const { exitCode: auditExitCode, report: auditReport } = await runSecurityAuditSilent({ zoraDir: configDir });
    const failItems = auditReport.checks.filter(c => c.severity === 'FAIL');
    const warnItems = auditReport.checks.filter(c => c.severity === 'WARN');

    if (warnItems.length > 0) {
      for (const w of warnItems) {
        const loc = w.location ? ` (${w.location})` : '';
        log.warn({ checkId: w.id }, `Security WARN: ${w.message}${loc}`);
      }
    }

    if (auditExitCode === 1) {
      for (const f of failItems) {
        const loc = f.location ? ` (${f.location})` : '';
        log.fatal({ checkId: f.id }, `Security FAIL: ${f.message}${loc}`);
      }
      log.fatal(
        { failCount: failItems.length },
        'Daemon startup blocked: security audit found critical issues. ' +
        'Fix them with `zora-agent security --fix` or set ZORA_SKIP_SECURITY_AUDIT=1 to bypass (unsafe).'
      );
      process.exit(1);
    }

    log.info({ passCount: auditReport.passCount, warnCount: auditReport.warnCount }, 'Security audit passed');
  }

  // Initialize AgentCooldown singleton before orchestrator so subagent-tool can pick it up
  const cooldownConfig = (config as unknown as Record<string, unknown>)['cooldown'] as Record<string, unknown> | undefined;
  initGlobalCooldown({
    ...DEFAULT_COOLDOWN_CONFIG,
    ...(cooldownConfig ? {
      enabled: (cooldownConfig['enabled'] as boolean) ?? false,
      level1Threshold: (cooldownConfig['level1_threshold'] as number) ?? 3,
      level2Threshold: (cooldownConfig['level2_threshold'] as number) ?? 6,
      shutdownThreshold: (cooldownConfig['shutdown_threshold'] as number) ?? 10,
      resetAfterHours: (cooldownConfig['reset_after_hours'] as number) ?? 24,
      level1DelayMs: (cooldownConfig['level1_delay_ms'] as number) ?? 2000,
    } : {}),
  });

  const providers = createProviders(config);
  const orchestrator = new Orchestrator({ config, policy, providers, baseDir: configDir });
  await orchestrator.boot();

  // Initialize ApprovalQueue (reads config or uses defaults)
  const approvalConfig = (config as unknown as Record<string, unknown>)['approval'] as Record<string, unknown> | undefined;
  const approvalQueue = new ApprovalQueue({
    ...DEFAULT_APPROVAL_CONFIG,
    ...(approvalConfig ? {
      enabled: (approvalConfig['enabled'] as boolean) ?? false,
      timeoutMs: ((approvalConfig['timeout_s'] as number) ?? 300) * 1000,
    } : {}),
  });

  // Start dashboard server
  const dashboard = new DashboardServer({
    providers,
    sessionManager: orchestrator.sessionManager,
    steeringManager: orchestrator.steeringManager,
    authMonitor: orchestrator.authMonitor,
    costTracker: orchestrator.getTLCICostTracker?.(),
    policy,
    submitTask: async (prompt: string) => {
      // Generate jobId immediately and kick off task in background (don't await)
      const jobId = `job_${crypto.randomUUID()}`;
      orchestrator.submitTask({ prompt, jobId, onEvent: (event) => {
        dashboard.broadcastEvent({ type: event.type, data: event.content });
      } }).catch(err => {
        log.error({ jobId, err }, 'Task failed');
        dashboard.broadcastEvent({ type: 'job_failed', data: { jobId, error: err instanceof Error ? err.message : String(err) } });
      });
      return jobId;
    },
    port: config.steering.dashboard_port ?? 8070,
    host: process.env.ZORA_BIND_HOST,
  });
  await dashboard.start();

  // Initialize Telegram gateway if enabled and configured
  let telegramGateway: TelegramGateway | undefined;
  const telegramConfig = config.steering.telegram;
  if (telegramConfig?.enabled) {
    const token = telegramConfig.bot_token || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      log.warn('Telegram enabled but no bot_token configured and TELEGRAM_BOT_TOKEN not set. Skipping.');
    } else {
      log.warn(
        'Telegram: Ensure you are using a dedicated bot token for this Zora instance. ' +
        'Sharing a bot token across multiple processes causes polling conflicts and lost messages.'
      );
      try {
        const fullTelegramConfig: TelegramConfig = {
          ...config.steering,
          ...telegramConfig,
          bot_token: token,
        };
        telegramGateway = await TelegramGateway.create(
          fullTelegramConfig,
          orchestrator.steeringManager,
        );
        log.info({ mode: telegramConfig.mode ?? 'polling' }, 'Telegram gateway started');
      } catch (err) {
        log.error({ err }, 'Failed to start Telegram gateway');
      }
    }
  }

  // Wire ApprovalQueue to Telegram if approval is enabled and telegram is running
  if (telegramGateway && approvalQueue.isEnabled()) {
    telegramGateway.connectApprovalQueue(approvalQueue);
    log.info('ApprovalQueue wired to Telegram gateway');
  }

  log.info('Zora daemon is running');

  // Graceful shutdown handler with 30-second timeout
  const SHUTDOWN_TIMEOUT_MS = 30_000;

  const cleanupPidFile = () => {
    const pidFile = path.join(configDir, 'state', 'daemon.pid');
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // Already removed
    }
  };

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Received signal, shutting down');

    const graceful = async () => {
      try {
        if (telegramGateway) {
          await telegramGateway.stop();
        }
        await dashboard.stop();
        await orchestrator.shutdown();
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Error during shutdown');
      }
    };

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Shutdown timed out after 30 seconds')), SHUTDOWN_TIMEOUT_MS);
    });

    try {
      await Promise.race([graceful(), timeout]);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Shutdown timeout — forcing exit');
      cleanupPidFile();
      process.exit(1);
    }

    cleanupPidFile();
    process.exit(0);
  };

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(err => { log.error({ err }, 'Shutdown error'); process.exit(1); }); });
  process.on('SIGINT', () => { shutdown('SIGINT').catch(err => { log.error({ err }, 'Shutdown error'); process.exit(1); }); });
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal error');
  process.exit(1);
});
