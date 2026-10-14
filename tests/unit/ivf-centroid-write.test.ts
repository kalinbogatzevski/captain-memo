// tests/unit/ivf-centroid-write.test.ts
//
// Every assign and rebalance slice rewrote the whole centroid set (delete + K inserts) although a slice of 64 rows moves at most 64
// of K centroids: 636 ms p50 of a 2.4 s assign slice at 931 centroids on the dev copy. The sweep now writes back only the
// centroids that moved (miniBatchUpdate hands the rest back as the same object).
import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runIvfSweepSlice, type IvfSweepDeps } from '../../src/worker/ivf-sweep.ts';
import { DEFAULT_IVF_CONFIG, type Centroid } from '../../src/worker/ivf.ts';

const cfg = { ...DEFAULT_IVF_CONFIG, enabled: true, minCorpusSize: 10, targetPerCluster: 10, regrowRatio: 0 };

function baseDeps(overrides: Partial<IvfSweepDeps> = {}): IvfSweepDeps {
  return {
    collection: 'c', cfg,
    countLegacyRows: () => 0, migrateLegacyBatch: () => 0, countVectors: () => 30,
    getCentroids: () => [], setCentroids: () => {}, allocateClusterIds: () => [],
    sampleAnyVectors: () => [], sampleClusteredVectors: () => [], getUnclusteredChunks: () => [],
    reassignClusterBatch: () => {},
    sample: (n, k) => Array.from({ length: Math.min(n, k) }, (_, i) => i),
    yieldToLoop: () => Promise.resolve(),
    ...overrides,
  };
}

const THREE: Centroid[] = [
  { clusterId: 1, vector: [1, 0, 0, 0], hitCount: 50 },
  { clusterId: 2, vector: [0, 1, 0, 0], hitCount: 50 },
  { clusterId: 3, vector: [0, 0, 1, 0], hitCount: 50 },
];

test('assign slice — only the centroid that received rows is written back, with its new hit_count', async () => {
  const wrote: Centroid[][] = [];
  let replaced = false;
  const result = await runIvfSweepSlice(baseDeps({
    getCentroids: () => THREE,
    getUnclusteredChunks: () => [{ chunkId: 'n1', embedding: Float32Array.from([0, 0.9, 0.1, 0]) }],
    updateCentroids: (_c, changed) => { wrote.push(changed); },
    setCentroids: () => { replaced = true; },
  }));
  expect(result.assigned).toBe(1);
  expect(replaced).toBe(false);
  expect(wrote.length).toBe(1);
  expect(wrote[0]!.map(c => c.clusterId)).toEqual([2]);
  expect(wrote[0]![0]!.hitCount).toBe(51);
});

test('rebalance slice — rows that all rank to one centroid write that centroid only; a slice that moves none writes nothing', async () => {
  const wrote: number[][] = [];
  const deps = (rows: Array<[string, number[]]>) => baseDeps({
    getCentroids: () => THREE,
    sampleClusteredVectors: () => rows.map(([chunkId, v]) => ({ chunkId, embedding: Float32Array.from(v), clusterId: 1 })),
    updateCentroids: (_c, changed) => { wrote.push(changed.map(c => c.clusterId)); },
  });
  await runIvfSweepSlice(deps([['a', [1, 0, 0, 0]], ['b', [0.9, 0.1, 0, 0]]]));
  expect(wrote).toEqual([[1]]);
  wrote.length = 0;
  await runIvfSweepSlice(deps([]));                 // nothing sampled: no centroid moved
  expect(wrote).toEqual([]);
});

test('no updateCentroids wired: the whole set is replaced, as before', async () => {
  const sets: Centroid[][] = [];
  await runIvfSweepSlice(baseDeps({
    getCentroids: () => THREE,
    getUnclusteredChunks: () => [{ chunkId: 'n1', embedding: Float32Array.from([0, 0.9, 0.1, 0]) }],
    setCentroids: (_c, cs) => { sets.push(cs); },
  }));
  expect(sets.length).toBe(1);
  expect(sets[0]!.map(c => c.clusterId)).toEqual([1, 2, 3]);
});

test('the worker wires the touched-only write into the sweep', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/worker/index.ts'), 'utf-8');
  const call = src.slice(src.indexOf('runIvfSweepSlice({'), src.indexOf('sample: defaultSample'));
  expect(call).toContain('updateCentroids: (coll, changed) => vector.updateCentroids(coll, changed)');
});
