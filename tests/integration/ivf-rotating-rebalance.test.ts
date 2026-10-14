// tests/integration/ivf-rotating-rebalance.test.ts
//
// The rebalance re-read the same leading 64 rows every sweep (a copy of the dev store, 279,227 vectors / 477 centroids,
// 2026-10-14: all 64 sat in cluster 0, a cluster of 101, whose hit_count was 1.36M). sampleRebalanceVectors walks the corpus
// instead. Real vec0 store, 4 dimensions.
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { VectorStore } from '../../src/worker/vector-store.ts';
import { DEFAULT_IVF_CONFIG } from '../../src/worker/ivf.ts';
import { rmWorkDir } from '../support/worker-temp.ts';
import { realVectors, zeros } from '../support/ivf-vectors.ts';

const DIM = 4;
const C = 'c';
const cfg = { ...DEFAULT_IVF_CONFIG, enabled: true, minCorpusSize: 10, targetPerCluster: 10, sweepBatch: 8 };

function open(dir: string): VectorStore { return new VectorStore({ dbPath: join(dir, 'vec.db'), dimension: DIM, ivfConfig: cfg }); }

/** Every row into some cluster id >= 0, as a finished sweep leaves them. */
function clusterAll(store: VectorStore, ids: string[]): void {
  store.reassignClusterBatch(ids.map(id => ({ chunkId: id, embedding: store.getEmbedding(id)!, clusterId: id.length % 2 })));
}

test('sampleRebalanceVectors rotates through the corpus; sampleClusteredVectors returns the same leading rows every call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ivf-rot-'));
  try {
    const store = open(dir);
    const rows = realVectors(24, 'row-');
    await store.add(C, rows);
    clusterAll(store, rows.map(r => r.id));

    const leading = new Set<string>();
    for (let i = 0; i < 4; i++) for (const r of store.sampleClusteredVectors(C, 6)) leading.add(r.chunkId);
    expect(leading.size).toBe(6);                       // today's contract: four calls, the same six rows

    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const page = store.sampleRebalanceVectors(C, 6);
      expect(new Set(page.map(r => r.chunkId)).size).toBe(6);   // no row twice in one call
      for (const r of page) seen.add(r.chunkId);
    }
    expect(seen.size).toBe(24);                         // four calls of six cover all 24, wherever the lap started
    store.close();
  } finally { rmWorkDir(dir); }
});

test('sampleRebalanceVectors: only clustered rows of the asked collection, each with its cluster; fewer rows than the limit come back once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ivf-rot-'));
  try {
    const store = open(dir);
    const mine = realVectors(5, 'mine-');
    await store.add(C, [...mine, ...realVectors(3, 'unplaced-', 7), ...zeros(2, 'parked-')]);
    await store.add('other', realVectors(4, 'theirs-', 9));
    clusterAll(store, mine.map(r => r.id));
    clusterAll(store, ['theirs-0', 'theirs-1', 'theirs-2', 'theirs-3']);
    store.reassignClusterBatch(['parked-0', 'parked-1'].map(id => ({ chunkId: id, embedding: store.getEmbedding(id)!, clusterId: -2 })));

    const page = store.sampleRebalanceVectors(C, 100);
    expect(page.map(r => r.chunkId).sort()).toEqual(mine.map(r => r.id).sort());   // not -1, not -2, not 'other'
    expect(page.every(r => r.clusterId === r.chunkId.length % 2)).toBe(true);
    expect(page.every(r => r.embedding.length === DIM)).toBe(true);
    expect(store.sampleRebalanceVectors('empty-collection', 8)).toEqual([]);
    store.close();
  } finally { rmWorkDir(dir); }
});
