import { test, expect } from 'bun:test';
import { detectTemporalIntent, applyTemporalRerank } from '../../../src/worker/temporal-intent.ts';
import type { RankConfig } from '../../../src/worker/search-config.ts';

const V2: RankConfig = {
  profile: 'v2', fusionMode: 'weighted', rrfK: 60, perStrategyTopK: 25,
  vectorWeight: 0.7, keywordWeight: 0.3,
  temporalIntent: true, properNounBoost: true,
  temporalHalfLifeDays: 21, temporalTopN: 10, relevanceFloor: 0.6, temporalFloor: 0.5,
  properNounBoostWeight: 1.15,
  supersedePenalty: 1,
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

test('undated curated memory is exempt (×1) and outranks a fresh observation of lower relevance', () => {
  const mem = { ...hit('mem', 1.0, null), channel: 'memory' }; // curated, undated → no decay
  const obs = hit('obs', 0.7, 1); // fresh observation, lower relevance
  const out = applyTemporalRerank([mem, obs], 'current talq version', V2, NOW);
  expect(out[0]?.doc_id).toBe('mem'); // curated reference protected, not demoted below fresh obs
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

test('gentle blend: at a near-tie the higher-relevance hit wins (recency does not dominate)', () => {
  // Both fresh & eligible; the older one is materially more relevant. A gentle bounded
  // blend keeps relevance dominant, so the higher-relevance hit stays #1 (was: freshest won).
  const hits = [hit('olderHigher', 1.0, 1), hit('fresherLower', 0.9, 0.1)];
  const out = applyTemporalRerank(hits, 'latest version of talq', V2, NOW);
  expect(out[0]?.doc_id).toBe('olderHigher');
});

test('temporalHalfLifeDays <= 0 => no decay (factor 1), order preserved', () => {
  const cfg = { ...V2, temporalHalfLifeDays: 0 };
  const hits = [hit('olderHigher', 1.0, 1), hit('fresherLower', 0.9, 0.1)];
  const out = applyTemporalRerank(hits, 'latest version of talq', cfg, NOW);
  expect(out.map(h => h.doc_id)).toEqual(['olderHigher', 'fresherLower']); // original relevance order
});

test('acceptance: fresh 0.60.1 + curated reference rank above every stale 0.5x/0.4x observation', () => {
  const hits = [
    hit('obs-0601', 0.90, 1),                              // fresh 0.60.1 observation
    hit('obs-0583', 0.95, 220),                            // STALE 0.58.3 — higher raw relevance
    hit('obs-0521', 0.90, 400),                            // stale 0.52.x
    hit('obs-0481', 0.90, 600),                            // stale 0.48.x
    { ...hit('mem-0601', 0.90, null), channel: 'memory' }, // curated reference (undated → exempt)
  ];
  const out = applyTemporalRerank(hits, 'what is the current TalQ release', V2, NOW);
  const rank = (id: string) => out.findIndex(h => h.doc_id === id);
  for (const stale of ['obs-0583', 'obs-0521', 'obs-0481']) {
    expect(rank('obs-0601')).toBeLessThan(rank(stale));
    expect(rank('mem-0601')).toBeLessThan(rank(stale));
  }
});
