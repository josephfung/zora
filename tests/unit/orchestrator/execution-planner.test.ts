import { describe, it, expect } from 'vitest';
import { buildExecutionPlan, formatPlanForApproval } from '../../../src/orchestrator/execution-planner.js';

const SAMPLE_STEPS = [
  { id: '1', description: 'fetch user records from database' },
  { id: '2', description: 'filter records where subscription is active' },
  { id: '3', description: 'classify each user intent from last message' },
  { id: '4', description: 'summarize top issues across all users' },
  { id: '5', description: 'format summary as HTML report' },
  { id: '6', description: 'send report to Slack channel' },
];

describe('buildExecutionPlan', () => {
  it('produces correct tier distribution for sample steps', () => {
    const plan = buildExecutionPlan(SAMPLE_STEPS);
    expect(plan.tierBreakdown.code).toBe(4);
    expect(plan.tierBreakdown.slm).toBe(1);
    expect(plan.tierBreakdown.frontier).toBe(1);
  });

  it('TLCI estimate is less than all-LLM estimate', () => {
    const plan = buildExecutionPlan(SAMPLE_STEPS);
    expect(plan.costComparison.tlciEstimate).toBeLessThan(plan.costComparison.allLLMEstimate);
  });

  it('produces deterministic hash for same steps', () => {
    const plan1 = buildExecutionPlan(SAMPLE_STEPS);
    const plan2 = buildExecutionPlan(SAMPLE_STEPS);
    expect(plan1.planHash).toBe(plan2.planHash);
  });

  it('produces different hash for different steps', () => {
    const plan1 = buildExecutionPlan(SAMPLE_STEPS);
    const plan2 = buildExecutionPlan([
      ...SAMPLE_STEPS,
      { id: '7', description: 'archive old records' },
    ]);
    expect(plan1.planHash).not.toBe(plan2.planHash);
  });

  it('formats approval message containing cost info', () => {
    const plan = buildExecutionPlan(SAMPLE_STEPS);
    const msg = formatPlanForApproval(plan);
    expect(msg).toContain('$');
    expect(msg).toContain('savings');
    expect(msg).toContain('CODE');
    expect(msg).toContain('AI');
  });
});
