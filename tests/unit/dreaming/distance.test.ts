// tests/unit/dreaming/distance.test.ts
//
// Tests for the Local Dreaming distance/similarity primitives. Each signal
// is checked independently, then the weighted combiner is exercised under
// (a) all three signals present and (b) semantic absent (renormalized).

import { test, expect } from 'bun:test';
import {
  temporalSimilarity,
  coRetrievalSimilarity,
  weightedSimilarity,
  similarityToDistance,
  DEFAULT_WEIGHTS,
} from '../../../src/dreaming/distance.ts';

const DAY = 24 * 60 * 60;

test('temporalSimilarity — identical timestamps → 1', () => {
  expect(temporalSimilarity(1_000_000, 1_000_000)).toBe(1);
});

test('temporalSimilarity — one tau apart → 1/e (~0.368)', () => {
  const t = 7 * DAY;
  expect(temporalSimilarity(0, t)).toBeCloseTo(1 / Math.E, 4);
});

test('temporalSimilarity — symmetric in argument order', () => {
  const a = 1_000_000;
  const b = 1_000_000 + 3 * DAY;
  expect(temporalSimilarity(a, b)).toBe(temporalSimilarity(b, a));
});

test('coRetrievalSimilarity — zero surfaces on either side → 0', () => {
  expect(coRetrievalSimilarity(0, 0, 5)).toBe(0);
  expect(coRetrievalSimilarity(0, 5, 0)).toBe(0);
});

test('coRetrievalSimilarity — full overlap (always co-surfaced) → 1', () => {
  // Both surfaced 5 times, all 5 together → Jaccard = 5/5 = 1.
  expect(coRetrievalSimilarity(5, 5, 5)).toBe(1);
});

test('coRetrievalSimilarity — no overlap → 0', () => {
  // a surfaced 5 times, b surfaced 5 times, never together → 0 / 10 = 0.
  expect(coRetrievalSimilarity(0, 5, 5)).toBe(0);
});

test('coRetrievalSimilarity — partial overlap is Jaccard-bounded', () => {
  // a:10, b:10, together:5 → 5 / (10 + 10 - 5) = 5/15 ≈ 0.333.
  expect(coRetrievalSimilarity(5, 10, 10)).toBeCloseTo(1 / 3, 4);
});

test('weightedSimilarity — all three signals at 1 → 1.0 (sums to weights total)', () => {
  expect(
    weightedSimilarity({ semantic: 1, temporal: 1, coRetrieval: 1 }),
  ).toBeCloseTo(1, 6);
});

test('weightedSimilarity — semantic null renormalizes remaining weights', () => {
  // With semantic null: temporal weight 0.3 / 0.8 = 0.375; coRetrieval 0.5/0.8 = 0.625.
  // Both signals at 1 should still sum to 1.0 — renormalization invariant.
  expect(
    weightedSimilarity({ semantic: null, temporal: 1, coRetrieval: 1 }),
  ).toBeCloseTo(1, 6);
});

test('weightedSimilarity — semantic null with only coRetrieval=1 → 0.625', () => {
  expect(
    weightedSimilarity({ semantic: null, temporal: 0, coRetrieval: 1 }),
  ).toBeCloseTo(0.625, 4);
});

test('weightedSimilarity — semantic at -1 (cosine min) maps to 0 before weighting', () => {
  // Cosine -1 → 0 after mapping; only temporal+coRet contribute.
  expect(
    weightedSimilarity({ semantic: -1, temporal: 1, coRetrieval: 1 }),
  ).toBeCloseTo(0.8, 6);   // 0.3 + 0.5 = 0.8; semantic contributes 0.
});

test('weightedSimilarity — custom weights are honored', () => {
  const w = { semantic: 0, temporal: 1, coRetrieval: 0 };
  expect(weightedSimilarity({ semantic: 1, temporal: 0.5, coRetrieval: 1 }, w))
    .toBeCloseTo(0.5, 6);
});

test('similarityToDistance — 0 ↔ 1, 1 ↔ 0, clipped', () => {
  expect(similarityToDistance(1)).toBe(0);
  expect(similarityToDistance(0)).toBe(1);
  expect(similarityToDistance(0.65)).toBeCloseTo(0.35, 6);
  expect(similarityToDistance(-1)).toBe(1);    // clipped
  expect(similarityToDistance(2)).toBe(0);     // clipped
});

test('DEFAULT_WEIGHTS — co-retrieval is the dominant signal per spec', () => {
  expect(DEFAULT_WEIGHTS.coRetrieval).toBeGreaterThan(DEFAULT_WEIGHTS.temporal);
  expect(DEFAULT_WEIGHTS.temporal).toBeGreaterThan(DEFAULT_WEIGHTS.semantic);
  expect(
    DEFAULT_WEIGHTS.semantic + DEFAULT_WEIGHTS.temporal + DEFAULT_WEIGHTS.coRetrieval,
  ).toBeCloseTo(1, 6);
});
