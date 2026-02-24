/**
 * ErrorNormalizer — ERR-07: Safe Error Replay & Normalization
 *
 * Maps raw stderr/exceptions to structured error categories.
 * Produces sanitized <failure_report> blocks safe for LLM injection.
 * Integrates with LeakDetector to redact PII from error messages.
 */

import { LeakDetector } from '../security/leak-detector.js';

// ─── Error Categories ─────────────────────────────────────────────────

export type ErrorCategory =
  | 'AUTH_FAILURE'
  | 'SYNTAX_ERROR'
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'RATE_LIMIT'
  | 'PERMISSION_DENIED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export interface NormalizedError {
  category: ErrorCategory;
  /** Sanitized, truncated message safe for LLM injection */
  safeMessage: string;
  /** Original raw message (internal use only — never inject into prompts) */
  rawMessage: string;
}

// ─── Category Detection Rules ─────────────────────────────────────────

interface CategoryRule {
  category: ErrorCategory;
  patterns: RegExp[];
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: 'AUTH_FAILURE',
    patterns: [
      /\b(401|403|unauthorized|forbidden|auth.*fail|invalid.*token|expired.*token|token.*expired|authentication)\b/i,
    ],
  },
  {
    category: 'SYNTAX_ERROR',
    patterns: [
      /\b(SyntaxError|IndentationError|ParseError|parse.*error|syntax.*error|unexpected.*token|invalid.*json)\b/i,
    ],
  },
  {
    category: 'TIMEOUT',
    patterns: [
      /\b(timeout|timed?\s*out|504|408|ETIMEDOUT|deadline.*exceed)\b/i,
    ],
  },
  {
    category: 'NOT_FOUND',
    patterns: [
      /\b(404|not.*found|ENOENT|no.*such.*file|does.*not.*exist|missing.*file|missing.*path)\b/i,
    ],
  },
  {
    category: 'RATE_LIMIT',
    patterns: [
      /\b(429|rate.*limit|too.*many.*requests|quota.*exceed|throttl)\b/i,
    ],
  },
  {
    category: 'PERMISSION_DENIED',
    patterns: [
      /\b(EACCES|permission.*denied|access.*denied|not.*permitted|EPERM)\b/i,
    ],
  },
  {
    category: 'NETWORK_ERROR',
    patterns: [
      /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|network.*error|connection.*refused|socket.*hang)\b/i,
    ],
  },
];

/** Maximum length for the safe message injected into prompts */
const MAX_SAFE_LENGTH = 400;

// ─── ErrorNormalizer ──────────────────────────────────────────────────

export class ErrorNormalizer {
  private readonly _leakDetector: LeakDetector;

  constructor(leakDetector?: LeakDetector) {
    this._leakDetector = leakDetector ?? new LeakDetector();
  }

  /**
   * Normalize a raw error message into a structured, sanitized form.
   *
   * Steps:
   *  1. Classify into an ErrorCategory.
   *  2. Redact PII/secrets via LeakDetector.
   *  3. Truncate to MAX_SAFE_LENGTH characters.
   */
  normalize(rawMessage: string): NormalizedError {
    const category = this._classify(rawMessage);
    const redacted = this._leakDetector.redact(rawMessage);
    const safeMessage = redacted.length > MAX_SAFE_LENGTH
      ? redacted.slice(0, MAX_SAFE_LENGTH - 3) + '...'
      : redacted;

    return { category, safeMessage, rawMessage };
  }

  /**
   * Normalize an Error object.
   */
  normalizeError(err: Error): NormalizedError {
    const raw = err.message || String(err);
    return this.normalize(raw);
  }

  /**
   * Produce a <failure_report> XML block safe for LLM injection.
   *
   * Security: The <failure_report> tag is a terminal leaf — content is
   * plain text only and cannot contain executable XML/HTML.
   *
   * @param toolCallId - The ID of the failing tool call
   * @param normalized - The normalized error to render
   */
  toFailureReport(_toolCallId: string, normalized: NormalizedError): string {
    // Escape any XML special chars in the safe message to prevent tag injection.
    // <failure_report> must be a terminal leaf — no child tags allowed.
    // NOTE: Do NOT wrap in <tool_result> here. The orchestrator places this string
    // as the `result` field of a tool_result event, which the provider already
    // wraps in a <tool_result> block when building API messages.
    const escaped = this._escapeXml(normalized.safeMessage);
    return (
      `<failure_report category="${normalized.category}">\n` +
      `  ${escaped}\n` +
      `</failure_report>`
    );
  }

  /**
   * Classify a raw error string into an ErrorCategory.
   * Returns 'UNKNOWN' if no rule matches.
   */
  private _classify(message: string): ErrorCategory {
    for (const { category, patterns } of CATEGORY_RULES) {
      if (patterns.some(p => p.test(message))) {
        return category;
      }
    }
    return 'UNKNOWN';
  }

  /**
   * Escape XML special characters to prevent tag injection.
   */
  private _escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
