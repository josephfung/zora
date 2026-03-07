/**
 * PlanningTool — Exposes TLCI's buildExecutionPlan as a callable LLM tool.
 *
 * The LLM can call plan_workflow to decompose a multi-step task into TLCI tiers,
 * see the cost estimate, and optionally execute it. Makes TLCI self-driving.
 *
 * Usage by the LLM:
 *   plan_workflow({ steps: [{id:"1", description:"fetch user data from API"},...] })
 *   → returns plan summary + estimated cost
 *   plan_workflow({ steps: [...], execute: true })
 *   → returns plan + executes it via submitWorkflow
 */

import { buildExecutionPlan, formatPlanSummary, formatPlanForApproval } from '../orchestrator/execution-planner.js';
import type { DispatchResult } from '../orchestrator/tlci-dispatcher.js';
import type { WorkflowStep } from '../orchestrator/step-classifier.js';
import type { CustomToolDefinition } from '../orchestrator/execution-loop.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('planning-tool');

// ─── Tool Name ────────────────────────────────────────────────────────────────

export const PLAN_WORKFLOW_TOOL_NAME = 'plan_workflow';

// ─── Tool Definition (JSON Schema for the LLM) ────────────────────────────────

export const PLAN_WORKFLOW_TOOL_DEFINITION = {
  name: PLAN_WORKFLOW_TOOL_NAME,
  description: [
    'Decompose the current task into discrete workflow steps for cost-efficient execution.',
    'Use when the task involves multiple operations (fetch → transform → classify → summarize → send).',
    'Returns an execution plan showing which steps run as code tools (free), local SLM ($0.0001/step),',
    'or frontier LLM ($0.003/step), with total estimated cost vs running everything through a frontier LLM.',
  ].join(' '),
  input_schema: {
    type: 'object' as const,
    properties: {
      steps: {
        type: 'array',
        description: 'Ordered workflow steps. Earlier steps may feed context to later ones.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique step identifier (e.g. "1", "fetch")' },
            description: { type: 'string', description: 'Natural language description of this step' },
            inputType: { type: 'string', description: 'Optional: url | json | text | fileList' },
            outputType: { type: 'string', description: 'Optional: json | text | boolean | void' },
          },
          required: ['id', 'description'],
        },
        minItems: 1,
      },
      execute: {
        type: 'boolean',
        description: 'If true, execute the plan immediately. If false (default), return plan for review.',
        default: false,
      },
      budgetLimitUSD: {
        type: 'number',
        description: 'Optional: abort if estimated cost exceeds this amount.',
      },
    },
    required: ['steps'],
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlanWorkflowArgs {
  steps: WorkflowStep[];
  execute?: boolean;
  budgetLimitUSD?: number;
}

export interface PlanWorkflowResult {
  planId: string;
  planHash: string;
  summary: string;
  approvalView: string;
  tierBreakdown: { code: number; slm: number; frontier: number };
  estimatedCostUSD: number;
  savingsPct: number;
  executed: boolean;
  dispatchResult?: unknown;
}

// ─── Submit function type ─────────────────────────────────────────────────────

export type SubmitWorkflowFn = (
  steps: WorkflowStep[],
  opts?: { budgetLimitUSD?: number },
) => Promise<DispatchResult>;

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handlePlanWorkflow(
  args: PlanWorkflowArgs,
  submitWorkflow: SubmitWorkflowFn,
): Promise<PlanWorkflowResult> {
  const { steps, execute = false, budgetLimitUSD } = args;

  log.info({ steps: steps.length, execute, budgetLimitUSD }, 'plan_workflow called');

  // Always build plan first to show cost/tier breakdown
  const plan = buildExecutionPlan(steps);
  const summary = formatPlanSummary(plan);
  const approvalView = formatPlanForApproval(plan);

  if (!execute) {
    return {
      planId: plan.planId,
      planHash: plan.planHash,
      summary,
      approvalView,
      tierBreakdown: plan.tierBreakdown,
      estimatedCostUSD: plan.costComparison.tlciEstimate,
      savingsPct: plan.costComparison.savingsPct,
      executed: false,
    };
  }

  // Execute via orchestrator's submitWorkflow.
  // The dispatcher uses the plan cache, so the same steps will reuse the preview plan's
  // hash. Use the DispatchResult's planId/planHash as the authoritative IDs to avoid
  // exposing a preview planId that differs from the executed plan's ID.
  const dispatchResult = await submitWorkflow(steps, { budgetLimitUSD });

  return {
    planId: dispatchResult.planId,
    planHash: dispatchResult.planHash,
    summary,
    approvalView,
    tierBreakdown: dispatchResult.tierBreakdown,
    estimatedCostUSD: plan.costComparison.tlciEstimate,
    savingsPct: plan.costComparison.savingsPct,
    executed: true,
    dispatchResult,
  };
}

// ─── Factory: build a CustomToolDefinition wired to a submitWorkflow callback ─

/**
 * Create a plan_workflow CustomToolDefinition bound to the given submitWorkflow function.
 * Pass this into ExecutionLoop's customTools array (via _createCustomTools).
 *
 * If submitWorkflow is not provided (plan-only mode), execution requests will
 * throw a clear error instead of silently failing.
 */
export function createPlanWorkflowTool(
  submitWorkflow?: SubmitWorkflowFn,
): CustomToolDefinition {
  const noopOrReal: SubmitWorkflowFn = submitWorkflow ?? (async (_steps, _opts) => {
    throw new Error(
      'plan_workflow: submitWorkflow not available — boot the orchestrator first or set execute:false',
    );
  });

  return {
    name: PLAN_WORKFLOW_TOOL_DEFINITION.name,
    description: PLAN_WORKFLOW_TOOL_DEFINITION.description,
    input_schema: PLAN_WORKFLOW_TOOL_DEFINITION.input_schema,
    handler: async (input: Record<string, unknown>) => {
      const args = input as unknown as PlanWorkflowArgs;
      return handlePlanWorkflow(args, noopOrReal);
    },
  };
}
