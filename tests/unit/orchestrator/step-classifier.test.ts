import { describe, it, expect } from 'vitest';
import { classifyStep } from '../../../src/orchestrator/step-classifier.js';

describe('classifyStep', () => {
  describe('Tier 1 — code tools', () => {
    const tier1Cases = [
      'fetch user data from REST API',
      'get list of files in directory',
      'format JSON response as markdown table',
      'sort results by date descending',
      'filter items where status equals active',
      'send notification to Slack channel',
      'save output to results.json',
      'calculate percentage change between values',
      'parse CSV into structured array',
      'query database for user records',
    ];

    tier1Cases.forEach(description => {
      it(`classifies "${description}" as code`, () => {
        const result = classifyStep({ id: '1', description });
        expect(result.tier).toBe('code');
        expect(result.estimatedCostUSD).toBe(0);
      });
    });
  });

  describe('Tier 2 — SLM', () => {
    const tier2Cases = [
      'classify customer message as complaint or inquiry',
      'extract named entities from support ticket',
      'detect sentiment of user review',
      'categorize document into billing, technical, or general',
      'route request to appropriate team',
    ];

    tier2Cases.forEach(description => {
      it(`classifies "${description}" as slm`, () => {
        const result = classifyStep({ id: '1', description });
        expect(result.tier).toBe('slm');
        expect(result.estimatedCostUSD).toBe(0.0001);
      });
    });
  });

  describe('Tier 3 — frontier', () => {
    const tier3Cases = [
      'summarize the key findings across all documents',
      'generate a draft email explaining the situation',
      'analyze root cause of the performance regression',
      'write a technical explanation of the architecture',
      'plan the migration sequence for the database',
    ];

    tier3Cases.forEach(description => {
      it(`classifies "${description}" as frontier`, () => {
        const result = classifyStep({ id: '1', description });
        expect(result.tier).toBe('frontier');
      });
    });
  });

  describe('frontier signals override tier 1 patterns', () => {
    it('classifies "summarize fetched data" as frontier despite "fetch"', () => {
      const result = classifyStep({ id: '1', description: 'summarize fetched data from API' });
      expect(result.tier).toBe('frontier');
    });
  });
});
