/**
 * IntentCapsuleManager — Cryptographically signed mandate bundles for goal drift detection.
 *
 * Security Hardening (Feb 2026) — ASI01 Mitigation:
 *   - Creates HMAC-SHA256 signed "Intent Capsules" at task start
 *   - Verifies capsule integrity to detect tampering
 *   - Checks each action for consistency with the original mandate
 *   - Detects goal hijacking via keyword overlap and category matching
 */

import crypto from 'node:crypto';
import type { IntentCapsule, DriftCheckResult } from './security-types.js';

/**
 * Terms that signal potential data exfiltration or credential exposure.
 * Presence in an action (but NOT in the mandate) reduces effective overlap ratio.
 */
const SUSPICIOUS_TERMS = new Set([
  'credentials', 'external', 'exfiltrate', 'upload', 'post', 'token',
  'secret', 'secrets', 'api_key', 'apikey', 'password', 'passwd', 'curl', 'wget',
  'send', 'transmit', 'export', 'leak', 'dump', 'harvest',
]);

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'can', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'this', 'that',
  'it', 'and', 'or', 'but', 'not', 'if', 'then', 'else',
  'please', 'help', 'me', 'i', 'you', 'we', 'they',
]);

export class IntentCapsuleManager {
  private readonly _signingKey: Buffer;
  private _activeCapsule: IntentCapsule | null = null;
  private _driftHistory: DriftCheckResult[] = [];

  constructor(signingSecret: string) {
    this._signingKey = crypto.createHash('sha256').update(signingSecret).digest();
  }

