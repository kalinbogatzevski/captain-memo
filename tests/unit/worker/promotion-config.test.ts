import { test, expect } from 'bun:test';
import { DEFAULT_PROMOTION_CONFIG, loadPromotionConfig } from '../../../src/worker/promotion-config.ts';

test('defaults: promotion OFF, 6h interval, max 5 per run, minRecall 1', () => {
  expect(DEFAULT_PROMOTION_CONFIG.enabled).toBe(false);
  expect(DEFAULT_PROMOTION_CONFIG.intervalMs).toBe(21_600_000);
  expect(DEFAULT_PROMOTION_CONFIG.maxPerRun).toBe(5);
  expect(DEFAULT_PROMOTION_CONFIG.minRecall).toBe(1);
});

test('loadPromotionConfig with empty env equals defaults', () => {
  expect(loadPromotionConfig({})).toEqual(DEFAULT_PROMOTION_CONFIG);
});

test('opt-in only on explicit "1"', () => {
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_ENABLE: '1' }).enabled).toBe(true);
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_ENABLE: '0' }).enabled).toBe(false);
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_ENABLE: 'true' }).enabled).toBe(false);
});

test('numeric override + invalid falls back to default', () => {
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN: '3' }).maxPerRun).toBe(3);
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN: 'nonsense' }).maxPerRun).toBe(5);
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_INTERVAL_MS: '1000' }).intervalMs).toBe(1000);
});

test('wiring gate: default config keeps the promotion timer OFF', () => {
  expect(loadPromotionConfig(process.env).enabled || loadPromotionConfig({}).enabled).toBe(false);
});
