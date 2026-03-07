/**
 * StepClassifier — Classifies workflow steps into TLCI tiers.
 * Tier 1: Code tools (free), Tier 2: Ollama SLM (~$0.0001), Tier 3: Frontier LLM (~$0.003)
 */

export type StepTier = 'code' | 'slm' | 'frontier';

export interface WorkflowStep {
  id: string;
  description: string;
  inputType?: string;
  outputType?: string;
  context?: Record<string, unknown>;
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

interface TierPattern {
  pattern: RegExp;
  toolHint?: string;
}

const TIER1_PATTERNS: TierPattern[] = [
  { pattern: /\bfetch\b|\bget\b|\bretrieve\b|\bdownload\b|\bread file\b|\bload\b/i, toolHint: 'httpFetch' },
  { pattern: /\bsend\b|\bpost\b|\bwrite\b|\bsave\b|\bstore\b|\bupload\b/i, toolHint: 'httpPost' },
  { pattern: /\bformat\b|\btransform\b|\bconvert\b|\bparse\b|\bserializ/i, toolHint: 'transform' },
  { pattern: /\bextract field\b|\bmap field\b|\bpick field\b|\bselect field\b/i, toolHint: 'transform' },
  { pattern: /\bsort\b|\bfilter\b|\bdeduplic\b|\bgroup by\b|\bcount\b|\bsum\b/i, toolHint: 'collectionOp' },
  { pattern: /\bquery database\b|\bsql\b|\bdb lookup\b/i, toolHint: 'dbQuery' },
  { pattern: /\bcalculate\b|\bcompute\b|\barithmetic\b|\bthreshold check\b/i, toolHint: 'compute' },
  { pattern: /\blist files\b|\bread directory\b|\bcopy file\b|\bmove file\b|\bdelete file\b/i, toolHint: 'fileOp' },
  { pattern: /\bsend notification\b|\bsend email\b|\bsend slack\b|\bwebhook\b/i, toolHint: 'notify' },
  { pattern: /\bvalidate schema\b|\bcheck format\b|\bparse json\b|\bvalidate url\b/i, toolHint: 'validate' },
];

const TIER2_PATTERNS: RegExp[] = [
  /\bclassify\b|\bcategorize\b|\blabel\b/i,
  /\bextract.*entit(y|ies)\b/i,
  /\bsentiment\b|\btone detect/i,
  /\bintent detect\b|\bintent classif/i,
  /\broute\b|\bassign to\b|\bdispatch to\b/i,
  /\bsimple decision\b|\bbinary decision\b/i,
  /\bkeyword extract\b|\btag extract\b/i,
  /\blanguage detect\b/i,
  /\bpii detect\b|\bsensitive data check\b/i,
];

const FRONTIER_SIGNALS: RegExp[] = [
  /\bsummariz|\bsynthesize\b/i,
  /\bgenerate\b|\bwrite\b|\bcompose\b|\bdraft\b/i,
  /\bexplain\b|\banalyze\b|\bdiagnose\b|\bdebug\b/i,
  /\breason\b|\bplan\b|\bstrateg/i,
  /\bcreative\b|\bbrainstorm\b/i,
  /\bcomplex decision\b|\bnuanced\b|\bsubjective\b/i,
  /\bcode review\b|\bcode generation\b/i,
];

export function classifyStep(step: WorkflowStep): StepClassification {
  const desc = step.description;

  for (const pattern of FRONTIER_SIGNALS) {
    if (pattern.test(desc)) {
      return {
        tier: 'frontier',
        rationale: `Contains frontier signal: "${pattern.source}"`,
        estimatedCostUSD: 0.003,
        confidence: 'high',
      };
    }
  }

  for (const { pattern, toolHint } of TIER1_PATTERNS) {
    if (pattern.test(desc)) {
      return {
        tier: 'code',
        rationale: `Deterministic operation matches code-tool pattern: "${pattern.source}"`,
        estimatedCostUSD: 0,
        suggestedCodeTool: toolHint,
        confidence: 'high',
      };
    }
  }

  for (const pattern of TIER2_PATTERNS) {
    if (pattern.test(desc)) {
      return {
        tier: 'slm',
        rationale: `Classification/extraction task suitable for local SLM`,
        estimatedCostUSD: 0.0001,
        suggestedSLMPrompt: `Classify the following: ${desc}`,
        confidence: 'medium',
      };
    }
  }

  return {
    tier: 'frontier',
    rationale: 'No tier pattern matched — defaulting to frontier (review this step)',
    estimatedCostUSD: 0.003,
    confidence: 'low',
  };
}

export function classifySteps(steps: WorkflowStep[]): ClassifiedStep[] {
  return steps.map(step => ({ ...step, ...classifyStep(step) }));
}
