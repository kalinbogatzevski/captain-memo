import { test, expect } from 'bun:test';
import { RANK_PROFILES, resolveRankConfig, defaultProfileName } from '../../../src/worker/search-config.ts';

test('legacy reproduces today\'s ranking (rrf 60/25, features off)', () => {
  const l = RANK_PROFILES.legacy;
  expect(l.fusionMode).toBe('rrf');
  expect(l.rrfK).toBe(60);
  expect(l.perStrategyTopK).toBe(25);
  expect(l.temporalIntent).toBe(false);
  expect(l.properNounBoost).toBe(false);
});

test('v2 = weighted + temporal + proper-noun', () => {
  const v = RANK_PROFILES.v2;
  expect(v.fusionMode).toBe('weighted');
  expect(v.vectorWeight).toBeCloseTo(0.7, 6);
  expect(v.keywordWeight).toBeCloseTo(0.3, 6);
  expect(v.temporalIntent).toBe(true);
  expect(v.properNounBoost).toBe(true);
  expect(v.temporalHalfLifeDays).toBe(21);
  expect(v.temporalTopN).toBe(10);
  expect(v.relevanceFloor).toBeCloseTo(0.6, 6);
  expect(v.temporalFloor).toBeCloseTo(0.5, 6);
  expect(v.properNounBoostWeight).toBeCloseTo(1.15, 6);
});

test('temporalFloor: legacy off (1), v2 gentle (0.5), env override', () => {
  expect(RANK_PROFILES.legacy.temporalFloor).toBe(1);
  expect(resolveRankConfig('v2', {}).temporalFloor).toBeCloseTo(0.5, 6);
  expect(resolveRankConfig('v2', { CAPTAIN_MEMO_TEMPORAL_FLOOR: '0.8' }).temporalFloor).toBeCloseTo(0.8, 6);
});

test('OSS default profile is v2 (ships better ranking out of the box)', () => {
  expect(defaultProfileName({})).toBe('v2');
  expect(defaultProfileName({ CAPTAIN_MEMO_RANK_PROFILE: 'legacy' })).toBe('legacy');
  expect(defaultProfileName({ CAPTAIN_MEMO_RANK_PROFILE: 'bogus' })).toBe('v2');
});

test('no remote/recencyDominance fields on RankConfig', () => {
  expect('remoteWeight' in RANK_PROFILES.v2).toBe(false);
  expect('recencyDominance' in RANK_PROFILES.v2).toBe(false);
});

test('env overrides apply', () => {
  const c = resolveRankConfig('legacy', { CAPTAIN_MEMO_RRF_K: '40', CAPTAIN_MEMO_TEMPORAL_INTENT: '1', CAPTAIN_MEMO_RELEVANCE_FLOOR: '0.5' });
  expect(c.rrfK).toBe(40);
  expect(c.temporalIntent).toBe(true);
  expect(c.relevanceFloor).toBeCloseTo(0.5, 6);
});

test('P-OSS supersede — supersedePenalty: legacy inert (1), v2 demotes (0.5), env override', () => {
  expect(resolveRankConfig('legacy', {}).supersedePenalty).toBe(1);
  expect(resolveRankConfig('v2', {}).supersedePenalty).toBe(0.5);
  expect(resolveRankConfig('v2', { CAPTAIN_MEMO_SUPERSEDE_PENALTY: '0.3' }).supersedePenalty).toBe(0.3);
});
