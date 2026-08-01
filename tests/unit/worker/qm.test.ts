import { test, expect } from 'bun:test';
import { DEFAULT_QM_CONFIG, loadQmConfig } from '../../../src/worker/qm.ts';
// CONTRACT CHANGED: 0.98 was above what two phrasings of one fact reach in this embedding space.
// Measured on 122,647 observations — 400 pairs with IDENTICAL titles scored median 0.9467, p95 0.9779,
// max 0.9896; only 3.5% reached 0.98. Dedup merged 5 rows after examining 16,679 candidate groups.
// Supersede gets its own, lower number: it applies a reversible demotion where dedup archives a row.
//
// CONTRACT CHANGED AGAIN: both passes now default ON. Opt-in meant nobody ever got housekeeping —
// on the heaviest install supersede had literally zero rows in qm_runs after 1,241 dedup runs,
// because the env flag it needed was never set. A default nobody enables is a feature nobody has.
test('defaults: QM enabled, both housekeeping passes ON, cosine reachable by real duplicates', () => {
  expect(DEFAULT_QM_CONFIG.enabled).toBe(true);
  expect(DEFAULT_QM_CONFIG.dedupEnabled).toBe(true);
  expect(DEFAULT_QM_CONFIG.supersedeEnabled).toBe(true);
  expect(DEFAULT_QM_CONFIG.dedupCosineThreshold).toBe(0.95);
  expect(DEFAULT_QM_CONFIG.supersedeCosineThreshold).toBe(0.93);
  expect(DEFAULT_QM_CONFIG.dedupWindow).toBe(5000);
});
test('loadQmConfig with empty env equals defaults', () => { expect(loadQmConfig({})).toEqual(DEFAULT_QM_CONFIG); });
test('dedup opt-OUT via env', () => {
  expect(loadQmConfig({ CAPTAIN_MEMO_QM_DEDUP: '0' }).dedupEnabled).toBe(false);
  expect(loadQmConfig({ CAPTAIN_MEMO_QM_DEDUP: '1' }).dedupEnabled).toBe(true);
});
test('supersede opt-OUT via env', () => {
  expect(loadQmConfig({ CAPTAIN_MEMO_QM_SUPERSEDE: '0' }).supersedeEnabled).toBe(false);
  expect(loadQmConfig({ CAPTAIN_MEMO_QM_SUPERSEDE: '1' }).supersedeEnabled).toBe(true);
});
test('master kill switch stops both passes', () => { expect(loadQmConfig({ CAPTAIN_MEMO_QM_ENABLED: '0' }).enabled).toBe(false); });
test('numeric override + invalid falls back to default', () => {
  expect(loadQmConfig({ CAPTAIN_MEMO_QM_DEDUP_COSINE: '0.95' }).dedupCosineThreshold).toBe(0.95);
  expect(loadQmConfig({ CAPTAIN_MEMO_QM_DEDUP_COSINE: 'nonsense' }).dedupCosineThreshold).toBe(0.95);
  expect(loadQmConfig({ CAPTAIN_MEMO_QM_DEDUP_WINDOW: '500' }).dedupWindow).toBe(500);
});
