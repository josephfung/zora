// Stub — full implementation in feature/tlci-foundation (will be resolved on merge)
export type StepTier = 'code' | 'slm' | 'frontier';
export interface WorkflowStep {
  id: string;
  description: string;
  inputType?: string;
  outputType?: string;
  context?: Record<string, unknown>;
  tier?: StepTier;
  estimatedCostUSD?: number;
  suggestedCodeTool?: string;
  suggestedSLMPrompt?: string;
  confidence?: 'high' | 'medium' | 'low';
  rationale?: string;
}
export interface StepClassification {
  tier: StepTier;
  rationale: string;
  estimatedCostUSD: number;
  suggestedCodeTool?: string;
  suggestedSLMPrompt?: string;
  confidence: 'high' | 'medium' | 'low';
}
export type ClassifiedStep = WorkflowStep & StepClassification;
export function classifyStep(_step: WorkflowStep): StepClassification {
  return { tier: 'frontier', rationale: 'stub', estimatedCostUSD: 0.003, confidence: 'low' };
}
export function classifySteps(steps: WorkflowStep[]): ClassifiedStep[] {
  return steps.map(s => ({ ...s, ...classifyStep(s) }));
}
