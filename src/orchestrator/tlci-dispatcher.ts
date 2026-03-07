/**
 * TLCIDispatcher — Routes workflow steps to code tools, local SLM, or frontier LLM.
 * Additive layer — does not replace Zora dispatch; exposes submitWorkflow() on Orchestrator.
 */

import { createLogger } from '../utils/logger.js';
import type { WorkflowStep, StepTier } from './step-classifier.js';
import { buildExecutionPlan, computePlanHash, formatPlanForApproval, type ExecutionPlan } from './execution-planner.js';
import { PlanCache } from '../memory/plan-cache.js';
import type { CostTracker } from '../dashboard/cost-tracker.js';

const log = createLogger('tlci-dispatcher');

/** Cost per token for frontier LLM (used for rough token spend estimate). */
const FRONTIER_COST_PER_TOKEN = 0.000003;

export type AutonomyLevel = 'ask' | 'confirm_plan' | 'full';

/** Static dispatcher configuration (set once at construction). */
export interface TLCIDispatchOptions {
  autonomyLevel: AutonomyLevel;
}

/** Per-call options passed to dispatch() — override defaults for individual runs. */
export interface DispatchCallOptions {
  budgetLimitUSD?: number;
  skipCacheFor?: string[];
  dryRun?: boolean;
}

export interface DispatchResult {
  planId: string;
  planHash: string;
  cacheHit: boolean;
  stepsExecuted: number;
  tierBreakdown: { code: number; slm: number; frontier: number };
  tokensSpent: number;
  actualCostUSD: number;
  savedVsAllLLM: number;
  executionTimeMs: number;
}

export type StepRunner = (step: WorkflowStep) => Promise<unknown>;
export type ApprovalFn = (message: string) => Promise<boolean>;

export class TLCIDispatcher {
  constructor(
    private readonly _planCache: PlanCache,
    private readonly _options: TLCIDispatchOptions,
    private readonly _codeToolRunner: StepRunner,
    private readonly _ollamaRunner: StepRunner,
    private readonly _frontierRunner: StepRunner,
    private readonly _approvalFn: ApprovalFn,
    private readonly _costTracker?: CostTracker,
  ) {}

  async dispatch(steps: WorkflowStep[], callOpts: DispatchCallOptions = {}): Promise<DispatchResult> {
    const startTime = Date.now();

    const planHash = computePlanHash(steps);

    let plan: ExecutionPlan | null = null;
    let cacheHit = false;

    if (!callOpts.skipCacheFor?.includes(planHash)) {
      plan = await this._planCache.get(planHash);
      if (plan) {
        cacheHit = true;
        log.debug({ planHash }, 'plan cache hit');
      }
    }

    if (!plan) {
      plan = buildExecutionPlan(steps);
      await this._planCache.set(plan);
      log.debug({ planHash: plan.planHash, steps: steps.length }, 'plan built and cached');
    }

    // Record metrics — plan is a template object; execution-specific state (approved, etc.)
    // lives only in-memory for this dispatch and is not persisted back to the cache.
    this._costTracker?.recordPlanRequest(cacheHit, plan);

    if (
      callOpts.budgetLimitUSD !== undefined &&
      plan.costComparison.tlciEstimate > callOpts.budgetLimitUSD
    ) {
      throw new Error(
        `Estimated cost $${plan.costComparison.tlciEstimate.toFixed(4)} exceeds budget limit $${callOpts.budgetLimitUSD}`
      );
    }

    if (this._options.autonomyLevel === 'full') {
      // Full autonomy: auto-approve without prompting
      plan.approved = true;
      plan.approvedAt = Date.now();
    } else {
      const approved = await this._approvalFn(formatPlanForApproval(plan));
      if (!approved) throw new Error('Execution plan rejected by user');
      plan.approved = true;
      plan.approvedAt = Date.now();
    }

    if (callOpts.dryRun) {
      return {
        planId: plan.planId,
        planHash: plan.planHash,
        cacheHit,
        stepsExecuted: 0,
        tierBreakdown: plan.tierBreakdown,
        tokensSpent: 0,
        actualCostUSD: 0,
        savedVsAllLLM: plan.costComparison.savingsUSD,
        executionTimeMs: Date.now() - startTime,
      };
    }

    let tokensSpent = 0;
    let actualCostUSD = 0;

    for (const step of plan.steps) {
      const tier = step.tier as StepTier;
      log.debug({ stepId: step.id, tier, description: step.description }, 'executing step');

      switch (tier) {
        case 'code':
          await this._codeToolRunner(step);
          break;
        case 'slm':
          await this._ollamaRunner(step);
          actualCostUSD += step.estimatedCostUSD;
          break;
        case 'frontier':
          await this._frontierRunner(step);
          actualCostUSD += step.estimatedCostUSD;
          tokensSpent += Math.round(step.estimatedCostUSD / FRONTIER_COST_PER_TOKEN);
          break;
      }
    }

    log.info(
      {
        planId: plan.planId,
        steps: plan.steps.length,
        cacheHit,
        actualCostUSD,
        savedVsAllLLM: plan.costComparison.allLLMEstimate - actualCostUSD,
      },
      'tlci dispatch complete'
    );

    return {
      planId: plan.planId,
      planHash: plan.planHash,
      cacheHit,
      stepsExecuted: plan.steps.length,
      tierBreakdown: plan.tierBreakdown,
      tokensSpent,
      actualCostUSD,
      savedVsAllLLM: plan.costComparison.allLLMEstimate - actualCostUSD,
      executionTimeMs: Date.now() - startTime,
    };
  }
}
