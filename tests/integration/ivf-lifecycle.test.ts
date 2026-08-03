// tests/integration/ivf-lifecycle.test.ts — drives the full A2 lifecycle
// through a real worker: below-threshold brute force -> bootstrap -> backfill
// -> steady-state clustered search, all via the real HTTP surface plus direct
// VectorStore introspection for the internal-state assertions HTTP can't see.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { VectorStore } from '../../src/worker/vector-store.ts';
import { DEFAULT_IVF_CONFIG } from '../../src/worker/ivf.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

let workDir: string;
let worker: WorkerHandle;
const DIM = 4;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-ivf-lifecycle-'));
});

afterEach(async () => {
  if (worker) await worker.stop();
  rmWorkDir(workDir);
});

test('IVF lifecycle: below threshold stays brute-force-correct; crossing it clusters without losing recall', async () => {
  const vectorDbPath = join(workDir, 'vec.db');
  worker = await startWorker({
    port: 0,
    projectId: 'lifecycle-proj',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath,
    embeddingDimension: DIM,
    skipEmbed: true,
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    summarize: async (events) => ({
      type: 'change', title: `summary of ${events.length} events`,
      narrative: 'stub', facts: [], concepts: [],
    }),
    observationTickMs: 0,
  });

  const collection = 'am_lifecycle-proj';
  // Directly seed the vector store below the clustering threshold — this test
  // is about VectorStore's own lifecycle, so it drives it directly rather
  // than indirectly through observation ingest embeddings (which aren't real
  // 4-dim vectors here; skipEmbed produces zero vectors, unusable for a
  // recall check).
  const direct = new VectorStore({
    dbPath: vectorDbPath,
    dimension: DIM,
    ivfConfig: { ...DEFAULT_IVF_CONFIG, enabled: true, minCorpusSize: 10, targetPerCluster: 2 },
  });

  // Phase 1: below threshold (5 vectors < minCorpusSize 10) — brute force only.
  await direct.add(collection, [
    { id: 'v0', embedding: [1, 0, 0, 0] },
    { id: 'v1', embedding: [0, 1, 0, 0] },
    { id: 'v2', embedding: [0, 0, 1, 0] },
    { id: 'v3', embedding: [0, 0, 0, 1] },
    { id: 'v4', embedding: [0.9, 0.1, 0, 0] },
  ]);
  const belowThreshold = await direct.query(collection, [1, 0, 0, 0], 2);
  expect(belowThreshold.map(r => r.id)).toEqual(['v0', 'v4']);
  expect(direct.getCentroids(collection)).toEqual([]); // confirms this really was the fallback path

  // Phase 2: cross the threshold (10 vectors) and run sweep ticks until fully clustered.
  await direct.add(collection, [
    { id: 'v5', embedding: [0.1, 0.9, 0, 0] },
    { id: 'v6', embedding: [0, 0.1, 0.9, 0] },
    { id: 'v7', embedding: [0, 0, 0.1, 0.9] },
    { id: 'v8', embedding: [0.85, 0.15, 0, 0] },
    { id: 'v9', embedding: [0, 0.85, 0.15, 0] },
  ]);
  expect(direct.countVectors(collection)).toBe(10);

  const { runIvfSweepSlice } = await import('../../src/worker/ivf-sweep.ts');
  const { defaultSample } = await import('../../src/worker/ivf.ts');
  const cfg = { ...DEFAULT_IVF_CONFIG, enabled: true, minCorpusSize: 10, targetPerCluster: 2 };
  const sweepDeps = {
    collection,
    cfg,
    countLegacyRows: () => direct.countLegacyRows(),
    migrateLegacyBatch: (limit: number) => direct.migrateLegacyBatch(limit),
    countVectors: (c: string) => direct.countVectors(c),
    getCentroids: (c: string) => direct.getCentroids(c),
    setCentroids: (c: string, centroids: ReturnType<typeof direct.getCentroids>) => direct.setCentroids(c, centroids),
    allocateClusterIds: (c: string, n: number) => direct.allocateClusterIds(c, n),
    sampleAnyVectors: (c: string, limit: number) => direct.sampleAnyVectors(c, limit),
    sampleClusteredVectors: (c: string, limit: number) => direct.sampleClusteredVectors(c, limit),
    getUnclusteredChunks: (c: string, limit: number) => direct.getUnclusteredChunks(c, limit),
    reassignClusterBatch: (items: Array<{ chunkId: string; embedding: Float32Array; clusterId: number }>) =>
      direct.reassignClusterBatch(items),
    sample: defaultSample,
    yieldToLoop: () => Promise.resolve(),
  };

  // Tick 1: bootstrap. Ticks 2+: assign remaining unclustered chunks (one
  // sweepBatch-sized group at a time, but sweepBatch (256) exceeds our 10
  // rows, so a single assignment tick should clear all of them).
  let ticks = 0;
  while (direct.getUnclusteredChunks(collection, 1).length > 0 || direct.getCentroids(collection).length === 0) {
    await runIvfSweepSlice(sweepDeps);
    ticks++;
    expect(ticks).toBeLessThan(10); // guard against an infinite loop if something's wrong
  }
  expect(direct.getCentroids(collection).length).toBeGreaterThan(0);
  expect(direct.getUnclusteredChunks(collection, 100)).toEqual([]);

  // Phase 3: steady-state clustered query still finds the true nearest neighbors.
  const afterClustering = await direct.query(collection, [1, 0, 0, 0], 3);
  expect(afterClustering.map(r => r.id)).toContain('v0');
  expect(afterClustering.map(r => r.id)).toContain('v4');

  direct.close();
});
