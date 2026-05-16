import { test, expect } from 'bun:test';
import { computeEfficiency } from '../../src/worker/efficiency.ts';
import { createWorkerMetrics, recordEmbed, recordIndexResult } from '../../src/worker/metrics.ts';

test('computeEfficiency — paired corpus produces ratio and saved_pct', () => {
  const r = computeEfficiency({
    workSum: 160000, storedSum: 10000, pairedCount: 300,
    totalObservations: 320, metrics: createWorkerMetrics(),
  });
  expect(r.corpus.ratio).toBe(16);
  expect(r.corpus.saved_pct).toBe(94);
  expect(r.corpus.coverage).toEqual({ with_data: 300, total: 320 });
});

test('computeEfficiency — zero paired rows yields null ratio (no misleading number)', () => {
  const r = computeEfficiency({
    workSum: 0, storedSum: 0, pairedCount: 0,
    totalObservations: 40, metrics: createWorkerMetrics(),
  });
  expect(r.corpus.ratio).toBeNull();
  expect(r.corpus.saved_pct).toBeNull();
  expect(r.corpus.coverage).toEqual({ with_data: 0, total: 40 });
});

test('computeEfficiency — stored larger than work clamps saved_pct to 0', () => {
  const r = computeEfficiency({
    workSum: 100, storedSum: 250, pairedCount: 1,
    totalObservations: 1, metrics: createWorkerMetrics(),
  });
  expect(r.corpus.saved_pct).toBe(0);
  expect(r.corpus.ratio).toBe(0.4);
});

test('computeEfficiency — embedder + dedup derived from metrics', () => {
  const m = createWorkerMetrics();
  recordEmbed(m, 8000, 2000);
  recordEmbed(m, 2000, 500);
  recordIndexResult(m, 'indexed');
  recordIndexResult(m, 'skipped');
  recordIndexResult(m, 'skipped');
  recordIndexResult(m, 'skipped');

  const r = computeEfficiency({
    workSum: 0, storedSum: 0, pairedCount: 0,
    totalObservations: 0, metrics: m,
  });
  expect(r.embedder).toEqual({ calls: 2, avg_latency_ms: 1250, tokens_per_s: 4000 });
  expect(r.dedup).toEqual({ docs_seen: 4, skipped_unchanged: 3, skip_pct: 75 });
});

test('computeEfficiency — zero embedder/dedup activity does not divide by zero', () => {
  const r = computeEfficiency({
    workSum: 0, storedSum: 0, pairedCount: 0,
    totalObservations: 0, metrics: createWorkerMetrics(),
  });
  expect(r.embedder).toEqual({ calls: 0, avg_latency_ms: 0, tokens_per_s: 0 });
  expect(r.dedup).toEqual({ docs_seen: 0, skipped_unchanged: 0, skip_pct: 0 });
});
