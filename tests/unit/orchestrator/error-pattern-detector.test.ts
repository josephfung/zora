import { describe, it, expect, beforeEach } from 'vitest';
import { ErrorPatternDetector } from '../../../src/orchestrator/error-pattern-detector.js';

describe('ErrorPatternDetector', () => {
  let detector: ErrorPatternDetector;

  beforeEach(() => {
    detector = new ErrorPatternDetector();
  });

  it('returns isRepeating=false for a single failure', () => {
    const result = detector.record('read_file', { path: '/foo.txt' }, false);
    expect(result.isRepeating).toBe(false);
  });

  it('returns isRepeating=true after same tool+args fails twice', () => {
    detector.record('read_file', { path: '/foo.txt' }, false);
    const result = detector.record('read_file', { path: '/foo.txt' }, false);
    expect(result.isRepeating).toBe(true);
    expect(result.toolName).toBe('read_file');
  });

  it('hint contains the tool name and mandatory instruction', () => {
    detector.record('read_file', { path: '/foo.txt' }, false);
    const result = detector.record('read_file', { path: '/foo.txt' }, false);
    expect(result.hint).toContain('read_file');
    expect(result.hint).toContain('MUST');
  });

  it('does not fire for different args on same tool', () => {
    detector.record('read_file', { path: '/foo.txt' }, false);
    const result = detector.record('read_file', { path: '/bar.txt' }, false);
    expect(result.isRepeating).toBe(false);
  });

  it('fires when two failures appear in the window even with a success between them', () => {
    // The detector counts all failures for the signature in the rolling window.
    // A success does not clear earlier failures — it just adds a non-failing entry.
    detector.record('read_file', { path: '/foo.txt' }, false); // failure #1
    detector.record('read_file', { path: '/foo.txt' }, true);  // success (no reset)
    const result = detector.record('read_file', { path: '/foo.txt' }, false); // failure #2
    // Window has 2 failures → isRepeating=true per spec ("appears twice with an error")
    expect(result.isRepeating).toBe(true);
  });

  it('rolling window drops oldest entries after WINDOW_SIZE', () => {
    // Fill window with 5 OTHER tool calls
    for (let i = 0; i < 5; i++) {
      detector.record(`tool_${i}`, { i }, false);
    }
    // Now add a single failure for read_file — oldest read_file failure was evicted
    const result = detector.record('read_file', { path: '/foo.txt' }, false);
    expect(result.isRepeating).toBe(false); // only 1 entry in window
  });

  it('reset() clears the window', () => {
    detector.record('read_file', { path: '/foo.txt' }, false);
    detector.reset();
    detector.record('read_file', { path: '/foo.txt' }, false);
    const result = detector.record('read_file', { path: '/foo.txt' }, false);
    // After reset, only 2 failures recorded
    expect(result.isRepeating).toBe(true); // 2 failures after reset triggers it
  });

  it('produces same signature regardless of arg key order', () => {
    detector.record('tool', { a: 1, b: 2 }, false);
    const result = detector.record('tool', { b: 2, a: 1 }, false);
    expect(result.isRepeating).toBe(true);
  });

  it('getWindow() returns current entries', () => {
    detector.record('tool_a', {}, true);
    detector.record('tool_b', {}, false);
    expect(detector.getWindow().length).toBe(2);
  });
});
