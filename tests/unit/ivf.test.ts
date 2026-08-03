// tests/unit/ivf.test.ts
import { test, expect } from 'bun:test';
import {
  DEFAULT_IVF_CONFIG, loadIvfConfig, targetClusterCount,
  nearestCentroid, nearestCentroids, miniBatchUpdate, seedCentroids, defaultSample,
  type Centroid,
} from '../../src/worker/ivf.ts';

test('loadIvfConfig — defaults when env is empty', () => {
  const cfg = loadIvfConfig({});
  expect(cfg).toEqual(DEFAULT_IVF_CONFIG);
});

test('loadIvfConfig — CAPTAIN_MEMO_IVF_ENABLED=1 turns it on; anything else leaves it off', () => {
  expect(loadIvfConfig({ CAPTAIN_MEMO_IVF_ENABLED: '1' }).enabled).toBe(true);
  expect(loadIvfConfig({ CAPTAIN_MEMO_IVF_ENABLED: '0' }).enabled).toBe(false);
  expect(loadIvfConfig({}).enabled).toBe(false);
});

test('loadIvfConfig — numeric overrides parse, unparseable values fall back to default', () => {
  // 7, not the default — an override test that happens to assert the default value passes even
  // when the override is ignored entirely, and proves nothing.
  const cfg = loadIvfConfig({ CAPTAIN_MEMO_IVF_PROBE_CLUSTERS: '7', CAPTAIN_MEMO_IVF_SWEEP_BATCH: 'not-a-number' });
  expect(cfg.probeClusters).toBe(7);
  expect(cfg.probeClusters).not.toBe(DEFAULT_IVF_CONFIG.probeClusters);
  expect(cfg.sweepBatch).toBe(DEFAULT_IVF_CONFIG.sweepBatch);
});

test('targetClusterCount — corpus size divided by targetPerCluster, floored at 1', () => {
  const cfg = { ...DEFAULT_IVF_CONFIG, targetPerCluster: 300 };
  expect(targetClusterCount(90_000, cfg)).toBe(300);
  expect(targetClusterCount(0, cfg)).toBe(1);
  expect(targetClusterCount(50, cfg)).toBe(1);
});

const C = (clusterId: number, vector: number[], hitCount = 1): Centroid => ({ clusterId, vector, hitCount });

test('nearestCentroid — picks the highest-cosine-similarity centroid', () => {
  const centroids = [C(0, [1, 0, 0, 0]), C(1, [0, 1, 0, 0]), C(2, [0, 0, 1, 0])];
  const result = nearestCentroid([0.9, 0.1, 0, 0], centroids);
  expect(result?.clusterId).toBe(0);
});

test('nearestCentroid — returns null for an empty centroid list', () => {
  expect(nearestCentroid([1, 0, 0, 0], [])).toBeNull();
});

test('nearestCentroids — returns the M nearest, sorted nearest-first', () => {
  const centroids = [C(0, [1, 0, 0, 0]), C(1, [0, 1, 0, 0]), C(2, [0.9, 0.1, 0, 0]), C(3, [0, 0, 0, 1])];
  const top2 = nearestCentroids([1, 0, 0, 0], centroids, 2);
  expect(top2.map(c => c.clusterId)).toEqual([0, 2]);
});

test('miniBatchUpdate — assigns each item to its nearest centroid and nudges that centroid toward the batch mean', () => {
  const centroids = [C(0, [1, 0, 0, 0], 10), C(1, [0, 1, 0, 0], 10)];
  const batch = [
    { id: 'a', vector: [0.8, 0, 0, 0] },
    { id: 'b', vector: [0.6, 0, 0, 0] },
  ];
  const cfg = { ...DEFAULT_IVF_CONFIG, minLearningRate: 0.01 };
  const { centroids: next, assignments } = miniBatchUpdate(batch, centroids, cfg);
  expect(assignments).toEqual([{ id: 'a', clusterId: 0 }, { id: 'b', clusterId: 0 }]);
  // cluster 0's centroid moved toward the batch mean [0.7, 0, 0, 0] — first component grew, still < 1
  const c0 = next.find(c => c.clusterId === 0)!;
  expect(c0.vector[0]).toBeGreaterThan(1 * (1 - 2 / (10 + 2))); // moved, not frozen
  expect(c0.hitCount).toBe(12);
  // cluster 1 untouched — no batch items assigned to it
  const c1 = next.find(c => c.clusterId === 1)!;
  expect(c1.vector).toEqual([0, 1, 0, 0]);
  expect(c1.hitCount).toBe(10);
});

test('miniBatchUpdate — an empty batch changes nothing', () => {
  const centroids = [C(0, [1, 0, 0, 0], 5)];
  const { centroids: next, assignments } = miniBatchUpdate([], centroids, DEFAULT_IVF_CONFIG);
  expect(assignments).toEqual([]);
  expect(next).toEqual(centroids);
});

test('seedCentroids — samples `sample`-chosen vectors as initial centroids, tagged with the given cluster ids', () => {
  const vectors = [
    { id: 'v0', vector: [1, 0, 0, 0] },
    { id: 'v1', vector: [0, 1, 0, 0] },
    { id: 'v2', vector: [0, 0, 1, 0] },
  ];
  const deterministicSample = (_n: number, k: number): number[] => Array.from({ length: k }, (_, i) => i);
  const centroids = seedCentroids(vectors, [100, 101], deterministicSample);
  expect(centroids).toEqual([
    { clusterId: 100, vector: [1, 0, 0, 0], hitCount: 1 },
    { clusterId: 101, vector: [0, 1, 0, 0], hitCount: 1 },
  ]);
});

test('defaultSample — returns k distinct indices in [0, n)', () => {
  const indices = defaultSample(50, 10);
  expect(indices.length).toBe(10);
  expect(new Set(indices).size).toBe(10);
  for (const i of indices) expect(i).toBeGreaterThanOrEqual(0);
  for (const i of indices) expect(i).toBeLessThan(50);
});

test('defaultSample — k >= n returns all indices, no duplicates, no throw', () => {
  const indices = defaultSample(3, 10);
  expect(new Set(indices)).toEqual(new Set([0, 1, 2]));
});
