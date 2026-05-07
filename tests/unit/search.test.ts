import { test, expect } from 'bun:test';
import { reciprocalRankFusion, HybridSearcher } from '../../src/worker/search.ts';

test('reciprocalRankFusion — single ranked list returns same order', () => {
  const fused = reciprocalRankFusion([['a', 'b', 'c']], 60);
  const ids = fused.map(f => f.id);
  expect(ids).toEqual(['a', 'b', 'c']);
});

test('reciprocalRankFusion — items appearing in multiple lists rank higher', () => {
  const fused = reciprocalRankFusion([
    ['a', 'b', 'c'],   // a is rank 1 here
    ['c', 'a', 'd'],   // a is rank 2 here
  ], 60);
  // a appears in both lists → highest aggregate score
  expect(fused[0]!.id).toBe('a');
});

test('reciprocalRankFusion — score formula 1/(k + rank)', () => {
  const fused = reciprocalRankFusion([['x']], 60);
  // Single item in single list: raw = 1/61, maxPossible = 1 * 1/61 = 1/61
  // normalized = (1/61) / (1/61) = 1.0 (it's the max in this single-list case)
  expect(fused[0]!.score).toBeCloseTo(1.0, 5);
});

test('reciprocalRankFusion — empty input returns empty', () => {
  expect(reciprocalRankFusion([], 60)).toEqual([]);
  expect(reciprocalRankFusion([[]], 60)).toEqual([]);
});

test('reciprocalRankFusion — fused scores normalized to 0-1 range', () => {
  const fused = reciprocalRankFusion([['a', 'b', 'c'], ['a', 'c', 'b']], 60);
  for (const item of fused) {
    expect(item.score).toBeGreaterThanOrEqual(0);
    expect(item.score).toBeLessThanOrEqual(1);
  }
  // Top item should have highest score
  expect(fused[0]!.score).toBeGreaterThanOrEqual(fused[1]!.score);
});

test('HybridSearcher — fuses vector + keyword results', async () => {
  const searcher = new HybridSearcher({
    vectorSearch: async () => [
      { id: 'a', distance: 0.1 },
      { id: 'b', distance: 0.2 },
      { id: 'c', distance: 0.3 },
    ],
    keywordSearch: async () => [
      { chunk_id: 'b' },
      { chunk_id: 'a' },
    ],
    rrfK: 60,
  });
  const fused = await searcher.search([0, 0], 'query', 5);
  expect(fused.length).toBeGreaterThan(0);
  // Items in both lists should rank above items in only one
  const ids = fused.map(f => f.id);
  expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'));
  expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
});

test('HybridSearcher — limits results to topK', async () => {
  const searcher = new HybridSearcher({
    vectorSearch: async () => [
      { id: 'a', distance: 0.1 },
      { id: 'b', distance: 0.2 },
      { id: 'c', distance: 0.3 },
      { id: 'd', distance: 0.4 },
      { id: 'e', distance: 0.5 },
    ],
    keywordSearch: async () => [],
    rrfK: 60,
  });
  const fused = await searcher.search([0, 0], 'q', 3);
  expect(fused).toHaveLength(3);
});

test('HybridSearcher — falls back gracefully when keyword search fails', async () => {
  const searcher = new HybridSearcher({
    vectorSearch: async () => [{ id: 'a', distance: 0.1 }],
    keywordSearch: async () => { throw new Error('FTS5 broke'); },
    rrfK: 60,
  });
  const fused = await searcher.search([0, 0], 'q', 5);
  expect(fused).toHaveLength(1);
  expect(fused[0]!.id).toBe('a');
});
