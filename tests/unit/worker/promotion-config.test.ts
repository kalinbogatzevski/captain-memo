import { test, expect } from 'bun:test';
import { DEFAULT_PROMOTION_CONFIG, loadPromotionConfig, parseMode } from '../../../src/worker/promotion-config.ts';

test('defaults: promotion OFF, 6h interval, max 5 per run, minRecall 1', () => {
  expect(DEFAULT_PROMOTION_CONFIG.mode).toBe('off');
  expect(DEFAULT_PROMOTION_CONFIG.intervalMs).toBe(21_600_000);
  expect(DEFAULT_PROMOTION_CONFIG.maxPerRun).toBe(5);
  expect(DEFAULT_PROMOTION_CONFIG.minRecall).toBe(1);
});

test('loadPromotionConfig with empty env equals defaults', () => {
  expect(loadPromotionConfig({})).toEqual(DEFAULT_PROMOTION_CONFIG);
});

test('opt-in only on explicit "1"', () => {
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_ENABLE: '1' }).mode).toBe('on');
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_ENABLE: '0' }).mode).toBe('off');
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_ENABLE: 'true' }).mode).toBe('off');
});

test('numeric override + invalid falls back to default', () => {
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN: '3' }).maxPerRun).toBe(3);
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN: 'nonsense' }).maxPerRun).toBe(5);
  expect(loadPromotionConfig({ CAPTAIN_MEMO_PROMOTE_INTERVAL_MS: '1000' }).intervalMs).toBe(1000);
});

test('wiring gate: default config keeps the promotion timer OFF', () => {
  expect(loadPromotionConfig({}).mode).toBe('off');
});

// ---------------------------------------------------------------------------
// ONE knob, three values. Two flags could contradict each other ("enabled=1 AND shadow=1" —
// which wins?); this cannot. And the asymmetry is load-bearing: promotion writes into the
// user's memory dir, so an unrecognised value must fail to "didn't run", never to "ran".
// ---------------------------------------------------------------------------

test('parseMode: only the two recognised words turn it on; everything else is off', () => {
  expect(parseMode('shadow')).toBe('shadow');
  expect(parseMode('SHADOW ')).toBe('shadow');
  expect(parseMode('1')).toBe('on');
  expect(parseMode('on')).toBe('on');
  for (const v of [undefined, '', '0', 'true', 'yes', 'enabled', 'shdow', 'ON=1', 'shadow!']) {
    expect(parseMode(v)).toBe('off');
  }
});

test('parseMode: a typo NEVER yields a live run', () => {
  // The dangerous direction is off->on. A mistyped "shadow" that resolved to 'on' would write
  // to curated memory unattended; a mistyped "1" that resolves to 'off' merely does nothing.
  for (const v of ['shadw', 'shadow1', '11', 'o n', ' 1 1']) {
    expect(parseMode(v)).not.toBe('on');
  }
});
