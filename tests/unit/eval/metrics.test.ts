import { test, expect } from 'bun:test';
import { mrr, ndcgAtK, recallAtK, freshnessAt1, stalenessRate } from '../../../src/eval/metrics.ts';

test('mrr — first relevant at rank 2 → 0.5', () => {
  expect(mrr(['a', 'b', 'c'], new Set(['b']))).toBe(0.5);
});
test('mrr — none relevant → 0', () => {
  expect(mrr(['a', 'b'], new Set(['z']))).toBe(0);
});
test('ndcg@k — perfect order → 1', () => {
  const grades = new Map([['a', 3], ['b', 2], ['c', 1]]);
  expect(ndcgAtK(['a', 'b', 'c'], grades, 3)).toBeCloseTo(1, 6);
});
test('ndcg@k — reversed order < 1', () => {
  const grades = new Map([['a', 3], ['b', 2], ['c', 1]]);
  expect(ndcgAtK(['c', 'b', 'a'], grades, 3)).toBeLessThan(1);
});
test('recall@k — 1 of 2 relevant in top-2 → 0.5', () => {
  expect(recallAtK(['a', 'x', 'b'], new Set(['a', 'b']), 2)).toBe(0.5);
});
test('freshness@1 — top is the fresh doc → 1, else 0', () => {
  expect(freshnessAt1('fresh', 'fresh')).toBe(1);
  expect(freshnessAt1('stale', 'fresh')).toBe(0);
  expect(freshnessAt1(undefined, 'fresh')).toBe(0);
});
test('stalenessRate — 2 of top-4 are stale → 0.5', () => {
  expect(stalenessRate(['s1', 'ok', 's2', 'ok2'], new Set(['s1', 's2']), 4)).toBe(0.5);
});
