import { test, expect } from 'bun:test';
import { mergeEmbedUsage, makeUsageReporter, type EmbedUsage } from '../../src/worker/embedder.ts';

const NOW = 1_800_000_000;
const usage = (o: Partial<EmbedUsage> = {}): EmbedUsage => ({
  since_epoch: NOW - 1000, calls: 0, tokens: 0, wasted_tokens: 0, aborted: 0, window_wasted_tokens: 0,
  waste_limit_tokens: 500_000, paused_until_epoch: null, by_source: {}, ...o,
});

test('merge — no readers: the base figures back, readers 0, a copy rather than the same object', () => {
  const base = usage({ calls: 3, tokens: 900, by_source: { ingest: { calls: 3, tokens: 900 } } });
  const m = mergeEmbedUsage(base, [], NOW);
  expect(m).toEqual({ ...base, readers: 0 });
  expect(m.by_source).not.toBe(base.by_source);
  expect(m.by_source.ingest).not.toBe(base.by_source.ingest);
});

test('merge — one reader adds its queries; every existing field keeps its meaning, readers is the only new key', () => {
  const base = usage({ calls: 3, tokens: 900, wasted_tokens: 100, aborted: 1, window_wasted_tokens: 100, by_source: { ingest: { calls: 3, tokens: 900 } } });
  const r = usage({ since_epoch: NOW - 500, calls: 40, tokens: 6000, by_source: { query: { calls: 39, tokens: 5990 }, other: { calls: 1, tokens: 10 } } });
  const m = mergeEmbedUsage(base, [r], NOW);
  expect(m.calls).toBe(43);
  expect(m.tokens).toBe(6900);
  expect(m.wasted_tokens).toBe(100);
  expect(m.aborted).toBe(1);
  expect(m.window_wasted_tokens).toBe(100);
  expect(m.waste_limit_tokens).toBe(500_000);
  expect(m.since_epoch).toBe(NOW - 1000);                                 // the oldest start
  expect(m.by_source).toEqual({ ingest: { calls: 3, tokens: 900 }, query: { calls: 39, tokens: 5990 }, other: { calls: 1, tokens: 10 } });
  expect(Object.keys(m).sort()).toEqual([...Object.keys(base), 'readers'].sort());
  expect(m.readers).toBe(1);
});

test('merge — several readers add up, a source shared by all of them is summed per key, inputs are not changed', () => {
  const base = usage({ calls: 1, tokens: 1, by_source: { other: { calls: 1, tokens: 1 } } });
  const a = usage({ calls: 2, tokens: 20, wasted_tokens: 5, aborted: 1, window_wasted_tokens: 5, by_source: { query: { calls: 2, tokens: 20 } } });
  const b = usage({ calls: 3, tokens: 30, by_source: { query: { calls: 3, tokens: 30 }, other: { calls: 0, tokens: 0 } } });
  const frozen = structuredClone([base, a, b]);
  const m = mergeEmbedUsage(base, [a, b], NOW);
  expect(m.calls).toBe(6);
  expect(m.tokens).toBe(51);
  expect(m.wasted_tokens).toBe(5);
  expect(m.aborted).toBe(1);
  expect(m.by_source).toEqual({ other: { calls: 1, tokens: 1 }, query: { calls: 5, tokens: 50 } });
  expect(m.readers).toBe(2);
  expect([base, a, b]).toEqual(frozen);
});

test('merge — a reader that restarted starts from 0: its slot is its newest snapshot, so the total can step down', () => {
  const base = usage({ calls: 10, tokens: 1000 });
  const before = mergeEmbedUsage(base, [usage({ calls: 50, tokens: 5000 })], NOW);
  const after = mergeEmbedUsage(base, [usage({ since_epoch: NOW - 5, calls: 2, tokens: 200 })], NOW);
  expect(before.tokens).toBe(6000);
  expect(after.tokens).toBe(1200);
  expect(after.calls).toBe(12);
  expect(after.since_epoch).toBe(NOW - 1000);   // the writer is still the oldest
});

test('merge — pause: the latest one still running wins; one that has run out reads null', () => {
  const live = usage({ paused_until_epoch: NOW + 600, window_wasted_tokens: 600_000 });
  const later = usage({ paused_until_epoch: NOW + 1800 });
  const over = usage({ paused_until_epoch: NOW - 1 });
  expect(mergeEmbedUsage(usage(), [live], NOW).paused_until_epoch).toBe(NOW + 600);       // only a reader paused
  expect(mergeEmbedUsage(live, [], NOW).paused_until_epoch).toBe(NOW + 600);              // only the writer paused
  expect(mergeEmbedUsage(live, [over, later], NOW).paused_until_epoch).toBe(NOW + 1800);
  expect(mergeEmbedUsage(usage(), [over], NOW).paused_until_epoch).toBeNull();
  expect(mergeEmbedUsage(usage(), [usage()], NOW).paused_until_epoch).toBeNull();
  // The pause stays per engine: waste adds up past one engine's limit and nothing is claimed paused because of it.
  const m = mergeEmbedUsage(usage({ window_wasted_tokens: 400_000 }), [usage({ window_wasted_tokens: 400_000 })], NOW);
  expect(m.window_wasted_tokens).toBe(800_000);
  expect(m.paused_until_epoch).toBeNull();
});

test('reporter — a quiet embedder posts nothing, however long it is ticked', () => {
  const posts: EmbedUsage[] = [];
  const r = makeUsageReporter(() => usage(), (u) => posts.push(u));
  for (let i = 0; i < 1000; i++) r.tick();
  expect(posts).toHaveLength(0);
});

test('reporter — posts once per change, not once per tick; a pause running out is a change too', () => {
  const posts: EmbedUsage[] = [];
  let cur = usage();
  const r = makeUsageReporter(() => cur, (u) => posts.push(u));
  cur = usage({ calls: 1, tokens: 10, by_source: { other: { calls: 1, tokens: 10 } } });   // the boot probe
  r.tick(); r.tick(); r.tick();
  expect(posts).toHaveLength(1);
  cur = usage({ calls: 2, tokens: 25, by_source: { other: { calls: 1, tokens: 10 }, query: { calls: 1, tokens: 15 } } });
  r.tick(); r.tick();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.tokens).toBe(25);
  cur = { ...cur, paused_until_epoch: NOW + 60, window_wasted_tokens: 9 };
  r.tick();
  cur = { ...cur, paused_until_epoch: null, window_wasted_tokens: 0 };     // the pause ran out, no new request
  r.tick(); r.tick();
  expect(posts).toHaveLength(4);
});
