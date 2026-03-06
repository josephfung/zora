/**
 * TLCIDispatcher — Routes workflow steps to code tools, local SLM, or frontier LLM.
 * Additive layer — does not replace Zora dispatch; exposes submitWorkflow() on Orchestrator.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import type { WorkflowStep, StepTier } from './step-classifier.js';
import { buildExecutionPlan, formatPlanForApproval, type ExecutionPlan } from './execution-planner.js';
import { PlanCache } from '../memory/plan-cache.js';

const log = createLogger('tlci-dispatcher');

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
  ) {}

  async dispatch(steps: WorkflowStep[], callOpts: DispatchCallOptions = {}): Promise<DispatchResult> {
    const startTime = Date.now();

    const planHash = createHash('sha256')
      .update(steps.map(s => s.description.trim().toLowerCase()).join('||'))
      .digest('hex')
      .slice(0, 16);

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

    if (
      callOpts.budgetLimitUSD !== undefined &&
      plan.costComparison.tlciEstimate > callOpts.budgetLimitUSD
    ) {
      throw new Error(
        `Estimated cost $${plan.costComparison.tlciEstimate.toFixed(4)} exceeds budget limit $${callOpts.budgetLimitUSD}`
      );
    }

    if (this._options.autonomyLevel !== 'full') {
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
          tokensSpent += Math.round(step.estimatedCostUSD / 0.000003);
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
