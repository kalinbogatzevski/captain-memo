import { test, expect } from 'bun:test';
import { detectTemporalIntent, applyTemporalRerank } from '../../../src/worker/temporal-intent.ts';
import type { RankConfig } from '../../../src/worker/search-config.ts';

const V2: RankConfig = {
  profile: 'v2', fusionMode: 'weighted', rrfK: 60, perStrategyTopK: 25,
  vectorWeight: 0.7, keywordWeight: 0.3,
  temporalIntent: true, properNounBoost: true,
  temporalHalfLifeDays: 7, temporalTopN: 10, relevanceFloor: 0.6,
  properNounBoostWeight: 1.15,
};
const NOW = 1_000_000_000_000;
const DAY = 86_400;
const hit = (id: string, score: number, ageDays: number | null) => ({
  doc_id: id, score, channel: 'observation', source_path: id, title: id, snippet: id,
  metadata: ageDays === null ? {} : { created_at_epoch: NOW / 1000 - ageDays * DAY },
});

test('detectTemporalIntent: positives and negatives', () => {
  expect(detectTemporalIntent('which is the last version of talq')).toBe(true);
  expect(detectTemporalIntent('latest captain-memo release')).toBe(true);
  expect(detectTemporalIntent('current state of aelita')).toBe(true);
  expect(detectTemporalIntent('how does talq parse messages')).toBe(false);
  expect(detectTemporalIntent('version compatibility matrix')).toBe(false);
  expect(detectTemporalIntent('')).toBe(false);
});

test('temporal query: newer relevant hit is promoted to #1', () => {
  const hits = [hit('old', 1.0, 120), hit('new', 0.8, 1)]; // new is above floor (0.8 >= 0.6*1.0)
  const out = applyTemporalRerank(hits, 'latest version of talq', V2, NOW);
  expect(out.map(h => h.doc_id)).toEqual(['new', 'old']);
});

test('below-floor fresh hit does NOT hijack #1', () => {
  const hits = [hit('relevant', 1.0, 120), hit('freshMarginal', 0.5, 1)]; // 0.5 < 0.6*1.0 → ineligible
  const out = applyTemporalRerank(hits, 'latest talq', V2, NOW);
  expect(out[0]?.doc_id).toBe('relevant');
});

test('undated memory sinks beneath a dated observation (recency 0)', () => {
  const mem = { ...hit('mem', 1.0, null), channel: 'memory' };
  const obs = hit('obs', 0.7, 1); // eligible (0.7>=0.6), fresh
  const out = applyTemporalRerank([mem, obs], 'current talq version', V2, NOW);
  expect(out[0]?.doc_id).toBe('obs');
});

test('gate off (temporalIntent false) returns input unchanged', () => {
  const legacyCfg = { ...V2, temporalIntent: false };
  const hits = [hit('old', 1.0, 120), hit('new', 0.8, 1)];
  const out = applyTemporalRerank(hits, 'latest version of talq', legacyCfg, NOW);
  expect(out.map(h => h.doc_id)).toEqual(['old', 'new']);
});

test('non-temporal query returns input unchanged', () => {
  const hits = [hit('old', 1.0, 120), hit('new', 0.8, 1)];
  const out = applyTemporalRerank(hits, 'how does talq parse', V2, NOW);
  expect(out.map(h => h.doc_id)).toEqual(['old', 'new']);
});

test('between two recent eligible hits, the absolute freshest wins (not the higher-score one)', () => {
  // older has the higher score; the blend wrongly preferred it. Recency-primary picks the fresher.
  const hits = [hit('olderHigher', 1.0, 1), hit('fresherLower', 0.9, 0.1)]; // 0.9 >= 0.6*1.0 → both eligible
  const out = applyTemporalRerank(hits, 'latest version of talq', V2, NOW);
  expect(out[0]?.doc_id).toBe('fresherLower');
});

test('temporalHalfLifeDays <= 0 disables the re-rank (returns input unchanged)', () => {
  const cfg = { ...V2, temporalHalfLifeDays: 0 };
  const hits = [hit('olderHigher', 1.0, 1), hit('fresherLower', 0.9, 0.1)];
  const out = applyTemporalRerank(hits, 'latest version of talq', cfg, NOW);
  expect(out.map(h => h.doc_id)).toEqual(['olderHigher', 'fresherLower']); // original order preserved
});
