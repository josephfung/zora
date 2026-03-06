// Stub — full implementation in feature/tlci-foundation (will be resolved on merge)
import { createHash } from 'node:crypto';
import { classifySteps, type ClassifiedStep, type WorkflowStep, type StepTier } from './step-classifier.js';

export interface TierBreakdown { code: number; slm: number; frontier: number; }
export interface CostComparison { tlciEstimate: number; allLLMEstimate: number; savingsUSD: number; savingsPct: number; }
export interface ExecutionPlan {
  planId: string; planHash: string; steps: ClassifiedStep[];
  tierBreakdown: TierBreakdown; costComparison: CostComparison;
  createdAt: number; approvedAt?: number; approved: boolean;
}

// StepTier imported for type-checking — used by callers via this module
export type { StepTier };

export function buildExecutionPlan(steps: WorkflowStep[]): ExecutionPlan {
  const classified = classifySteps(steps);
  const tierBreakdown = classified.reduce((acc, s) => { acc[s.tier]++; return acc; }, { code: 0, slm: 0, frontier: 0 } as TierBreakdown);
  const tlciEstimate = classified.reduce((sum, s) => sum + s.estimatedCostUSD, 0);
  const allLLMEstimate = steps.length * 0.065;
  const savingsUSD = allLLMEstimate - tlciEstimate;
  const planHash = createHash('sha256').update(steps.map(s => s.description.trim().toLowerCase()).join('||')).digest('hex').slice(0, 16);
  return { planId: `plan_${Date.now()}`, planHash, steps: classified, tierBreakdown, costComparison: { tlciEstimate, allLLMEstimate, savingsUSD, savingsPct: Math.round((savingsUSD / allLLMEstimate) * 100) }, createdAt: Date.now(), approved: false };
}
export function formatPlanForApproval(plan: ExecutionPlan): string { return `Plan: ${plan.planId}`; }
export function formatPlanSummary(plan: ExecutionPlan): string { return `TLCI Plan: ${plan.planId}`; }
