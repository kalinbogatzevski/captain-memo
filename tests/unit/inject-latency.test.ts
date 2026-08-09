import { test, expect } from 'bun:test';
import { InjectLatencyRing, INJECT_WINDOW } from '../../src/worker/inject-latency.ts';

const s = (elapsed: number, extra: Partial<{ embed_ms: number | null; degraded: boolean; over_deadline: boolean }> = {}) => ({
  elapsed_ms: elapsed,
  embed_ms: extra.embed_ms === undefined ? 100 : extra.embed_ms,
  degraded: extra.degraded ?? false,
  over_deadline: extra.over_deadline ?? false,
});

test('InjectLatencyRing — empty window reports zeros and a null embed p50, not a fake number', () => {
  const st = new InjectLatencyRing().stats();
  expect(st.n).toBe(0);
  expect(st.p50_ms).toBe(0);
  // null, not 0: "no embeds observed" and "embeds are instant" are different claims.
  expect(st.embed_p50_ms).toBeNull();
});

test('InjectLatencyRing — percentiles are nearest-rank over the observed values', () => {
  const r = new InjectLatencyRing();
  for (const v of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]) r.record(s(v));
  const st = r.stats();
  expect(st.n).toBe(10);
  expect(st.p50_ms).toBe(500);
  expect(st.p95_ms).toBe(1000);
  expect(st.max_ms).toBe(1000);
  // Every reported percentile must be a value some request actually took.
  expect([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]).toContain(st.p50_ms);
});

test('InjectLatencyRing — keeps only the last INJECT_WINDOW samples', () => {
  const r = new InjectLatencyRing();
  for (let i = 0; i < INJECT_WINDOW + 50; i++) r.record(s(i + 1));
  const st = r.stats();
  expect(st.n).toBe(INJECT_WINDOW);
  // The first 50 aged out, so the max is the newest, not the all-time high of an old spike.
  expect(st.max_ms).toBe(INJECT_WINDOW + 50);
});

test('InjectLatencyRing — a skipped embed is excluded from embed_p50, not counted as zero', () => {
  const r = new InjectLatencyRing();
  r.record(s(500, { embed_ms: 300 }));
  r.record(s(500, { embed_ms: 400 }));
  r.record(s(500, { embed_ms: null }));   // skip-embed calls: no embed was paid for
  r.record(s(500, { embed_ms: null }));
  const st = r.stats();
  // Two skips and two real embeds, chosen so the two behaviours actually differ:
  //   excluded (correct) → nearest-rank p50 of [300,400]     = 300
  //   counted as zero    → nearest-rank p50 of [0,0,300,400] = 0
  // A zero would say "embeds are free here", which is exactly the wrong input to the §4.3 budget
  // decision — a hosted embedder would look affordable inside a deadline it cannot meet.
  expect(st.embed_p50_ms).toBe(300);
});

test('InjectLatencyRing — failures and degradations are counted, not dropped', () => {
  // Spec 4.1: dropping the failures would flatter the p50 at exactly the moment the hook is
  // losing turns — the window would look healthiest when things are worst.
  const r = new InjectLatencyRing();
  for (let i = 0; i < 3; i++) r.record(s(300));
  r.record(s(9000, { over_deadline: true, degraded: true, embed_ms: null }));
  const st = r.stats();
  expect(st.n).toBe(4);
  expect(st.over_deadline_n).toBe(1);
  expect(st.degraded_n).toBe(1);
  expect(st.max_ms).toBe(9000);
});
