import { test, expect } from 'bun:test';
import { clamp01, cosineFromDistance, weightedFusion } from '../../../src/worker/search.ts';

test('cosineFromDistance: identical vectors (distance 0) → 1; clamps', () => {
  expect(cosineFromDistance(0)).toBe(1);
  expect(clamp01(2)).toBe(1);
  expect(clamp01(-1)).toBe(0);
});

test('weighted blend: doc in both legs uses w_v·sem + w_k·kw', () => {
  // one vector hit distance 0 → sem 1; one keyword hit (only one → kw 1.0)
  const out = weightedFusion(
    [{ id: 'a', distance: 0 }],
    [{ chunk_id: 'a', rank: -5 }],
    { vectorWeight: 0.7, keywordWeight: 0.3 },
  );
  expect(out[0]!.id).toBe('a');
  expect(out[0]!.score).toBeCloseTo(1.0, 6); // 0.7*1 + 0.3*1
});

test('bm25 min-max is sign-safe (more negative = better → 1)', () => {
  const out = weightedFusion(
    [],
    [{ chunk_id: 'best', rank: -10 }, { chunk_id: 'worst', rank: -1 }],
    { vectorWeight: 0.7, keywordWeight: 0.3 },
  );
  const best = out.find(x => x.id === 'best')!;
  const worst = out.find(x => x.id === 'worst')!;
  expect(best.score).toBeGreaterThan(worst.score); // keyword-only → present-leg value (1 vs 0)
  expect(best.score).toBeCloseTo(1, 6);
  expect(worst.score).toBeCloseTo(0, 6);
});

test('vector-only doc gets full redistributed weight (sem, not w_v·sem)', () => {
  const out = weightedFusion(
    [{ id: 'v', distance: 0 }],
    [],
    { vectorWeight: 0.7, keywordWeight: 0.3 },
  );
  expect(out[0]!.score).toBeCloseTo(1, 6); // sem=1 used directly, not 0.7
});

test('single keyword hit (rank_min === rank_max) → 1.0, no divide-by-zero', () => {
  const out = weightedFusion([], [{ chunk_id: 'only', rank: -3 }], { vectorWeight: 0.7, keywordWeight: 0.3 });
  expect(out[0]!.score).toBeCloseTo(1, 6);
});
