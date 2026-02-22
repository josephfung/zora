import { describe, it, expect, beforeEach } from 'vitest';
import { ErrorNormalizer } from '../../../src/lib/error-normalizer.js';

describe('ErrorNormalizer', () => {
  let normalizer: ErrorNormalizer;

  beforeEach(() => {
    normalizer = new ErrorNormalizer();
  });

  describe('normalize()', () => {
    it('classifies 401 as AUTH_FAILURE', () => {
      const result = normalizer.normalize('HTTP 401 unauthorized');
      expect(result.category).toBe('AUTH_FAILURE');
    });

    it('classifies IndentationError as SYNTAX_ERROR', () => {
      const result = normalizer.normalize('IndentationError: expected an indented block at line 5');
      expect(result.category).toBe('SYNTAX_ERROR');
    });

    it('classifies 504 as TIMEOUT', () => {
      const result = normalizer.normalize('504 Gateway Timeout');
      expect(result.category).toBe('TIMEOUT');
    });

    it('classifies ENOENT as NOT_FOUND', () => {
      const result = normalizer.normalize("ENOENT: no such file or directory '/tmp/missing.txt'");
      expect(result.category).toBe('NOT_FOUND');
    });

    it('classifies 429 as RATE_LIMIT', () => {
      const result = normalizer.normalize('429 Too Many Requests — rate limit exceeded');
      expect(result.category).toBe('RATE_LIMIT');
    });

    it('classifies EACCES as PERMISSION_DENIED', () => {
      const result = normalizer.normalize('EACCES: permission denied');
      expect(result.category).toBe('PERMISSION_DENIED');
    });

    it('classifies ECONNREFUSED as NETWORK_ERROR', () => {
      const result = normalizer.normalize('ECONNREFUSED: connection refused at 127.0.0.1:8080');
      expect(result.category).toBe('NETWORK_ERROR');
    });

    it('classifies unrecognized errors as UNKNOWN', () => {
      const result = normalizer.normalize('something completely unexpected happened');
      expect(result.category).toBe('UNKNOWN');
    });

    it('truncates long messages to 400 chars', () => {
      const long = 'x'.repeat(500);
      const result = normalizer.normalize(long);
      expect(result.safeMessage.length).toBeLessThanOrEqual(400);
    });

    it('preserves rawMessage unchanged', () => {
      const msg = 'ENOENT: no such file or directory';
      const result = normalizer.normalize(msg);
      expect(result.rawMessage).toBe(msg);
    });
  });

  describe('normalizeError()', () => {
    it('accepts an Error object', () => {
      const err = new Error('504 timeout');
      const result = normalizer.normalizeError(err);
      expect(result.category).toBe('TIMEOUT');
    });
  });

  describe('toFailureReport()', () => {
    it('wraps error in failure_report XML', () => {
      const normalized = normalizer.normalize('IndentationError at line 5');
      const report = normalizer.toFailureReport('call_123', normalized);
      expect(report).toContain('<tool_result id="call_123" status="error">');
      expect(report).toContain('<failure_report category="SYNTAX_ERROR">');
      expect(report).toContain('</failure_report>');
      expect(report).toContain('</tool_result>');
    });

    it('escapes XML special chars in error message', () => {
      // A message with < and > would break XML if not escaped
      const normalized = normalizer.normalize('error: value < 0 && result > max');
      const report = normalizer.toFailureReport('call_1', normalized);
      expect(report).not.toContain('<0');
      expect(report).toContain('&lt;');
      expect(report).toContain('&gt;');
    });

    it('does not allow nested XML tags in failure_report content', () => {
      // Injection attempt: message contains a closing tag
      const normalized = normalizer.normalize('bad</failure_report><script>alert(1)</script>');
      const report = normalizer.toFailureReport('call_1', normalized);
      // The content should be escaped, not treated as raw XML
      expect(report).not.toMatch(/<script>/);
      expect(report).toContain('&lt;/failure_report&gt;');
    });

    it('redacts API keys from error messages', () => {
      const normalized = normalizer.normalize('auth error: sk-abcdefghijklmnopqrstu12345');
      const report = normalizer.toFailureReport('call_1', normalized);
      // The raw sk-* key should NOT appear in the report
      expect(report).not.toContain('sk-abcdefghijklmnopqrstu12345');
    });
  });
});
