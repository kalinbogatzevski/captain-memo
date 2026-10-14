// tests/unit/ivf-cluster-groups.test.ts
//
// The dedup finder walks every pair of a group it is handed. Unclustered rows (no centroid has placed them yet) used to reach it
// as one group: the whole corpus at the start of a build, and again at the end of a rebuild's reset phase. Dedup is on by
// default and runs hourly, and 84M pairs took 28.5 s, so that group is the cost of the pass, on the engine thread.
import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { observationGroups, PARKED_CLUSTER, UNCLUSTERED_CLUSTER } from '../../src/worker/ivf.ts';

const obs = (...pairs: Array<[string, number]>) => new Map<string, number>(pairs);
const byChunk = obs(['a1', 1], ['a2', 1], ['a3', 2], ['b1', 3], ['b2', 4], ['u1', 5], ['u2', 6], ['u3', 7], ['p1', 8], ['p2', 9]);
const membership = new Map<number, string[]>([
  [10, ['a1', 'a2', 'a3']],               // observations 1 and 2 (a1 and a2 are chunks of one observation)
  [11, ['b1', 'b2']],
  [12, ['u1']],                            // one observation: not a group
  [UNCLUSTERED_CLUSTER, ['u1', 'u2', 'u3']],
  [PARKED_CLUSTER, ['p1', 'p2']],
]);

test('observationGroups — an indexed collection: clusters only, never the unclustered or parked partitions', () => {
  expect(observationGroups(membership, byChunk, true)).toEqual([[1, 2], [3, 4]]);
});

test('observationGroups — no centroids yet: the unclustered partition is the only grouping there is and is kept; parked still is not', () => {
  expect(observationGroups(membership, byChunk, false)).toEqual([[1, 2], [3, 4], [5, 6, 7]]);
});

test('observationGroups — chunks with no observation are ignored, and a group of one observation is dropped', () => {
  const m = new Map<number, string[]>([[1, ['a1', 'a2', 'ghost']], [2, ['b1', 'ghost']]]);
  expect(observationGroups(m, byChunk, true)).toEqual([]);
});

test('the worker hands the dedup finder observationGroups, guarded by whether the collection has centroids', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/worker/index.ts'), 'utf-8');
  const fn = src.slice(src.indexOf('const clusterObservationIds'), src.indexOf('// Quartermaster auto-dedup'));
  expect(fn).toContain('observationGroups(');
  expect(fn).toContain('vector.getCentroids(collectionName).length > 0');
  expect(src.match(/clusterObservationIds\(/g)!.length).toBe(1);   // the one finder that reads cluster membership; semantic groups by session, theme by project/branch
});
