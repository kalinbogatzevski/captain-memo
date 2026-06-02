// tests/unit/worker-watchdog-probe.test.ts — the watchdog must CONFIRM a real
// outage before its destructive reclaim. A single missed /health probe (a busy
// worker mid embed/summarize) must NOT count as unreachable — only a persistent
// failure across all retries does. (Field 2026-06-02: the watchdog was killing +
// re-indexing a healthy busy worker every ~5 min, popping a console window.)
import { test, expect } from 'bun:test';
import { probeHealthyWithRetries } from '../../src/shared/worker-health-probe.ts';

// Drives probeOnce from a fixed sequence and counts calls + sleeps.
function harness(results: boolean[]) {
  let i = 0;
  const calls = { probes: 0, sleeps: 0 };
  const probeOnce = async () => { calls.probes++; return results[Math.min(i++, results.length - 1)]!; };
  const sleep = async () => { calls.sleeps++; };
  return { probeOnce, sleep, calls };
}

test('healthy on the FIRST probe → true immediately (no retries, no sleep)', async () => {
  const { probeOnce, sleep, calls } = harness([true]);
  expect(await probeHealthyWithRetries(probeOnce, 3, 2000, sleep)).toBe(true);
  expect(calls.probes).toBe(1);
  expect(calls.sleeps).toBe(0);
});

test('busy worker misses one probe then recovers → true, NOT reclaimed (stops early)', async () => {
  const { probeOnce, sleep, calls } = harness([false, true]);
  expect(await probeHealthyWithRetries(probeOnce, 3, 2000, sleep)).toBe(true);
  expect(calls.probes).toBe(2);   // second probe succeeded → no third
  expect(calls.sleeps).toBe(1);   // one gap between the two probes
});

test('genuine zombie fails EVERY probe → false, reclaim justified', async () => {
  const { probeOnce, sleep, calls } = harness([false, false, false]);
  expect(await probeHealthyWithRetries(probeOnce, 3, 2000, sleep)).toBe(false);
  expect(calls.probes).toBe(3);
  expect(calls.sleeps).toBe(2);   // gaps between attempts, never after the last
});

test('recovery on the LAST allowed probe still counts as healthy', async () => {
  const { probeOnce, sleep, calls } = harness([false, false, true]);
  expect(await probeHealthyWithRetries(probeOnce, 3, 2000, sleep)).toBe(true);
  expect(calls.probes).toBe(3);
});
