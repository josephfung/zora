/**
 * ApprovalQueue — human-in-the-loop gate for high-risk tool calls.
 *
 * When IrreversibilityScorerHook returns reason="approval_required:{score}",
 * the orchestrator should call ApprovalQueue.request() before proceeding.
 * The queue sends a notification via the registered send-handler and waits
 * for a reply. Auto-denies after configurable timeout.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('approval-queue');

export type ApprovalDecision = 'allow' | 'deny' | 'allow-30m' | 'allow-session';

export interface ApprovalConfig {
  enabled: boolean;
  timeoutMs: number;          // default 300_000 (5 min)
  retryAsApproval: boolean;   // repeated identical action = implicit allow
  retryWindowMs: number;      // window for retry-as-approval (default 60_000)
}

export interface PendingApproval {
  id: string;          // ZORA-XXXX token
  action: string;
  score: number;
  jobId: string;
  tool: string;
  resolve: (approved: boolean) => void;
  expiresAt: number;
  createdAt: number;
}

export type ApprovalSendFn = (message: string) => Promise<void>;

export class ApprovalQueue {
  private readonly _pending = new Map<string, PendingApproval>();
  private _sendFn: ApprovalSendFn | undefined;
  private _blanketAllowUntil = 0;    // epoch ms; 0 = no blanket
  private _blanketMaxScore = 0;      // max score covered by blanket

  constructor(private readonly _config: ApprovalConfig) {}

  /** Register the channel to send approval requests through */
  setSendHandler(fn: ApprovalSendFn): void {
    this._sendFn = fn;
  }

  /** Is the approval queue enabled? */
  isEnabled(): boolean {
    return this._config.enabled;
  }

  /**
   * Request approval for a high-risk action.
   * Returns true if approved (or blanket-allowed), false if denied/timed out.
   */
  async request(opts: {
    action: string;
    score: number;
    jobId: string;
    tool: string;
  }): Promise<boolean> {
    // Check blanket allow window
    if (Date.now() < this._blanketAllowUntil && opts.score < this._blanketMaxScore) {
      log.info({ tool: opts.tool, score: opts.score }, 'Action covered by blanket allow');
      return true;
    }

    if (!this._sendFn) {
      log.warn({ tool: opts.tool }, 'No send handler registered — auto-denying');
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const id = this._generateToken();
      const entry: PendingApproval = {
        id,
        action: opts.action,
        score: opts.score,
        jobId: opts.jobId,
        tool: opts.tool,
        resolve,
        expiresAt: Date.now() + this._config.timeoutMs,
        createdAt: Date.now(),
      };
      this._pending.set(id, entry);
      this._sendApprovalRequest(entry).catch(err => {
        log.error({ err }, 'Failed to send approval request');
      });

      // Auto-deny on timeout
      setTimeout(() => {
        if (this._pending.has(id)) {
          log.warn({ id, tool: opts.tool }, 'Approval request timed out — auto-denying');
          this._pending.delete(id);
          resolve(false);
        }
      }, this._config.timeoutMs);
    });
  }

  /**
   * Handle an approval reply from the user (called by channel handler).
   * token = "ZORA-XXXX", decision = "allow" | "deny" | "allow-30m" | "allow-session"
   */
  handleReply(token: string, decision: ApprovalDecision): boolean {
    const entry = this._pending.get(token);
    if (!entry) {
      log.warn({ token }, 'Unknown or expired approval token');
      return false;
    }
    this._pending.delete(token);

    switch (decision) {
      case 'allow-30m':
        this._blanketAllowUntil = Date.now() + 30 * 60 * 1000;
        this._blanketMaxScore = 80;  // blanket covers score < 80
        log.info({ until: new Date(this._blanketAllowUntil).toISOString() }, 'Blanket allow (30m) set');
        break;
      case 'allow-session':
        this._blanketAllowUntil = Infinity;
        this._blanketMaxScore = 80;
        log.warn('Blanket allow-session set — all actions score<80 will skip approval this session');
        break;
    }

    const approved = decision !== 'deny';
    log.info({ token, decision, approved }, 'Approval resolved');
    entry.resolve(approved);
    return true;
  }

  /** Check for pending approvals (for status display) */
  getPendingCount(): number {
    return this._pending.size;
  }

  /** Parse "/approve ZORA-XXXX allow" style messages. Returns null if not an approval command. */
  parseApprovalCommand(text: string): { token: string; decision: ApprovalDecision } | null {
    const match = /^\/approve\s+(ZORA-[A-Z0-9]{4})\s+(allow|deny|allow-30m|allow-session)/i.exec(text.trim());
    if (!match) return null;
    return {
      token: match[1]!.toUpperCase(),
      decision: match[2]!.toLowerCase() as ApprovalDecision,
    };
  }

  private async _sendApprovalRequest(entry: PendingApproval): Promise<void> {
    const timeoutMin = Math.round(this._config.timeoutMs / 60_000);
    const message =
      `⚠️ *Zora Action Approval Required*\n\n` +
      `Action: \`${entry.tool}\`\n` +
      `Task: \`${entry.action}\`\n` +
      `Risk: ${entry.score}/100 (${this._riskLabel(entry.score)})\n` +
      `Job: \`${entry.jobId}\`\n` +
      `Token: \`${entry.id}\`\n\n` +
      `Reply with:\n` +
      `  /approve ${entry.id} allow — approve once\n` +
      `  /approve ${entry.id} allow-30m — approve all similar (30 min)\n` +
      `  /approve ${entry.id} allow-session — approve all this session\n` +
      `  /approve ${entry.id} deny — block this action\n\n` +
      `Auto-denies in ${timeoutMin} minutes.`;

    await this._sendFn!(message);
  }

  private _riskLabel(score: number): string {
    if (score >= 90) return 'critical';
    if (score >= 70) return 'high';
    if (score >= 50) return 'medium';
    return 'low';
  }

  private _generateToken(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let token = 'ZORA-';
    for (let i = 0; i < 4; i++) {
      token += chars[Math.floor(Math.random() * chars.length)];
    }
    // Ensure uniqueness
    if (this._pending.has(token)) {
      return this._generateToken();
    }
    return token;
  }
}

export const DEFAULT_APPROVAL_CONFIG: ApprovalConfig = {
  enabled: false,  // disabled by default; opt-in
  timeoutMs: 300_000,     // 5 minutes
  retryAsApproval: true,
  retryWindowMs: 60_000,
};
