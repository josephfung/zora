/**
 * CostTracker — Aggregates TLCI metrics for the /api/tlci-stats dashboard endpoint.
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
  private readonly _recentPlans: ExecutionPlan[] = [];
  private _planRequests = 0;
  private _planCacheHits = 0;

  constructor(private readonly _planCache: PlanCache) {}

  recordPlanRequest(cacheHit: boolean, plan: ExecutionPlan): void {
    this._planRequests++;
    if (cacheHit) this._planCacheHits++;
    this._recentPlans.push(plan);
    if (this._recentPlans.length > 100) this._recentPlans.shift();
  }

  async getSnapshot(): Promise<CostTrackerSnapshot> {
    const cacheStats = await this._planCache.getStats();
    const todayStart = new Date().setHours(0, 0, 0, 0);

    const todayPlans = this._recentPlans.filter(p => p.createdAt >= todayStart);

    const sumTiers = (plans: ExecutionPlan[]) =>
      plans.reduce(
        (acc, p) => {
          acc.code += p.tierBreakdown.code;
          acc.slm += p.tierBreakdown.slm;
          acc.frontier += p.tierBreakdown.frontier;
          return acc;
        },
        { code: 0, slm: 0, frontier: 0 }
      );

    const todayStepsByTier = sumTiers(todayPlans);
    const todaySavingsUSD = todayPlans.reduce((sum, p) => sum + p.costComparison.savingsUSD, 0);
    const todayCostUSD = todayPlans.reduce((sum, p) => sum + p.costComparison.tlciEstimate, 0);
    const last100StepsTierDistribution = sumTiers(this._recentPlans.slice(-100));

    return {
      todayStepsByTier,
      todaySavingsUSD,
      todayCostUSD,
      last100StepsTierDistribution,
      planCacheHitRate: this._planRequests > 0 ? this._planCacheHits / this._planRequests : 0,
      allTimeSavingsUSD: cacheStats.totalSavingsUSD,
      allTimeExecutions: cacheStats.totalExecutions,
      vsAllLLMMessage: `Zora saved you $${todaySavingsUSD.toFixed(2)} today vs all-LLM`,
    };
  }
}
