import { test, expect } from 'bun:test';
import { DEFAULT_QM_CONFIG, loadQmConfig } from '../../../src/worker/qm.ts';
test('defaults: QM enabled, dedup OFF, cosine 0.98', () => {
  expect(DEFAULT_QM_CONFIG.enabled).toBe(true);
  expect(DEFAULT_QM_CONFIG.dedupEnabled).toBe(false);
  expect(DEFAULT_QM_CONFIG.dedupCosineThreshold).toBe(0.98);
  expect(DEFAULT_QM_CONFIG.dedupWindow).toBe(500);
});
test('loadQmConfig with empty env equals defaults', () => { expect(loadQmConfig({})).toEqual(DEFAULT_QM_CONFIG); });
test('dedup opt-in via env', () => { expect(loadQmConfig({ CAPTAIN_MEMO_QM_DEDUP: '1' }).dedupEnabled).toBe(true); });
test('master kill switch', () => { expect(loadQmConfig({ CAPTAIN_MEMO_QM_ENABLED: '0' }).enabled).toBe(false); });
test('numeric override + invalid falls back to default', () => {
  expect(loadQmConfig({ CAPTAIN_MEMO_QM_DEDUP_COSINE: '0.95' }).dedupCosineThreshold).toBe(0.95);
  expect(loadQmConfig({ CAPTAIN_MEMO_QM_DEDUP_COSINE: 'nonsense' }).dedupCosineThreshold).toBe(0.98);
});
