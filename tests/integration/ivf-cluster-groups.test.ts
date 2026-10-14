// tests/integration/ivf-cluster-groups.test.ts
//
// The same guard over a real vec0 store: membership comes from the shadow tables, so the unclustered partition really is a
// bucket of VectorStore.clusterMembership, and the collection's centroids decide whether the finder may see it.
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { VectorStore } from '../../src/worker/vector-store.ts';
import { observationGroups } from '../../src/worker/ivf.ts';
import { rmWorkDir } from '../support/worker-temp.ts';
import { realVectors, zeros } from '../support/ivf-vectors.ts';

const C = 'c';

test('while a collection has centroids the unclustered rows are not a group; without centroids they are', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ivf-groups-'));
  try {
    const store = new VectorStore({ dbPath: join(dir, 'vec.db'), dimension: 4 });
    const placed = realVectors(8, 'placed-');
    const waiting = realVectors(10, 'waiting-', 5);
    await store.add(C, [...placed, ...waiting, ...zeros(3, 'parked-')]);
    const move = (ids: string[], clusterId: number) =>
      store.reassignClusterBatch(ids.map(id => ({ chunkId: id, embedding: store.getEmbedding(id)!, clusterId })));
    move(placed.slice(0, 4).map(r => r.id), 100);
    move(placed.slice(4).map(r => r.id), 101);
    move(['parked-0', 'parked-1', 'parked-2'], -2);

    const obsByChunk = new Map<string, number>();
    for (const id of [...placed, ...waiting].map(r => r.id).concat(['parked-0', 'parked-1', 'parked-2'])) obsByChunk.set(id, obsByChunk.size);
    const membership = await store.clusterMembership(C);
    expect(membership.get(-1)!.length).toBe(10);          // the partition is there, as one bucket

    const noCentroids = observationGroups(membership, obsByChunk, store.getCentroids(C).length > 0);
    expect(noCentroids.map(g => g.length).sort((a, b) => a - b)).toEqual([4, 4, 10]);

    store.setCentroids(C, [
      { clusterId: 100, vector: [1, 0, 0, 0], hitCount: 1 },
      { clusterId: 101, vector: [0, 1, 0, 0], hitCount: 1 },
    ]);
    const indexed = observationGroups(membership, obsByChunk, store.getCentroids(C).length > 0);
    expect(indexed.map(g => g.length).sort()).toEqual([4, 4]);
    const waitingObs = new Set(waiting.map(r => obsByChunk.get(r.id)!));
    expect(indexed.flat().some(id => waitingObs.has(id))).toBe(false);
    store.close();
  } finally { rmWorkDir(dir); }
});
