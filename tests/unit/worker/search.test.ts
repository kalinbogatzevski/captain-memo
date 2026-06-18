import { test, expect } from 'bun:test';
import { HybridSearcher } from '../../../src/worker/search.ts';

function makeSearcher(capture: { vK?: number; kK?: number }) {
  return new HybridSearcher({
    vectorSearch: async (_emb, k) => { capture.vK = k; return [{ id: 'a', distance: 0.1 }]; },
    keywordSearch: async (_q, k) => { capture.kK = k; return [{ chunk_id: 'a', rank: -5 }]; },
  });
}

test('per-call perStrategyTopK overrides the constructor default', async () => {
  const cap: { vK?: number; kK?: number } = {};
  const s = makeSearcher(cap);
  await s.search([0.1], 'q', 5, { perStrategyTopK: 7 });
  expect(cap.vK).toBe(7);
  expect(cap.kK).toBe(7);
});

test('absent per-call values fall back to constructor defaults (25)', async () => {
  const cap: { vK?: number; kK?: number } = {};
  const s = makeSearcher(cap);
  await s.search([0.1], 'q', 5);
  expect(cap.vK).toBe(25);
  expect(cap.kK).toBe(25);
});

test('weighted fusionMode ranks by blended magnitude, not RRF rank', async () => {
  // vector says B is far better (distance 0 vs 1.9); keyword ranks A first.
  // RRF (rank-only) would favor A by rank; weighted must favor B's magnitude.
  const s = new HybridSearcher({
    vectorSearch: async () => [{ id: 'A', distance: 1.9 }, { id: 'B', distance: 0.0 }],
    keywordSearch: async () => [{ chunk_id: 'A', rank: -9 }, { chunk_id: 'B', rank: -1 }],
  });
  const out = await s.search([0.1], 'q', 10, { fusionMode: 'weighted', vectorWeight: 0.9, keywordWeight: 0.1 });
  expect(out[0]!.id).toBe('B');
});

test('default/rrf fusionMode is unchanged (rank-based)', async () => {
  const s = new HybridSearcher({
    vectorSearch: async () => [{ id: 'A', distance: 1.9 }, { id: 'B', distance: 0.0 }],
    keywordSearch: async () => [{ chunk_id: 'A', rank: -9 }, { chunk_id: 'B', rank: -1 }],
  });
  // A is rank-1 in both lists → RRF puts A first regardless of magnitude.
  const out = await s.search([0.1], 'q', 10);
  expect(out[0]!.id).toBe('A');
});
