import { describe, it, expect, vi } from 'vitest';
import { handlePlanWorkflow, PLAN_WORKFLOW_TOOL_DEFINITION, PLAN_WORKFLOW_TOOL_NAME, createPlanWorkflowTool } from '../../../src/tools/planning-tool.js';

const SAMPLE_STEPS = [
  { id: '1', description: 'fetch user records from database' },
  { id: '2', description: 'filter records where subscription is active' },
  { id: '3', description: 'classify each user intent from last message' },
  { id: '4', description: 'summarize top issues across all users' },
  { id: '5', description: 'format summary as HTML report' },
  { id: '6', description: 'send report to Slack channel via webhook' },
];

describe('PLAN_WORKFLOW_TOOL_DEFINITION', () => {
  it('has correct name', () => {
    expect(PLAN_WORKFLOW_TOOL_DEFINITION.name).toBe(PLAN_WORKFLOW_TOOL_NAME);
  });

  it('requires steps array', () => {
    expect(PLAN_WORKFLOW_TOOL_DEFINITION.input_schema.required).toContain('steps');
  });

  it('has description string', () => {
    expect(typeof PLAN_WORKFLOW_TOOL_DEFINITION.description).toBe('string');
    expect(PLAN_WORKFLOW_TOOL_DEFINITION.description.length).toBeGreaterThan(0);
  });
});

describe('handlePlanWorkflow', () => {
  const noopSubmit = vi.fn().mockResolvedValue({ planId: 'p1', stepsExecuted: 6 });

  it('returns plan without executing when execute=false', async () => {
    const result = await handlePlanWorkflow({ steps: SAMPLE_STEPS, execute: false }, noopSubmit);
    expect(result.executed).toBe(false);
    expect(result.planId).toBeTruthy();
    expect(result.summary).toContain('TLCI Plan');
    expect(result.dispatchResult).toBeUndefined();
    expect(noopSubmit).not.toHaveBeenCalled();
  });

  it('returns plan without executing when execute is omitted', async () => {
    const result = await handlePlanWorkflow({ steps: SAMPLE_STEPS }, noopSubmit);
    expect(result.executed).toBe(false);
    expect(noopSubmit).not.toHaveBeenCalled();
  });

  it('executes workflow when execute=true', async () => {
    const mockSubmit = vi.fn().mockResolvedValue({ planId: 'p1', stepsExecuted: 6 });
    const result = await handlePlanWorkflow({ steps: SAMPLE_STEPS, execute: true }, mockSubmit);
    expect(result.executed).toBe(true);
    expect(result.dispatchResult).toBeDefined();
    expect(mockSubmit).toHaveBeenCalledWith(SAMPLE_STEPS, expect.objectContaining({}));
  });

  it('reports correct tier breakdown', async () => {
    const result = await handlePlanWorkflow({ steps: SAMPLE_STEPS }, noopSubmit);
    expect(result.tierBreakdown.code).toBe(4);
    expect(result.tierBreakdown.slm).toBe(1);
    expect(result.tierBreakdown.frontier).toBe(1);
  });

  it('reports savings percentage', async () => {
    const result = await handlePlanWorkflow({ steps: SAMPLE_STEPS }, noopSubmit);
    expect(result.savingsPct).toBeGreaterThan(90);
  });

  it('passes budgetLimitUSD to submitWorkflow', async () => {
    const mockSubmit = vi.fn().mockResolvedValue({});
    await handlePlanWorkflow({ steps: SAMPLE_STEPS, execute: true, budgetLimitUSD: 0.05 }, mockSubmit);
    expect(mockSubmit).toHaveBeenCalledWith(SAMPLE_STEPS, { budgetLimitUSD: 0.05 });
  });

  it('includes planHash in result', async () => {
    const result = await handlePlanWorkflow({ steps: SAMPLE_STEPS }, noopSubmit);
    expect(result.planHash).toBeTruthy();
    expect(result.planHash.length).toBe(32);
  });

  it('includes approvalView in result', async () => {
    const result = await handlePlanWorkflow({ steps: SAMPLE_STEPS }, noopSubmit);
    expect(result.approvalView).toContain('Execution Plan');
  });

  it('estimatedCostUSD is a non-negative number', async () => {
    const result = await handlePlanWorkflow({ steps: SAMPLE_STEPS }, noopSubmit);
    expect(typeof result.estimatedCostUSD).toBe('number');
    expect(result.estimatedCostUSD).toBeGreaterThanOrEqual(0);
  });
});

describe('createPlanWorkflowTool', () => {
  it('returns a CustomToolDefinition with correct name', () => {
    const tool = createPlanWorkflowTool();
    expect(tool.name).toBe(PLAN_WORKFLOW_TOOL_NAME);
  });

  it('handler calls handlePlanWorkflow and returns JSON-serializable result', async () => {
    const mockSubmit = vi.fn().mockResolvedValue({});
    const tool = createPlanWorkflowTool(mockSubmit);
    const result = await tool.handler({ steps: SAMPLE_STEPS });
    expect(result).toHaveProperty('planId');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('executed', false);
  });

  it('handler throws if no submitWorkflow and execute=true', async () => {
    const tool = createPlanWorkflowTool(); // no submitWorkflow
    await expect(
      tool.handler({ steps: SAMPLE_STEPS, execute: true }),
    ).rejects.toThrow('submitWorkflow not available');
  });
});
