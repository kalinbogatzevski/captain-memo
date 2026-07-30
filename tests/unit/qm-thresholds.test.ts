import { test, expect } from 'bun:test';
import { DEFAULT_QM_CONFIG, loadQmConfig } from '../../src/worker/qm.ts';

// MEASURED on a 122,647-observation corpus, 400 pairs sharing an IDENTICAL title — definitionally the
// same knowledge:  median 0.9467 · p95 0.9779 · max 0.9896.  Only 3.5% reach 0.98.
// Unrelated same-project pairs, for contrast: median ~0.50, p95 ~0.755.
//
// So 0.98 sat above what two phrasings of one fact can produce in this embedding space, and dedup
// merged 5 rows after examining 16,679 candidate groups across 1,204 runs. It was never blocked by the
// merge guard or the partitioning — one constant made it unsatisfiable.
//
// 0.95 sits ~0.2 above the unrelated p95 and admits 45.5% of exact-title pairs. The title gate still
// has to pass first; cosine is the confirm, not the whole test.
test('the dedup cosine confirm is reachable by real duplicate pairs', () => {
  expect(DEFAULT_QM_CONFIG.dedupCosineThreshold).toBeLessThanOrEqual(0.95);
  expect(DEFAULT_QM_CONFIG.dedupCosineThreshold).toBeGreaterThan(0.9);   // still far above unrelated noise
});

// Supersede and dedup guard actions of very different destructiveness: dedup ARCHIVES a row, supersede
// applies a reversible 0.5x score demotion. Sharing one constant made the safe action inherit the
// dangerous one's paranoia — and version-supersede pairs peak at 0.986 with a median of 0.932.
test('supersede has its OWN threshold, lower than dedup', () => {
  expect(DEFAULT_QM_CONFIG.supersedeCosineThreshold).toBeDefined();
  expect(DEFAULT_QM_CONFIG.supersedeCosineThreshold).toBeLessThan(DEFAULT_QM_CONFIG.dedupCosineThreshold);
  expect(DEFAULT_QM_CONFIG.supersedeCosineThreshold).toBeGreaterThan(0.85);
});

test('both thresholds are independently tunable from the environment', () => {
  const c = loadQmConfig({
    CAPTAIN_MEMO_QM_DEDUP_COSINE: '0.97',
    CAPTAIN_MEMO_QM_SUPERSEDE_COSINE: '0.91',
  } as never);
  expect(c.dedupCosineThreshold).toBe(0.97);
  expect(c.supersedeCosineThreshold).toBe(0.91);
});

test('an unparseable override falls back to the default rather than NaN', () => {
  const c = loadQmConfig({ CAPTAIN_MEMO_QM_SUPERSEDE_COSINE: 'nonsense' } as never);
  expect(c.supersedeCosineThreshold).toBe(DEFAULT_QM_CONFIG.supersedeCosineThreshold);
});
