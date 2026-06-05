import { test, expect } from 'bun:test';
import {
  normalizeTitle,
  significantTokens,
  jaccard,
  groupBySimilarity,
  DEFAULT_SIMILARITY_THRESHOLD,
} from '../../../src/shared/title-similarity.ts';

// The five real near-duplicate phrasings the summarizer produced for one fact.
const T1 = 'update-status skill command verified and available';
const T2 = 'update-status skill command available in erp-platform';
const T3 = 'update-status skill command verified in erp-platform';
const T4 = 'update-status skill command is available';
const T5 = 'update-status skill registered and callable';
const UNRELATED = 'Split retrieval tracking by source';

test('normalizeTitle — lowercases, strips trailing ellipsis, collapses whitespace', () => {
  expect(normalizeTitle('  Update-Status  Skill…  ')).toBe('update-status skill');
  expect(normalizeTitle('foo bar...')).toBe('foo bar');
  expect(normalizeTitle('already clean')).toBe('already clean');
});

test('significantTokens — drops stopwords and short tokens', () => {
  const toks = significantTokens('The DB and UI are ready');
  expect(toks.has('ready')).toBe(true);
  expect(toks.has('the')).toBe(false);   // stopword
  expect(toks.has('and')).toBe(false);   // stopword
  expect(toks.has('are')).toBe(false);   // stopword
  expect(toks.has('db')).toBe(false);    // length < 3
  expect(toks.has('ui')).toBe(false);    // length < 3
});

test('jaccard — intersection over union, empty union is 0', () => {
  expect(jaccard(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c']))).toBe(1);
  expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3, 5);
  expect(jaccard(new Set(), new Set())).toBe(0);
  expect(jaccard(new Set(['a']), new Set())).toBe(0);
});

test('DEFAULT_SIMILARITY_THRESHOLD is 0.5', () => {
  expect(DEFAULT_SIMILARITY_THRESHOLD).toBe(0.5);
});

test('groupBySimilarity — at 0.5 the four close phrasings group, the fifth stays apart', () => {
  const items = [T1, T2, T3, T4, T5, UNRELATED];
  const groups = groupBySimilarity(items, (t) => t, 0.5);
  // Three groups: [T1,T2,T3,T4], [T5], [UNRELATED].
  expect(groups.length).toBe(3);
  expect(groups[0]).toEqual([T1, T2, T3, T4]);
  expect(groups[1]).toEqual([T5]);
  expect(groups[2]).toEqual([UNRELATED]);
});

test('groupBySimilarity — a low threshold folds all five phrasings into one group', () => {
  const items = [T1, T2, T3, T4, T5];
  const groups = groupBySimilarity(items, (t) => t, 0.3);
  expect(groups.length).toBe(1);
  expect(groups[0]!.length).toBe(5);
});

test('groupBySimilarity — never merges genuinely unrelated titles', () => {
  const groups = groupBySimilarity([T1, UNRELATED], (t) => t, 0.1);
  expect(groups.length).toBe(2);
});

test('groupBySimilarity — representative is the first item of each group (caller pre-sorts)', () => {
  // Caller passes highest-count first; representative must be preserved as [0].
  const groups = groupBySimilarity([T4, T1], (t) => t, 0.5);
  expect(groups[0]![0]).toBe(T4);
});

test('groupBySimilarity — optional blocked predicate prevents a join Jaccard alone would make', () => {
  // T1..T4 group at 0.5 with no predicate; a blocker vetoing every pair keeps
  // each title in its own group (the predicate overrides a passing Jaccard).
  const items = [T1, T2, T3, T4];
  const withBlock = groupBySimilarity(items, (t) => t, 0.5, () => true);
  expect(withBlock.length).toBe(4);
  expect(withBlock.every((g) => g.length === 1)).toBe(true);

  // A selective blocker (veto only one specific candidate) splits just that one out.
  const selective = groupBySimilarity(items, (t) => t, 0.5, (_rep, cand) => cand === T3);
  const t3Group = selective.find((g) => g.includes(T3))!;
  expect(t3Group).toEqual([T3]);                       // T3 forced into its own group
  expect(selective.find((g) => g.includes(T1))!).toEqual([T1, T2, T4]);
});

test('groupBySimilarity — omitting the predicate preserves the old grouping behavior', () => {
  // Same inputs, with vs without the 4th arg → identical groups (a blocker that
  // never vetoes must equal no blocker at all, and both equal the legacy call).
  const items = [T1, T2, T3, T4, T5, UNRELATED];
  const legacy = groupBySimilarity(items, (t) => t, 0.5);
  const neverBlock = groupBySimilarity(items, (t) => t, 0.5, () => false);
  expect(neverBlock).toEqual(legacy);
  expect(legacy[0]).toEqual([T1, T2, T3, T4]);          // unchanged from the legacy assertion
});
