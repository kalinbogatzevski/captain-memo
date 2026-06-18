// tests/unit/eval/run.test.ts
import { test, expect } from 'bun:test';
import { runEval } from '../../../src/eval/run.ts';

const golden = [
  { id: 't1', query: 'latest talq', class: 'temporal' as const, entity: 'talq' },
];

test('temporal: top hit is freshest → freshness@1 = 1', async () => {
  const reports = await runEval({
    golden,
    profiles: ['v2'],
    search: async () => ([
      { doc_id: 'new', created_at_epoch: 300, text: 'talq v0.51.12' },
      { doc_id: 'old', created_at_epoch: 100, text: 'talq v0.6.0' },
    ]),
  });
  expect(reports[0]!.freshnessAt1).toBe(1);
  expect(reports[0]!.stalenessRate).toBeGreaterThan(0); // 'old' is stale in top-k
});

test('temporal: stale on top → freshness@1 = 0', async () => {
  const reports = await runEval({
    golden,
    profiles: ['legacy'],
    search: async () => ([
      { doc_id: 'old', created_at_epoch: 100, text: 'talq v0.6.0' },
      { doc_id: 'new', created_at_epoch: 300, text: 'talq v0.51.12' },
    ]),
  });
  expect(reports[0]!.freshnessAt1).toBe(0);
});

test('non-temporal: judge branch scores ndcg/mrr/recall > 0, temporal metrics stay 0', async () => {
  const reports = await runEval({
    golden: [{ id: 'c1', query: 'what is memoization', class: 'conceptual' as const }],
    profiles: ['v2'],
    search: async () => ([
      { doc_id: 'd1', created_at_epoch: 100, text: 'memoization caches function results' },
      { doc_id: 'd2', created_at_epoch: 200, text: 'memoization avoids recomputation' },
    ]),
    judge: async () => 3,
  });
  const r = reports[0]!;
  expect(r.ndcg10).toBeGreaterThan(0);
  expect(r.recall10).toBeGreaterThan(0);
  expect(r.mrr).toBeGreaterThan(0);
  expect(r.freshnessAt1).toBe(0);
  expect(r.stalenessRate).toBe(0);
  expect(r.nTemporal).toBe(0);
});

test('temporal: entity-miss (no matching doc) → freshness@1 = 0, miss is counted', async () => {
  const reports = await runEval({
    golden: [{ id: 't2', query: 'latest flux release', class: 'temporal' as const, entity: 'flux' }],
    profiles: ['v2'],
    // search returns docs that do NOT mention 'flux'
    search: async () => ([
      { doc_id: 'x1', created_at_epoch: 100, text: 'unrelated doc about helm' },
      { doc_id: 'x2', created_at_epoch: 200, text: 'another unrelated doc about argo' },
    ]),
  });
  const r = reports[0]!;
  expect(r.freshnessAt1).toBe(0);
  expect(r.nTemporal).toBe(1);
});
