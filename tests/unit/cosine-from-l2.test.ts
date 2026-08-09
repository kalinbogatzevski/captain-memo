import { test, expect } from 'bun:test';
import { cosineFromL2 } from '../../src/worker/vector-store.ts';
import { DEFAULT_REMEMBER_DEDUP_THRESHOLD } from '../../src/shared/paths.ts';

// ---------------------------------------------------------------------------
// vec_chunks is declared without distance_metric, so vec0 returns L2. `1 - L2` is
// monotonic with cosine and therefore RANKS correctly — which is why nothing looked
// broken — but it is not a cosine, so any threshold compared against it means something
// other than it says. The old 0.85 gate actually fired at cos 0.98875.
// ---------------------------------------------------------------------------

test('cosineFromL2 — the identity points are exact', () => {
  expect(cosineFromL2(0)).toBeCloseTo(1, 12);            // identical direction
  expect(cosineFromL2(Math.SQRT2)).toBeCloseTo(0, 12);   // orthogonal: d = sqrt(2)
  expect(cosineFromL2(2)).toBeCloseTo(-1, 12);           // opposite
});

test('cosineFromL2 — clamps float error at the extremes instead of returning >1 or <-1', () => {
  expect(cosineFromL2(-1e-9)).toBeLessThanOrEqual(1);
  expect(cosineFromL2(2.0000001)).toBeGreaterThanOrEqual(-1);
});

test('cosineFromL2 — is monotonically decreasing in distance', () => {
  const ds = [0, 0.1, 0.15, 0.5, 1, Math.SQRT2, 1.9, 2];
  const cs = ds.map(cosineFromL2);
  for (let i = 1; i < cs.length; i++) expect(cs[i]!).toBeLessThan(cs[i - 1]!);
});

// What the old gate REALLY was, kept as the record of the bug: `1 - d >= 0.85` means d <= 0.15,
// which is cos 0.98875 — not the 0.85 the constant advertised.
test('the old 1-L2 gate really sat at cos 0.98875, not the 0.85 it advertised', () => {
  expect(cosineFromL2(0.15)).toBeCloseTo(0.98875, 5);
});

// THE REGRESSION THIS LOCKS: the report threshold must sit in the GAP measured on the live
// 812-memory corpus — above the merely-related mass, at or below the true-duplicate cluster.
// Too high and it reports nothing (which is what the 0.98875 gate did); too low and it cries
// duplicate over ordinary related material (0.85 -> 18.7% of the corpus, 0.80 -> 44.6%).
test('the default report threshold sits in the measured gap between related and duplicate', () => {
  const RELATED_P95 = 0.8983;      // 95th percentile of nearest-other-memory cosine
  const DUPLICATE_FLOOR = 0.93;    // observed true-duplicate pairs run 0.93 - 0.9554
  const CORPUS_MAX = 0.9554;       // nothing in the corpus is closer than this

  expect(DEFAULT_REMEMBER_DEDUP_THRESHOLD).toBeGreaterThan(RELATED_P95);
  expect(DEFAULT_REMEMBER_DEDUP_THRESHOLD).toBeLessThanOrEqual(DUPLICATE_FLOOR);
  // and it must remain reachable at all — the failure mode of the gate it replaced
  expect(DEFAULT_REMEMBER_DEDUP_THRESHOLD).toBeLessThan(CORPUS_MAX);
});

test('merely-related material stays below the threshold', () => {
  // cos 0.85 is "clearly related" in embedding space and used to LOOK like the threshold.
  expect(0.85).toBeLessThan(DEFAULT_REMEMBER_DEDUP_THRESHOLD);
});
