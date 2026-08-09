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

// THE REGRESSION THIS LOCKS: the new threshold must gate where the old one actually did,
// not where the old one appeared to. Old gate: `1 - d >= 0.85`, i.e. d <= 0.15.
test('the default threshold preserves the behaviour the old 1-L2 gate really had', () => {
  const oldCutoffDistance = 0.15;                        // 1 - 0.85
  const trueCosineAtOldCutoff = cosineFromL2(oldCutoffDistance);

  expect(trueCosineAtOldCutoff).toBeCloseTo(0.98875, 5); // NOT 0.85 — that was the bug
  // New default is a hair stricter, i.e. FEWER merges. Never looser: a merge rewrites an
  // existing memory through an LLM, so a false positive silently edits an entry nobody named.
  expect(DEFAULT_REMEMBER_DEDUP_THRESHOLD).toBeGreaterThanOrEqual(trueCosineAtOldCutoff);
  expect(DEFAULT_REMEMBER_DEDUP_THRESHOLD).toBeLessThan(1);
});

test('a merely-related memory does not reach the gate', () => {
  // cos 0.85 is "clearly related" in embedding space and used to LOOK like the threshold.
  // Under a true cosine it must fall well short of folding two memories together.
  expect(0.85).toBeLessThan(DEFAULT_REMEMBER_DEDUP_THRESHOLD);
});
