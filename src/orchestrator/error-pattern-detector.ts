/**
 * ErrorPatternDetector — ERR-10: In-Session Repeat Detection (Circuit Breaker)
 *
 * Maintains a rolling window of recent tool results within a single session.
 * If the same tool+args signature fails twice, it injects a hard steering hint
 * to force the LLM to change its approach.
 */

import crypto from 'node:crypto';
import { canonicalizeArgs } from '../utils/args.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface ToolAttempt {
  signature: string;
  toolName: string;
  /** Canonical string of args used to generate the signature */
  argsKey: string;
  succeeded: boolean;
  timestamp: number;
}

export interface RepeatDetectionResult {
  /** True if the same (tool, args) has failed the threshold number of times */
  isRepeating: boolean;
  /** Steering hint to inject when isRepeating is true */
  hint?: string;
  /** Tool name that is repeating */
  toolName?: string;
}

// ─── Constants ────────────────────────────────────────────────────────

/** How many recent tool results to keep in the rolling window */
const WINDOW_SIZE = 5;

/** How many failures of the same signature trigger a steering injection */
const FAILURE_THRESHOLD = 2;

// ─── ErrorPatternDetector ─────────────────────────────────────────────

export class ErrorPatternDetector {
  /** Rolling window of the last N tool attempts (per session instance) */
  private readonly _window: ToolAttempt[] = [];

  /**
   * Record a tool result in the rolling window.
   *
   * @param toolName - Name of the tool that was called
   * @param args - Arguments passed to the tool
   * @param succeeded - Whether the tool call succeeded
   * @returns RepeatDetectionResult — isRepeating=true if a steering hint should be injected
   */
  record(toolName: string, args: Record<string, unknown>, succeeded: boolean): RepeatDetectionResult {
    const argsKey = this._normalizeArgs(args);
    const signature = this._computeSignature(toolName, argsKey);

    const attempt: ToolAttempt = {
      signature,
      toolName,
      argsKey,
      succeeded,
      timestamp: Date.now(),
    };

    // Append and keep only the last WINDOW_SIZE entries
    this._window.push(attempt);
    if (this._window.length > WINDOW_SIZE) {
      this._window.shift();
    }

    // Check if this signature has failed >= FAILURE_THRESHOLD times in the window
    if (!succeeded) {
      const failureCount = this._window.filter(
        a => a.signature === signature && !a.succeeded,
      ).length;

      if (failureCount >= FAILURE_THRESHOLD) {
        return {
          isRepeating: true,
          toolName,
          hint:
            `You have attempted ${toolName} with these arguments ${failureCount} time(s) and failed. ` +
            `You MUST change your parameters or use a different tool.`,
        };
      }
    }

    return { isRepeating: false };
  }

  /**
   * Reset the rolling window (e.g. at the start of a new task).
   */
  reset(): void {
    this._window.length = 0;
  }

  /**
   * Return the current window contents for inspection/testing.
   */
  getWindow(): readonly ToolAttempt[] {
    return this._window;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  /**
   * Compute a stable SHA-256 hash over tool_name + canonical args string.
   */
  private _computeSignature(toolName: string, argsKey: string): string {
    return crypto
      .createHash('sha256')
      .update(toolName + ':' + argsKey)
      .digest('hex')
      .slice(0, 16); // 16 hex chars = 64 bits — sufficient for in-session use
  }

  /**
   * Normalize args to a canonical string for stable hashing.
   * Sorts keys so {a:1, b:2} and {b:2, a:1} produce the same signature.
   */
  private _normalizeArgs(args: Record<string, unknown>): string {
    return canonicalizeArgs(args);
  }
}