  /**
   * Create a signed intent capsule at task start.
   * The capsule captures the original mandate and cannot be
   * modified without invalidating the signature.
   */
  createCapsule(mandate: string, options?: {
    allowedActionCategories?: string[];
    ttlMs?: number;
  }): IntentCapsule {
    const capsuleId = `capsule_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const mandateHash = crypto.createHash('sha256').update(mandate).digest('hex');
    const mandateKeywords = this._extractKeywords(mandate);
    const createdAt = new Date().toISOString();
    const expiresAt = options?.ttlMs
      ? new Date(Date.now() + options.ttlMs).toISOString()
      : undefined;
    const allowedActionCategories = options?.allowedActionCategories ?? [];

    const payload = JSON.stringify({
      capsuleId, mandate, mandateHash, mandateKeywords,
      allowedActionCategories, createdAt, expiresAt,
    });

    const signature = crypto
      .createHmac('sha256', this._signingKey)
      .update(payload)
      .digest('hex');

    const capsule: IntentCapsule = {
      capsuleId, mandate, mandateHash, mandateKeywords,
      allowedActionCategories, signature, createdAt, expiresAt,
    };

    this._activeCapsule = capsule;
    this._driftHistory = [];
    return capsule;
  }

  /**
   * Verify the HMAC signature of an intent capsule.
   * Returns false if the capsule has been tampered with.
   */
  verifyCapsule(capsule: IntentCapsule): boolean {
    const payload = JSON.stringify({
      capsuleId: capsule.capsuleId,
      mandate: capsule.mandate,
      mandateHash: capsule.mandateHash,
      mandateKeywords: capsule.mandateKeywords,
      allowedActionCategories: capsule.allowedActionCategories,
      createdAt: capsule.createdAt,
      expiresAt: capsule.expiresAt,
    });

    const expectedSignature = crypto
      .createHmac('sha256', this._signingKey)
      .update(payload)
      .digest('hex');

    try {
      const sigBuf = Buffer.from(capsule.signature, 'hex');
      const expBuf = Buffer.from(expectedSignature, 'hex');
      // timingSafeEqual throws if buffers differ in length
      if (sigBuf.length !== expBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expBuf);
    } catch {
      return false;
    }
  }

  /**
   * Check if an action is consistent with the active mandate.
   * Uses category matching and keyword overlap heuristics.
   */
  checkDrift(actionType: string, actionDetail: string): DriftCheckResult {
    if (!this._activeCapsule) {
      return { consistent: true, confidence: 0, action: actionType, mandateHash: '' };
    }

    const capsule = this._activeCapsule;

    // Check capsule expiry
    if (capsule.expiresAt && new Date() > new Date(capsule.expiresAt)) {
      const result: DriftCheckResult = {
        consistent: false, confidence: 1.0,
        reason: 'Intent capsule has expired',
        action: actionType, mandateHash: capsule.mandateHash,
      };
      this._driftHistory.push(result);
      return result;
    }

    // Check action category against allowed categories
    if (capsule.allowedActionCategories.length > 0) {
      if (!capsule.allowedActionCategories.includes(actionType)) {
        const result: DriftCheckResult = {
          consistent: false, confidence: 0.8,
          reason: `Action '${actionType}' not in mandate's allowed categories: ${capsule.allowedActionCategories.join(', ')}`,
          action: actionType, mandateHash: capsule.mandateHash,
        };
        this._driftHistory.push(result);
        return result;
      }
    }

    // Keyword overlap check: does the action detail relate to the mandate?
    const actionKeywords = this._extractKeywords(actionDetail);
    const mandateKeywordSet = new Set(capsule.mandateKeywords);

    // Empty action keywords → treat as zero-overlap (not a perfect match).
    // A zero-length input carries no information and should not bypass drift detection.
    if (actionKeywords.length === 0) {
      const result: DriftCheckResult = {
        consistent: false,
        confidence: 1.0,
        reason: 'Action detail contains no meaningful keywords — cannot verify mandate alignment',
        action: actionType,
        mandateHash: capsule.mandateHash,
      };
      this._driftHistory.push(result);
      return result;
    }

    const overlap = actionKeywords.filter(k => mandateKeywordSet.has(k));
    const overlapRatio = overlap.length / actionKeywords.length;

    // Layer 2: suspicious term penalty.
    // Normalize each action keyword (split on hyphens/underscores and stem common suffixes)
    // before checking against SUSPICIOUS_TERMS to catch patterns like "sending", "external-host".
    const normalizedActionTokens = actionKeywords.flatMap(k => this._normalizeToken(k));
    const normalizedMandateTokens = new Set(
      capsule.mandateKeywords.flatMap(k => this._normalizeToken(k)),
    );
    const suspiciousCount = normalizedActionTokens.filter(
      t => SUSPICIOUS_TERMS.has(t) && !normalizedMandateTokens.has(t),
    ).length;
    const suspicionPenalty = Math.min(suspiciousCount * 0.15, 0.60);
    const effectiveRatio = overlapRatio * (1 - suspicionPenalty);

    // Layer 1: require at least 40% effective keyword overlap. When any suspicious terms are
    // detected, also require that the effective overlap strictly exceeds the base threshold to
    // prevent borderline pass-through of injected exfiltration terms.
    const effectiveThreshold = suspiciousCount > 0 ? 0.45 : 0.4;
    const consistent = effectiveRatio >= effectiveThreshold;
    const confidence = consistent ? effectiveRatio : 1.0 - effectiveRatio;

    const result: DriftCheckResult = {
      consistent,
      confidence,
      ...(!consistent ? {
        reason: suspiciousCount > 0
          ? `Low mandate relevance (${(overlapRatio * 100).toFixed(0)}% overlap → ${(effectiveRatio * 100).toFixed(0)}% effective overlap, ${suspiciousCount} suspicious term${suspiciousCount > 1 ? 's' : ''} detected)`
          : `Low mandate relevance (${(overlapRatio * 100).toFixed(0)}% keyword overlap)`,
      } : {}),
      action: actionType,
      mandateHash: capsule.mandateHash,
    };

    this._driftHistory.push(result);
    return result;
  }

  /**
   * Get the currently active capsule.
   */
  getActiveCapsule(): IntentCapsule | null {
    return this._activeCapsule;
  }

  /**
   * Get drift check history.
   */
  getDriftHistory(): DriftCheckResult[] {
    return [...this._driftHistory];
  }

  /**
   * Infer allowed action categories from a mandate string.
   * Parses constraint signals to determine what action types the user permits.
   *
   * Category names returned here MUST match those produced by PolicyEngine._classifyAction():
   *   'write_file', 'edit_file', 'shell_exec', 'shell_exec_destructive',
   *   'git_push', 'git_operation', 'unknown' (null → unknown)
   */
  inferCategories(mandate: string): string[] {
    const lower = mandate.toLowerCase();

    // "don't action", "suggest only", "preview", "dry run", "don't execute"
    const readOnlyPatterns = [
      /don['']?t\s+action/,
      /suggest\s+only/,
      /dry.?run/,
      /preview\s+only/,
      /don['']?t\s+execute/,
      /read.?only/,
      /no\s+action/,
      /without\s+acting/,
      /before\s+i\s+tell\s+you/,
      /until\s+i\s+(tell|confirm|approve|say)/,
      /don['']?t\s+do\s+anything/,
    ];

    for (const pattern of readOnlyPatterns) {
      if (pattern.test(lower)) {
        // Allow only read-like operations. _classifyAction returns null (→ 'unknown') for
        // read tools (Read, Glob, Grep) so 'unknown' must be included for reads to pass.
        return ['unknown'];
      }
    }

    // "don't delete", "no deletions"
    const noDeletePatterns = [
      /don['']?t\s+delete/,
      /no\s+delet/,
      /don['']?t\s+remove/,
      /don['']?t\s+rm/,
    ];

    for (const pattern of noDeletePatterns) {
      if (pattern.test(lower)) {
        // Allow everything except destructive shell/git operations
        return ['unknown', 'write_file', 'edit_file', 'shell_exec', 'git_operation'];
      }
    }

    // No constraint signals detected — return empty (all categories permitted)
    return [];
  }

  /**
   * Clear the active capsule (session end).
   */
  clearCapsule(): void {
    this._activeCapsule = null;
    this._driftHistory = [];
  }

  /**
   * Serialize the active capsule to a plain object for persistence.
   * Returns null if no active capsule.
   */
  serializeActiveCapsule(): IntentCapsule | null {
    if (!this._activeCapsule) return null;
    return {
      ...this._activeCapsule,
      // Deep-copy arrays so mutations to the snapshot don't affect the active capsule
      allowedActionCategories: [...this._activeCapsule.allowedActionCategories],
      mandateKeywords: [...this._activeCapsule.mandateKeywords],
    };
  }

  /**
   * Restore a previously serialized capsule as the active capsule.
   * Verifies the HMAC signature before restoring — rejects tampered capsules.
   */
  restoreCapsule(capsule: IntentCapsule): boolean {
    if (!this.verifyCapsule(capsule)) {
      return false;
    }
    this._activeCapsule = capsule;
    this._driftHistory = [];
    return true;
  }

  /**
   * Extract meaningful keywords from text, filtering stop words.
   */
  private _extractKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }

  /**
   * Normalize a single keyword for suspicious-term matching.
   * Splits hyphenated/underscored compound tokens and strips common verb suffixes
   * so that "external-host" → ["external", "host"], "sending" → ["send"], etc.
   */
  private _normalizeToken(token: string): string[] {
    const parts = token.split(/[-_]+/).filter(p => p.length > 1);
    return parts.map(p => {
      // Strip common English inflection suffixes to reach the root form.
      if (p.endsWith('ing') && p.length > 5) return p.slice(0, -3);
      if (p.endsWith('tion') && p.length > 5) return p.slice(0, -4);
      if (p.endsWith('ed') && p.length > 4) return p.slice(0, -2);
      if (p.endsWith('ing') && p.length > 4) return p.slice(0, -3);
      if (p.endsWith('s') && p.length > 4) return p.slice(0, -1);
      return p;
    });
  }
}
