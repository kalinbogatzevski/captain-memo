// tests/unit/ivf-rotation.test.ts
//
// The rebalance re-read the same leading 64 rows every sweep (all 64 in cluster 0, a cluster of 101, on the dev store), so
// it never rotated and hit_count was not membership. It now reads a sample that walks the corpus, and it revisits rows that
// are already placed, so it must not pull a centroid toward them at the rate a new row would get.
import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runIvfSweepSlice, type IvfSweepDeps } from '../../src/worker/ivf-sweep.ts';
import { DEFAULT_IVF_CONFIG, miniBatchUpdate, type Centroid } from '../../src/worker/ivf.ts';

const cfg = { ...DEFAULT_IVF_CONFIG, enabled: true, minCorpusSize: 10, targetPerCluster: 10 };

function baseDeps(overrides: Partial<IvfSweepDeps> = {}): IvfSweepDeps {
  return {
    collection: 'c', cfg,
    countLegacyRows: () => 0, migrateLegacyBatch: () => 0, countVectors: () => 0,
    getCentroids: () => [], setCentroids: () => {}, allocateClusterIds: () => [],
    sampleAnyVectors: () => [], sampleClusteredVectors: () => [], getUnclusteredChunks: () => [],
    reassignClusterBatch: () => {},
    sample: (n, k) => Array.from({ length: Math.min(n, k) }, (_, i) => i),
    yieldToLoop: () => Promise.resolve(),
    ...overrides,
  };
}

const cent = (id: number, v: number[], hitCount = 50): Centroid => ({ clusterId: id, vector: v, hitCount });

test('rebalance — reads the rotating sample when the worker wires one, the leading rows when it does not', async () => {
  const centroids = [cent(1, [1, 0, 0, 0]), cent(2, [0, 1, 0, 0])];
  const row = (id: string) => [{ chunkId: id, embedding: Float32Array.from([0, 1, 0, 0]), clusterId: 1 }];   // nearest is cluster 2
  const movedWith = async (over: Partial<IvfSweepDeps>): Promise<string[]> => {
    const moved: string[] = [];
    await runIvfSweepSlice(baseDeps({
      countVectors: () => 20, getCentroids: () => centroids,
      reassignClusterBatch: (items) => { for (const i of items) moved.push(i.chunkId); },
      ...over,
    }));
    return moved;
  };
  expect(await movedWith({ sampleClusteredVectors: () => row('leading'), sampleRebalanceVectors: () => row('rotated') })).toEqual(['rotated']);
  expect(await movedWith({ sampleClusteredVectors: () => row('leading') })).toEqual(['leading']);
});

test('rebalance — a re-visited row pulls its centroid at the learning-rate floor, not at hits/(1+hits)', () => {
  const fresh = [cent(1, [1, 0], 1)];            // hit_count 1: add() never raises it, so 54 of the dev store's 477 sit here
  const batch = [{ id: 'r', vector: [0, 1] }];
  const asNew = miniBatchUpdate(batch, fresh, cfg).centroids[0]!;
  const asRevisit = miniBatchUpdate(batch, fresh, cfg, undefined, true).centroids[0]!;
  expect(asNew.vector[1]!).toBeCloseTo(0.5, 5);                                 // half way to one row
  expect(asRevisit.vector[1]!).toBeCloseTo(cfg.minLearningRate, 5);             // 0.01
  expect(asRevisit.hitCount).toBe(2);                                            // still counted, as before
});

test('the worker wires the rotating sample into the sweep (the dep is optional and falls back to the leading rows silently)', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/worker/index.ts'), 'utf-8');
  const call = src.slice(src.indexOf('runIvfSweepSlice({'), src.indexOf('sample: defaultSample'));
  expect(call).toContain('sampleRebalanceVectors: (coll, limit) => vector.sampleRebalanceVectors(coll, limit)');
});
