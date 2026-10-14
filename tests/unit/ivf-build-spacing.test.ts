// tests/unit/ivf-build-spacing.test.ts
//
// buildIntervalMs (2 s) was sized for a 376 ms slice and ~19% writer duty. A slice at 931 centroids is 1.8-2.4 s on the dev copy,
// which at a fixed 2 s gap is 47-54%. The gap now grows with the slice, so the writer is busy at most a quarter of the time.
import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_IVF_CONFIG, BUILD_SPACING, nextSweepDelayMs } from '../../src/worker/ivf.ts';

const cfg = DEFAULT_IVF_CONFIG;

test('nextSweepDelayMs — a fast build slice keeps the build interval; a slow one is spaced 3 slice-times apart', () => {
  expect(nextSweepDelayMs(true, 376, cfg)).toBe(cfg.buildIntervalMs);            // 376 ms x 3 = 1128 < 2000
  expect(nextSweepDelayMs(true, 2400, cfg)).toBe(7200);                           // 2.4 s slice -> 7.2 s gap -> 25% busy
  expect(2400 / (2400 + nextSweepDelayMs(true, 2400, cfg))).toBeCloseTo(0.25, 6);
  expect(BUILD_SPACING).toBe(3);
});

test('nextSweepDelayMs — once converged it is the slow cadence, however long the slice took', () => {
  expect(nextSweepDelayMs(false, 10, cfg)).toBe(cfg.sweepIntervalMs);
  expect(nextSweepDelayMs(false, 90_000, cfg)).toBe(cfg.sweepIntervalMs);
});

test('the worker schedules the next sweep slice with it', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/worker/index.ts'), 'utf-8');
  const sched = src.slice(src.indexOf('const scheduleIvfSweep'), src.indexOf('scheduleIvfSweep(ivfConfig.buildIntervalMs)'));
  expect(sched).toContain('nextSweepDelayMs(building, performance.now() - sliceStart, ivfConfig)');
  expect(sched).toContain('const sliceStart = performance.now()');
});
