/**
 * CostTracker — Aggregates TLCI metrics for the /api/tlci-stats dashboard endpoint.
 *
 * Daily totals are tracked separately from the rolling 100-plan window so stats remain
 * accurate even when more than 100 plans execute in a single day.
 */

import { PlanCache } from '../memory/plan-cache.js';
import type { ExecutionPlan } from '../orchestrator/execution-planner.js';

export interface CostTrackerSnapshot {
  todayStepsByTier: { code: number; slm: number; frontier: number };
  todaySavingsUSD: number;
  todayCostUSD: number;
  last100StepsTierDistribution: { code: number; slm: number; frontier: number };
  planCacheHitRate: number;
  allTimeSavingsUSD: number;
  allTimeExecutions: number;
  vsAllLLMMessage: string;
}

export class CostTracker {
  // Rolling window for tier-distribution chart (last 100 plans)
  private readonly _recentPlans: ExecutionPlan[] = [];
  private _planRequests = 0;
  private _planCacheHits = 0;

  // Daily accumulators — reset at midnight, tracks all plans regardless of window size
  private _todayStart = new Date().setHours(0, 0, 0, 0);
  private _dailyStepsByTier = { code: 0, slm: 0, frontier: 0 };
  private _dailySavingsUSD = 0;
  private _dailyCostUSD = 0;

  constructor(private readonly _planCache: PlanCache) {}

  recordPlanRequest(cacheHit: boolean, plan: ExecutionPlan): void {
    this._planRequests++;
    if (cacheHit) this._planCacheHits++;

    // Roll over daily counters if the date changed
    const today = new Date().setHours(0, 0, 0, 0);
    if (today !== this._todayStart) {
      this._todayStart = today;
      this._dailyStepsByTier = { code: 0, slm: 0, frontier: 0 };
      this._dailySavingsUSD = 0;
      this._dailyCostUSD = 0;
    }

    this._dailyStepsByTier.code += plan.tierBreakdown.code;
    this._dailyStepsByTier.slm += plan.tierBreakdown.slm;
    this._dailyStepsByTier.frontier += plan.tierBreakdown.frontier;
    this._dailySavingsUSD += plan.costComparison.savingsUSD;
    this._dailyCostUSD += plan.costComparison.tlciEstimate;

    // Rolling window for the distribution chart
    this._recentPlans.push(plan);
    if (this._recentPlans.length > 100) this._recentPlans.shift();
  }

  async getSnapshot(): Promise<CostTrackerSnapshot> {
    const cacheStats = await this._planCache.getStats();

    const last100StepsTierDistribution = this._recentPlans.slice(-100).reduce(
      (acc, p) => {
        acc.code += p.tierBreakdown.code;
        acc.slm += p.tierBreakdown.slm;
        acc.frontier += p.tierBreakdown.frontier;
        return acc;
      },
      { code: 0, slm: 0, frontier: 0 }
    );

    return {
      todayStepsByTier: { ...this._dailyStepsByTier },
      todaySavingsUSD: this._dailySavingsUSD,
      todayCostUSD: this._dailyCostUSD,
      last100StepsTierDistribution,
      planCacheHitRate: this._planRequests > 0 ? this._planCacheHits / this._planRequests : 0,
      allTimeSavingsUSD: cacheStats.totalSavingsUSD,
      allTimeExecutions: cacheStats.totalExecutions,
      vsAllLLMMessage: `Zora saved you $${this._dailySavingsUSD.toFixed(2)} today vs all-LLM`,
    };
  }
}
