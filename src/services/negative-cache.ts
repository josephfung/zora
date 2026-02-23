/**
 * NegativeCache — ERR-12 Lite: Global Negative Cache (Cross-Session Learning)
 *
 * Prevents agents from repeating expensive, known-failing tool calls across
 * different sessions. Uses file-based persistence with 24-hour TTL.
 *
 * Signature: SHA-256(tool_name + normalized_args)
 * Threshold: > HOT_FAILING_THRESHOLD failures in the last HOT_FAILING_WINDOW_MS
 *            → marked as "Hot-Failing"
 */

import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { writeAtomic } from '../utils/fs.js';
import { isENOENT } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { canonicalizeArgs } from '../utils/args.js';

const log = createLogger('negative-cache');

// ─── Constants ────────────────────────────────────────────────────────

/** Failures in HOT_FAILING_WINDOW_MS needed to mark a signature as Hot-Failing */
const HOT_FAILING_THRESHOLD = 5;

/** Window (ms) for counting failures that determine Hot-Failing status */
const HOT_FAILING_WINDOW_MS = 60 * 60 * 1000; // 60 minutes

/** TTL for cache entries — entries older than this are pruned on load/save */
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Types ────────────────────────────────────────────────────────────

export interface FailureRecord {
  /** Timestamps of each failure (ms since epoch) */
  timestamps: number[];
  /** Tool name for human-readable diagnostics */
  toolName: string;
  /** First seen timestamp */
  firstSeenAt: number;
}

export interface HotFailingResult {
  isHotFailing: boolean;
  /** Human-readable hint to inject if isHotFailing is true */
  hint?: string;
  /** Number of recent failures */
  failureCount?: number;
}

// ─── NegativeCache ────────────────────────────────────────────────────

export class NegativeCache {
  private readonly _stateFile: string;
  private _cache: Map<string, FailureRecord> = new Map();
  private _loaded = false;
  private _initPromise: Promise<void> | null = null;

  constructor(baseDir: string = path.join(os.homedir(), '.zora')) {
    this._stateFile = path.join(baseDir, 'state', 'negative-cache.json');
  }

  /**
   * Initialize: load persisted cache from disk, pruning expired entries.
   */
  async init(): Promise<void> {
    if (this._loaded) return;
    try {
      const dir = path.dirname(this._stateFile);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });

      const content = await fs.readFile(this._stateFile, 'utf8');
      const raw = JSON.parse(content) as Record<string, FailureRecord>;
      const now = Date.now();

      for (const [sig, record] of Object.entries(raw)) {
        // Prune entries where ALL timestamps are beyond TTL
        const live = record.timestamps.filter(t => now - t < ENTRY_TTL_MS);
        if (live.length > 0) {
          this._cache.set(sig, { ...record, timestamps: live });
        }
      }
    } catch (err: unknown) {
      if (!isENOENT(err)) {
        log.warn({ err }, 'NegativeCache: failed to load state, starting fresh');
      }
      this._cache = new Map();
    }
    this._loaded = true;
  }

  /**
   * Record a failure for a given tool call.
   *
   * @param toolName - Name of the tool that failed
   * @param args - Arguments passed to the tool
   */
  async recordFailure(toolName: string, args: Record<string, unknown>): Promise<void> {
    await this._ensureLoaded();
    const signature = this._computeSignature(toolName, args);
    const now = Date.now();

    const existing = this._cache.get(signature);
    if (existing) {
      existing.timestamps.push(now);
      if (existing.timestamps.length > HOT_FAILING_THRESHOLD + 1) {
        existing.timestamps = existing.timestamps.slice(-(HOT_FAILING_THRESHOLD + 1));
      }
    } else {
      this._cache.set(signature, {
        timestamps: [now],
        toolName,
        firstSeenAt: now,
      });
    }

    await this._save();
  }

  /**
   * Record a success — clears the failure record for this signature.
   * A successful call means the pattern is no longer failing.
   */
  async recordSuccess(toolName: string, args: Record<string, unknown>): Promise<void> {
    await this._ensureLoaded();
    const signature = this._computeSignature(toolName, args);
    if (this._cache.has(signature)) {
      this._cache.delete(signature);
      await this._save();
    }
  }

  /**
   * Check if a tool call is currently "Hot-Failing."
   *
   * Returns isHotFailing=true if > HOT_FAILING_THRESHOLD failures have
   * occurred in the last HOT_FAILING_WINDOW_MS milliseconds.
   */
  async check(toolName: string, args: Record<string, unknown>): Promise<HotFailingResult> {
    await this._ensureLoaded();
    const signature = this._computeSignature(toolName, args);
    const record = this._cache.get(signature);

    if (!record) {
      return { isHotFailing: false };
    }

    const now = Date.now();
    const recentFailures = record.timestamps.filter(
      t => now - t < HOT_FAILING_WINDOW_MS,
    );

    if (recentFailures.length > HOT_FAILING_THRESHOLD) {
      return {
        isHotFailing: true,
        failureCount: recentFailures.length,
        hint:
          `SYSTEM: The planned tool call '${toolName}' with these specific parameters ` +
          `is currently failing system-wide (${recentFailures.length} failures in the last hour). ` +
          `Attempt an alternative approach or verify dependencies.`,
      };
    }

    return { isHotFailing: false, failureCount: recentFailures.length };
  }

  /**
   * Compute a stable SHA-256 signature for tool_name + normalized args.
   */
  private _computeSignature(toolName: string, args: Record<string, unknown>): string {
    const argsKey = canonicalizeArgs(args);
    return crypto
      .createHash('sha256')
      .update(toolName + ':' + argsKey)
      .digest('hex')
      .slice(0, 32); // 32 hex chars for cross-session use (more collision resistance)
  }

  /**
   * Persist the current cache state to disk, pruning expired entries first.
   */
  private async _save(): Promise<void> {
    const now = Date.now();
    const serializable: Record<string, FailureRecord> = {};

    for (const [sig, record] of this._cache.entries()) {
      const live = record.timestamps.filter(t => now - t < ENTRY_TTL_MS);
      if (live.length > 0) {
        serializable[sig] = { ...record, timestamps: live };
      }
    }

    await writeAtomic(this._stateFile, JSON.stringify(serializable, null, 2));
  }

  private async _ensureLoaded(): Promise<void> {
    if (!this._loaded) {
      this._initPromise ??= this.init();
      await this._initPromise;
    }
  }

  /** Return the number of tracked signatures (for testing/observability) */
  get size(): number {
    return this._cache.size;
  }
}
