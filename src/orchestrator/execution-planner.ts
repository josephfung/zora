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
  const savingsPct = allLLMEstimate === 0 ? 0 : Math.round((savingsUSD / allLLMEstimate) * 100);

  const planHash = createHash('sha256')
    .update(steps.map(s => s.description.trim().toLowerCase()).join('||'))
    .digest('hex')
    .slice(0, 16);

  const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  return {
    planId,
    planHash,
    steps: classified,
    tierBreakdown,
    costComparison: { tlciEstimate, allLLMEstimate, savingsUSD, savingsPct },
    createdAt: Date.now(),
    approved: false,
  };
}

const TIER_ICONS: Record<StepTier, string> = {
  code: '⚙️ ',
  slm: '🔵',
  frontier: '🟣',
};

const TIER_LABELS: Record<StepTier, string> = {
  code: 'CODE  ',
  slm: 'SLM   ',
  frontier: 'AI    ',
};

export function formatPlanForApproval(plan: ExecutionPlan): string {
  const { steps, tierBreakdown, costComparison } = plan;
  const lines: string[] = [
    `┌─ Execution Plan ──────────────────────────────────────`,
    `│  Est. cost:  $${costComparison.tlciEstimate.toFixed(4)}  (vs $${costComparison.allLLMEstimate.toFixed(2)} all-LLM → ${costComparison.savingsPct}% savings)`,
    `│  Tiers:      ⚙️  ${tierBreakdown.code} code   🔵 ${tierBreakdown.slm} local   🟣 ${tierBreakdown.frontier} frontier`,
    `├───────────────────────────────────────────────────────`,
    ...steps.map((s, i) =>
      `│  ${String(i + 1).padStart(2)}. ${TIER_ICONS[s.tier]} [${TIER_LABELS[s.tier]}] ${s.description}`
    ),
    `└───────────────────────────────────────────────────────`,
    `  Proceed? (y/n/edit)`,
  ];
  return lines.join('\n');
}

export function formatPlanSummary(plan: ExecutionPlan): string {
  const { tierBreakdown, costComparison } = plan;
  return (
    `TLCI Plan: ${tierBreakdown.code} code / ${tierBreakdown.slm} SLM / ${tierBreakdown.frontier} frontier` +
    ` | Est. $${costComparison.tlciEstimate.toFixed(4)} (${costComparison.savingsPct}% cheaper than all-LLM)`
  );
}
