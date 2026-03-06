// Stub — full implementation in feature/tlci-foundation (will be resolved on merge)
import type { ExecutionPlan } from '../orchestrator/execution-planner.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface CachedPlan { plan: ExecutionPlan; executionCount: number; totalSavingsUSD: number; firstSeenAt: number; lastUsedAt: number; }

export class PlanCache {
  private readonly _cacheDir: string;
  constructor(cacheDir?: string) { this._cacheDir = cacheDir ?? path.join(os.homedir(), '.zora', 'plan-cache'); }
  async init(): Promise<void> { await fs.mkdir(this._cacheDir, { recursive: true, mode: 0o700 }); }
  async get(_planHash: string): Promise<ExecutionPlan | null> { return null; }
  async set(_plan: ExecutionPlan): Promise<void> {}
  async invalidate(_planHash: string): Promise<void> {}
  async getStats(): Promise<{ totalCachedPlans: number; totalExecutions: number; totalSavingsUSD: number }> { return { totalCachedPlans: 0, totalExecutions: 0, totalSavingsUSD: 0 }; }
}
