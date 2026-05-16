import { test, expect } from 'bun:test';
import { createWorkerMetrics, recordEmbed, recordIndexResult } from '../../src/worker/metrics.ts';

test('createWorkerMetrics — starts all counters at zero', () => {
  const m = createWorkerMetrics();
  expect(m).toEqual({
    embedCalls: 0, embedTokens: 0, embedMs: 0,
    docsSeen: 0, docsSkippedUnchanged: 0,
  });
});

test('recordEmbed — accumulates calls, tokens and ms', () => {
  const m = createWorkerMetrics();
  recordEmbed(m, 1200, 80);
  recordEmbed(m, 800, 40);
  expect(m.embedCalls).toBe(2);
  expect(m.embedTokens).toBe(2000);
  expect(m.embedMs).toBe(120);
});

test('recordIndexResult — counts every doc, skips separately', () => {
  const m = createWorkerMetrics();
  recordIndexResult(m, 'indexed');
  recordIndexResult(m, 'skipped');
  recordIndexResult(m, 'skipped');
  expect(m.docsSeen).toBe(3);
  expect(m.docsSkippedUnchanged).toBe(2);
});
