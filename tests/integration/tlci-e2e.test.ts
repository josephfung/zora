/**
 * TLCI End-to-End Integration Tests
 *
 * Tests the full TLCI stack without hitting any LLM APIs:
 *   - Step classification → tier assignment
 *   - ExecutionPlan building → cost estimate → hash
 *   - TLCIDispatcher dry-run → DispatchResult
 *   - Plan cache hit on second identical dispatch
 *   - Budget limit enforcement
 *   - Real code tool execution (httpFetch, transform, collectionOp, fileOp, compute, validate)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { classifyStep, classifySteps } from '../../src/orchestrator/step-classifier.js';
import { buildExecutionPlan, formatPlanForApproval } from '../../src/orchestrator/execution-planner.js';
import { TLCIDispatcher } from '../../src/orchestrator/tlci-dispatcher.js';
import { PlanCache } from '../../src/memory/plan-cache.js';
import { runCodeTool } from '../../src/orchestrator/code-tool-runner.js';

// ─── Sample 6-step workflow matching spec §9 success criterion ─────────────────
// Expected: fetch→code, filter→code, classify→slm, summarize→frontier, format→code, send→code
// = 3 code + 1 SLM + 1 frontier + 1 code  (total 4 code, 1 SLM, 1 frontier)

const SPEC_STEPS = [
  { id: '1', description: 'fetch user records from the REST API' },
  { id: '2', description: 'filter records where subscription status is active' },
  { id: '3', description: 'classify each user intent from their last message' },
  { id: '4', description: 'summarize top issues across all users' },
  { id: '5', description: 'format summary as HTML report' },
  { id: '6', description: 'send report to Slack channel via webhook' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePlanCache(dir: string) {
  return new PlanCache(dir);
}

function makeDispatcher(cache: PlanCache, runners?: {
  code?: (s: Parameters<typeof runCodeTool>[0]) => Promise<unknown>;
  slm?: () => Promise<unknown>;
  frontier?: () => Promise<unknown>;
}) {
  const codeRuns: string[] = [];
  const slmRuns: string[] = [];
  const frontierRuns: string[] = [];

  const dispatcher = new TLCIDispatcher(
    cache,
    { autonomyLevel: 'full' },
    async (step) => { codeRuns.push(step.id); return runners?.code?.(step as never) ?? null; },
    async (step) => { slmRuns.push(step.id); return runners?.slm?.() ?? null; },
    async (step) => { frontierRuns.push(step.id); return runners?.frontier?.() ?? null; },
    async () => true,
  );

  return { dispatcher, codeRuns, slmRuns, frontierRuns };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

let testCacheDir: string;

beforeAll(async () => {
  testCacheDir = path.join(os.tmpdir(), `tlci-test-${Date.now()}`);
  await fs.mkdir(testCacheDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(testCacheDir, { recursive: true, force: true });
});

// ─── Classification tests ──────────────────────────────────────────────────────

describe('step classification', () => {
  it('classifies the 6-step spec workflow correctly', () => {
    const results = classifySteps(SPEC_STEPS);
    const tiers = results.map(r => r.tier);

    expect(tiers[0]).toBe('code');      // fetch
    expect(tiers[1]).toBe('code');      // filter
    expect(tiers[2]).toBe('slm');       // classify
    expect(tiers[3]).toBe('frontier');  // summarize
    expect(tiers[4]).toBe('code');      // format
    expect(tiers[5]).toBe('code');      // send (webhook)
  });

  it('assigns zero cost to code steps', () => {
    const result = classifyStep({ id: '1', description: 'fetch data from API' });
    expect(result.estimatedCostUSD).toBe(0);
    expect(result.tier).toBe('code');
  });

  it('assigns $0.0001 to SLM steps', () => {
    const result = classifyStep({ id: '1', description: 'classify intent of customer message' });
    expect(result.estimatedCostUSD).toBe(0.0001);
    expect(result.tier).toBe('slm');
  });

  it('frontier signals always override code patterns', () => {
    // "summarize" should win over "fetch"
    const result = classifyStep({ id: '1', description: 'fetch and summarize data from API' });
    expect(result.tier).toBe('frontier');
  });
});

// ─── Plan building tests ───────────────────────────────────────────────────────

describe('execution plan', () => {
  it('matches spec §9 tier distribution: 4 code, 1 SLM, 1 frontier', () => {
    const plan = buildExecutionPlan(SPEC_STEPS);
    expect(plan.tierBreakdown.code).toBe(4);
    expect(plan.tierBreakdown.slm).toBe(1);
    expect(plan.tierBreakdown.frontier).toBe(1);
  });

  it('TLCI estimate is substantially less than all-LLM', () => {
    const plan = buildExecutionPlan(SPEC_STEPS);
    // 4 code ($0) + 1 SLM ($0.0001) + 1 frontier ($0.003) = $0.0031
    // vs 6 × $0.065 = $0.39 all-LLM
    expect(plan.costComparison.tlciEstimate).toBeCloseTo(0.0031, 4);
    expect(plan.costComparison.savingsPct).toBeGreaterThan(95);
  });

  it('plan hash is deterministic', () => {
    const p1 = buildExecutionPlan(SPEC_STEPS);
    const p2 = buildExecutionPlan(SPEC_STEPS);
    expect(p1.planHash).toBe(p2.planHash);
  });

  it('different steps produce different hash', () => {
    const p1 = buildExecutionPlan(SPEC_STEPS);
    const p2 = buildExecutionPlan([...SPEC_STEPS, { id: '7', description: 'archive old records' }]);
    expect(p1.planHash).not.toBe(p2.planHash);
  });

  it('approval format contains cost and tier breakdown', () => {
    const plan = buildExecutionPlan(SPEC_STEPS);
    const msg = formatPlanForApproval(plan);
    expect(msg).toContain('$');
    expect(msg).toContain('savings');
    expect(msg).toContain('CODE');
    expect(msg).toContain('SLM');
    expect(msg).toContain('AI');
  });
});

// ─── Dispatcher dry-run tests ──────────────────────────────────────────────────

describe('tlci dispatcher — dry-run', () => {
  it('dry-run returns planId and savings without executing steps', async () => {
    const cache = makePlanCache(testCacheDir);
    await cache.init();
    const { dispatcher, codeRuns, slmRuns, frontierRuns } = makeDispatcher(cache);

    const result = await dispatcher.dispatch(SPEC_STEPS, { dryRun: true });

    expect(result.stepsExecuted).toBe(0);
    expect(result.planId).toMatch(/^plan_/);
    expect(result.savedVsAllLLM).toBeGreaterThan(0.3);
    expect(result.tierBreakdown.code).toBe(4);
    expect(codeRuns.length).toBe(0);
    expect(slmRuns.length).toBe(0);
    expect(frontierRuns.length).toBe(0);
  });

  it('live dispatch calls correct number of runners per tier', async () => {
    const cache = makePlanCache(testCacheDir);
    await cache.init();
    const { dispatcher, codeRuns, slmRuns, frontierRuns } = makeDispatcher(cache);

    const result = await dispatcher.dispatch(SPEC_STEPS);

    expect(result.stepsExecuted).toBe(6);
    expect(codeRuns.length).toBe(4);
    expect(slmRuns.length).toBe(1);
    expect(frontierRuns.length).toBe(1);
  });
});

// ─── Plan cache tests ──────────────────────────────────────────────────────────

describe('plan cache', () => {
  it('second dispatch gets a cache hit', async () => {
    const cacheDir = path.join(testCacheDir, 'cache-hit-test');
    await fs.mkdir(cacheDir, { recursive: true });
    const cache = makePlanCache(cacheDir);
    await cache.init();
    const { dispatcher } = makeDispatcher(cache);

    const r1 = await dispatcher.dispatch(SPEC_STEPS, { dryRun: true });
    const r2 = await dispatcher.dispatch(SPEC_STEPS, { dryRun: true });

    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(true);
    expect(r1.planHash).toBe(r2.planHash);
  });

  it('skipCacheFor bypasses cache', async () => {
    const cacheDir = path.join(testCacheDir, 'skip-cache-test');
    await fs.mkdir(cacheDir, { recursive: true });
    const cache = makePlanCache(cacheDir);
    await cache.init();
    const { dispatcher } = makeDispatcher(cache);

    const r1 = await dispatcher.dispatch(SPEC_STEPS, { dryRun: true });
    const r2 = await dispatcher.dispatch(SPEC_STEPS, { dryRun: true, skipCacheFor: [r1.planHash] });

    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(false);
  });

  it('getStats reflects stored plan count', async () => {
    const cacheDir = path.join(testCacheDir, 'stats-test');
    await fs.mkdir(cacheDir, { recursive: true });
    const cache = makePlanCache(cacheDir);
    await cache.init();
    const { dispatcher } = makeDispatcher(cache);

    await dispatcher.dispatch(SPEC_STEPS, { dryRun: true });

    const stats = await cache.getStats();
    expect(stats.totalCachedPlans).toBe(1);
  });
});

// ─── Budget limit tests ────────────────────────────────────────────────────────

describe('budget limit', () => {
  it('aborts when estimated cost exceeds budgetLimitUSD', async () => {
    const cache = makePlanCache(testCacheDir);
    await cache.init();
    const { dispatcher } = makeDispatcher(cache);

    // $0.001 limit — TLCI estimate ~$0.0031, should abort
    await expect(
      dispatcher.dispatch(SPEC_STEPS, { dryRun: true, budgetLimitUSD: 0.001 })
    ).rejects.toThrow(/exceeds budget limit/);
  });

  it('proceeds when estimated cost is within budget', async () => {
    const cache = makePlanCache(testCacheDir);
    await cache.init();
    const { dispatcher } = makeDispatcher(cache);

    // $0.01 limit — TLCI estimate ~$0.0031, should pass
    const result = await dispatcher.dispatch(SPEC_STEPS, { dryRun: true, budgetLimitUSD: 0.01 });
    expect(result.stepsExecuted).toBe(0); // dry-run
    expect(result.planId).toBeTruthy();
  });
});

// ─── Code tool tests ───────────────────────────────────────────────────────────

describe('code tools', () => {
  it('transform: json-stringify', async () => {
    const result = await runCodeTool('transform', { data: { a: 1 }, operation: 'json-stringify' });
    expect(result.success).toBe(true);
    expect(result.data).toContain('"a"');
  });

  it('transform: json-parse', async () => {
    const result = await runCodeTool('transform', { data: '{"x":42}', operation: 'json-parse' });
    expect(result.success).toBe(true);
    expect((result.data as { x: number }).x).toBe(42);
  });

  it('collectionOp: count', async () => {
    const result = await runCodeTool('collectionOp', { data: [1, 2, 3], operation: 'count' });
    expect(result.success).toBe(true);
    expect(result.data).toBe(3);
  });

  it('collectionOp: filter by key', async () => {
    const data = [{ status: 'active' }, { status: 'inactive' }, { status: 'active' }];
    const result = await runCodeTool('collectionOp', { data, operation: 'filter', key: 'status', value: 'active' });
    expect(result.success).toBe(true);
    expect((result.data as unknown[]).length).toBe(2);
  });

  it('collectionOp: deduplicate', async () => {
    const result = await runCodeTool('collectionOp', { data: [1, 2, 2, 3, 1], operation: 'deduplicate' });
    expect(result.success).toBe(true);
    expect((result.data as number[]).length).toBe(3);
  });

  it('compute: arithmetic', async () => {
    const result = await runCodeTool('compute', { expression: '(10 + 5) * 2 / 3' });
    expect(result.success).toBe(true);
    expect(result.data).toBeCloseTo(10, 5);
  });

  it('compute: rejects unsafe expressions', async () => {
    const result = await runCodeTool('compute', { expression: 'process.exit(1)' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('disallowed');
  });

  it('validate: passes when all required keys present', async () => {
    const result = await runCodeTool('validate', { data: { a: 1, b: 2 }, required: ['a', 'b'] });
    expect(result.success).toBe(true);
    expect((result.data as { valid: boolean }).valid).toBe(true);
  });

  it('validate: fails when required key missing', async () => {
    const result = await runCodeTool('validate', { data: { a: 1 }, required: ['a', 'b'] });
    expect(result.success).toBe(true);
    expect((result.data as { valid: boolean; missing: string[] }).valid).toBe(false);
    expect((result.data as { missing: string[] }).missing).toContain('b');
  });

  it('fileOp: write then read', async () => {
    const filePath = path.join(testCacheDir, 'test-write.txt');
    const writeResult = await runCodeTool('fileOp', { path: filePath, operation: 'write', content: 'hello tlci' });
    expect(writeResult.success).toBe(true);

    const readResult = await runCodeTool('fileOp', { path: filePath, operation: 'read' });
    expect(readResult.success).toBe(true);
    expect(readResult.data).toBe('hello tlci');
  });

  it('fileOp: exists returns true/false', async () => {
    const exists = await runCodeTool('fileOp', { path: testCacheDir, operation: 'exists' });
    expect(exists.success).toBe(true);
    expect(exists.data).toBe(true);

    const notExists = await runCodeTool('fileOp', { path: '/tmp/zora-tlci-definitely-not-here-xyz', operation: 'exists' });
    expect(notExists.success).toBe(true);
    expect(notExists.data).toBe(false);
  });

  it('httpFetch: fails gracefully with missing url', async () => {
    const result = await runCodeTool('httpFetch', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('context.url required');
  });

  it('notify: always succeeds', async () => {
    const result = await runCodeTool('notify', { message: 'test notification', channel: 'slack' });
    expect(result.success).toBe(true);
    expect((result.data as { sent: boolean }).sent).toBe(true);
  });
});
