// tests/unit/ivf-sweep.test.ts
import { test, expect } from 'bun:test';
import { runIvfSweepSlice, type IvfSweepDeps } from '../../src/worker/ivf-sweep.ts';
import { DEFAULT_IVF_CONFIG, type Centroid } from '../../src/worker/ivf.ts';

const noopYield = () => Promise.resolve();

function baseDeps(overrides: Partial<IvfSweepDeps> = {}): IvfSweepDeps {
  return {
    collection: 'coll_a',
    cfg: { ...DEFAULT_IVF_CONFIG, enabled: true, minCorpusSize: 3 },
    countLegacyRows: () => 0,
    migrateLegacyBatch: () => 0,
    countVectors: () => 0,
    getCentroids: () => [],
    setCentroids: () => {},
    allocateClusterIds: () => [],
    sampleAnyVectors: () => [],
    sampleClusteredVectors: () => [],
    getUnclusteredChunks: () => [],
    reassignClusterBatch: () => {},
    sample: (n: number, k: number) => Array.from({ length: Math.min(n, k) }, (_, i) => i),
    yieldToLoop: noopYield,
    ...overrides,
  };
}

test('runIvfSweepSlice — disabled config is a no-op', async () => {
  const result = await runIvfSweepSlice(baseDeps({ cfg: { ...DEFAULT_IVF_CONFIG, enabled: false } }));
  expect(result).toEqual({ legacyMigrated: 0, bootstrapped: 0, assigned: 0, rebalanced: 0 });
});

test('runIvfSweepSlice — legacy rows present: migrates one batch and stops (does not also cluster this tick)', async () => {
  let migrateCalls = 0;
  const result = await runIvfSweepSlice(baseDeps({
    countLegacyRows: () => 500,
    migrateLegacyBatch: (limit) => { migrateCalls++; return limit; },
  }));
  expect(migrateCalls).toBe(1);
  expect(result.legacyMigrated).toBe(DEFAULT_IVF_CONFIG.sweepBatch);
  expect(result.bootstrapped).toBe(0);
});

test('runIvfSweepSlice — legacy migration runs even when clustering itself is DISABLED (the critical case: default config, existing install)', async () => {
  let migrateCalls = 0;
  const result = await runIvfSweepSlice(baseDeps({
    cfg: { ...DEFAULT_IVF_CONFIG, enabled: false }, // the actual shipped default
    countLegacyRows: () => 500,
    migrateLegacyBatch: (limit) => { migrateCalls++; return limit; },
  }));
  expect(migrateCalls).toBe(1);
  expect(result.legacyMigrated).toBe(DEFAULT_IVF_CONFIG.sweepBatch);
});

test('runIvfSweepSlice — disabled AND no legacy rows: a true no-op (clustering itself never starts)', async () => {
  const result = await runIvfSweepSlice(baseDeps({
    cfg: { ...DEFAULT_IVF_CONFIG, enabled: false },
    countLegacyRows: () => 0,
    countVectors: () => 10_000, // well above any threshold — must NOT bootstrap, because enabled is false
  }));
  expect(result).toEqual({ legacyMigrated: 0, bootstrapped: 0, assigned: 0, rebalanced: 0 });
});

test('runIvfSweepSlice — below minCorpusSize: does nothing (no bootstrap)', async () => {
  const result = await runIvfSweepSlice(baseDeps({
    cfg: { ...DEFAULT_IVF_CONFIG, enabled: true, minCorpusSize: 100 },
    countVectors: () => 50,
  }));
  expect(result).toEqual({ legacyMigrated: 0, bootstrapped: 0, assigned: 0, rebalanced: 0 });
});

test('runIvfSweepSlice — corpus above threshold, no centroids yet: bootstraps via sampleAnyVectors + allocateClusterIds + seedCentroids', async () => {
  const vectors = [
    { chunkId: 'v0', embedding: Float32Array.from([1, 0, 0, 0]) },
    { chunkId: 'v1', embedding: Float32Array.from([0, 1, 0, 0]) },
    { chunkId: 'v2', embedding: Float32Array.from([0, 0, 1, 0]) },
  ];
  let setCentroidsCalledWith: Centroid[] | null = null;
  const result = await runIvfSweepSlice(baseDeps({
    cfg: { ...DEFAULT_IVF_CONFIG, enabled: true, minCorpusSize: 3, targetPerCluster: 1 }, // 3 vectors / 1 = K=3
    countVectors: () => 3,
    sampleAnyVectors: () => vectors,
    allocateClusterIds: (_collection, n) => Array.from({ length: n }, (_, i) => 100 + i),
    setCentroids: (_collection, centroids) => { setCentroidsCalledWith = centroids; },
  }));
  expect(result.bootstrapped).toBe(3);
  expect(setCentroidsCalledWith).not.toBeNull();
  expect(setCentroidsCalledWith!.map(c => c.clusterId)).toEqual([100, 101, 102]);
});

test('runIvfSweepSlice — centroids exist, unclustered chunks remain: assigns one batch via reassignClusterBatch', async () => {
  const centroids: Centroid[] = [{ clusterId: 0, vector: [1, 0, 0, 0], hitCount: 5 }];
  const unclustered = [{ chunkId: 'new1', embedding: Float32Array.from([0.9, 0, 0, 0]) }];
  const reassignCalls: Array<{ chunkId: string; clusterId: number }> = [];
  const result = await runIvfSweepSlice(baseDeps({
    countVectors: () => 10,
    getCentroids: () => centroids,
    getUnclusteredChunks: () => unclustered,
    reassignClusterBatch: (items) => { for (const i of items) reassignCalls.push({ chunkId: i.chunkId, clusterId: i.clusterId }); },
  }));
  expect(result.assigned).toBe(1);
  expect(reassignCalls).toEqual([{ chunkId: 'new1', clusterId: 0 }]);
});

test('runIvfSweepSlice — no unclustered chunks left: rebalances a sample of already-clustered vectors, only reassigning ones whose nearest cluster changed', async () => {
  const centroids: Centroid[] = [
    { clusterId: 0, vector: [1, 0, 0, 0], hitCount: 5 },
    { clusterId: 1, vector: [0, 1, 0, 0], hitCount: 5 },
  ];
  // 'stays' is nearest to cluster 0 and already IS cluster 0 — must not be reassigned.
  // 'moves' is nearest to cluster 1 but is currently (stale) cluster 0 — must be reassigned.
  const sample = [
    { chunkId: 'stays', embedding: Float32Array.from([1, 0, 0, 0]), clusterId: 0 },
    { chunkId: 'moves', embedding: Float32Array.from([0, 0.9, 0, 0]), clusterId: 0 },
  ];
  const reassignCalls: Array<{ chunkId: string; clusterId: number }> = [];
  const result = await runIvfSweepSlice(baseDeps({
    countVectors: () => 10,
    getCentroids: () => centroids,
    getUnclusteredChunks: () => [],
    sampleClusteredVectors: () => sample,
    reassignClusterBatch: (items) => { for (const i of items) reassignCalls.push({ chunkId: i.chunkId, clusterId: i.clusterId }); },
  }));
  expect(result.rebalanced).toBe(1);
  expect(reassignCalls).toEqual([{ chunkId: 'moves', clusterId: 1 }]);
});
