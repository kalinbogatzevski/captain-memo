// tests/unit/pending-embed-backoff.test.ts — failed embeds now back off per row
// instead of retrying on a fixed 60s tick, so a Voyage outage stops being hammered.
// `retries` is the PRIOR retry count (0 on first failure).
import { test, expect } from 'bun:test';
import { embedRetryDelayMs } from '../../src/worker/pending-embed-queue.ts';

test('first failure recovers fast (≤ 30s) — a transient blip is not over-delayed', () => {
  expect(embedRetryDelayMs(0, () => 1)).toBe(30_000); // base, jitter max
  expect(embedRetryDelayMs(0, () => 0)).toBe(15_000); // base/2, jitter min
});

test('delay escalates exponentially with the retry count', () => {
  expect(embedRetryDelayMs(1, () => 1)).toBe(60_000);
  expect(embedRetryDelayMs(2, () => 1)).toBe(120_000);
  expect(embedRetryDelayMs(3, () => 1)).toBe(240_000);
});

test('capped at 10 min — a long outage never schedules further out than the cap', () => {
  expect(embedRetryDelayMs(20, () => 1)).toBe(600_000);
});

test('a high-retry row is always scheduled later than a fresh one (bands do not overlap)', () => {
  // worst case for the fresh row (jitter max) vs best case for the aged row (jitter min)
  expect(embedRetryDelayMs(0, () => 1)).toBeLessThan(embedRetryDelayMs(5, () => 0));
});
