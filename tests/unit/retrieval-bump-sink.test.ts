import { test, expect } from 'bun:test';
import { applyBump } from '../../src/worker/index.ts';  // exported helper (Step 3)

test('applyBump prefers the injected sink over the store', () => {
  const calls: Array<{ ids: number[]; source: string }> = [];
  const sink = (ids: number[], source: string) => calls.push({ ids, source });
  const store = { bumpRetrieval: () => { throw new Error('store should not be touched in reader mode'); } };
  applyBump([1, 2], 'search', sink, store as any);
  expect(calls).toEqual([{ ids: [1, 2], source: 'search' }]);
});
test('applyBump falls back to the store when no sink', () => {
  const seen: any[] = [];
  const store = { bumpRetrieval: (ids: number[], source: string) => seen.push([ids, source]) };
  applyBump([3], 'drill', undefined, store as any);
  expect(seen).toEqual([[[3], 'drill']]);
});
test('applyBump no-ops on empty ids', () => {
  let called = false;
  applyBump([], 'search', () => { called = true; }, undefined);
  expect(called).toBe(false);
});
