/**
 * PlanCache — Persistent cache for TLCI ExecutionPlans.
 * Stores plans as JSON files in ~/.zora/plan-cache/ (one file per plan hash).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeAtomic } from '../utils/fs.js';
import type { ExecutionPlan } from '../orchestrator/execution-planner.js';

export interface CachedPlan {
  plan: ExecutionPlan;
  executionCount: number;
  totalSavingsUSD: number;
  firstSeenAt: number;
  lastUsedAt: number;
}

export class PlanCache {
  private readonly _cacheDir: string;

  constructor(cacheDir?: string) {
    this._cacheDir = cacheDir ?? path.join(os.homedir(), '.zora', 'plan-cache');
  }

  async init(): Promise<void> {
    await fs.mkdir(this._cacheDir, { recursive: true, mode: 0o700 });
  }

  private _filePath(planHash: string): string {
    // Validate planHash is hex-only (SHA-256 output) to prevent path traversal
    if (!/^[a-f0-9]+$/i.test(planHash)) {
      throw new Error(`Invalid planHash "${planHash}" — must be hex characters only`);
    }
    return path.join(this._cacheDir, `${planHash}.json`);
  }

  async get(planHash: string): Promise<ExecutionPlan | null> {
    try {
      const raw = await fs.readFile(this._filePath(planHash), 'utf-8');
      const cached = JSON.parse(raw) as CachedPlan;
      const updated: CachedPlan = {
        ...cached,
        executionCount: cached.executionCount + 1,
        totalSavingsUSD: cached.totalSavingsUSD + cached.plan.costComparison.savingsUSD,
        lastUsedAt: Date.now(),
      };
      await writeAtomic(this._filePath(planHash), JSON.stringify(updated, null, 2));
      return cached.plan;
    } catch {
      return null;
    }
  }

  async set(plan: ExecutionPlan): Promise<void> {
    let existing: CachedPlan | null = null;
    try {
      const raw = await fs.readFile(this._filePath(plan.planHash), 'utf-8');
      existing = JSON.parse(raw) as CachedPlan;
    } catch {
      // not cached yet
    }

    const entry: CachedPlan = {
      plan,
      executionCount: existing?.executionCount ?? 0,
      totalSavingsUSD: existing?.totalSavingsUSD ?? 0,
      firstSeenAt: existing?.firstSeenAt ?? Date.now(),
      lastUsedAt: Date.now(),
    };
    await writeAtomic(this._filePath(plan.planHash), JSON.stringify(entry, null, 2));
  }

  async invalidate(planHash: string): Promise<void> {
    try {
      await fs.unlink(this._filePath(planHash));
    } catch {
      // already gone
    }
  }

  async getStats(): Promise<{ totalCachedPlans: number; totalExecutions: number; totalSavingsUSD: number }> {
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(this._cacheDir)).filter(f => f.endsWith('.json'));
    } catch {
      return { totalCachedPlans: 0, totalExecutions: 0, totalSavingsUSD: 0 };
    }

    let totalExecutions = 0;
    let totalSavingsUSD = 0;
    for (const file of entries) {
      try {
        const raw = await fs.readFile(path.join(this._cacheDir, file), 'utf-8');
        const cached = JSON.parse(raw) as CachedPlan;
        totalExecutions += cached.executionCount;
        totalSavingsUSD += cached.totalSavingsUSD;
      } catch {
        // skip corrupt entries
      }
    }

    return { totalCachedPlans: entries.length, totalExecutions, totalSavingsUSD };
  }
}
