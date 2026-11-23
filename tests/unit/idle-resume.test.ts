import { test, expect } from 'bun:test';
import { resumeWatch, quietSeconds, isIdle } from '../../src/worker/idle.ts';

test('a wake after a long sleep counts as activity, so no idle pass starts', () => {
  let t = 1_000_000_000_000;
  const w = resumeWatch(60_000, () => t);
  t += 60_000; expect(w.look()).toBeNull();          // normal heartbeat
  const lastObs = Math.floor(t / 1000);
  t += 8 * 3600_000;                                  // laptop slept 8 h; first look after wake
  const resumed = w.look();
  expect(resumed).toBe(t);
  const nowS = Math.floor(t / 1000);
  const sig = { ingestActive: false, queuePending: 0, activeSessions: 0, secondsSinceLastActivity: quietSeconds(nowS, lastObs, resumed) };
  expect(isIdle(sig, { minIdleSeconds: 1800 })).toBe(false);
  // 31 quiet minutes after the wake, it qualifies again.
  for (let i = 0; i < 31; i++) { t += 60_000; w.look(); }
  expect(quietSeconds(Math.floor(t / 1000), lastObs, w.look())).toBe(31 * 60);
});

test('quietSeconds: no activity and no resume is Infinity', () => {
  expect(quietSeconds(100, null, null)).toBe(Infinity);
  expect(quietSeconds(100, 40, null)).toBe(60);
});
