// tests/integration/ivf-centroid-write.test.ts
//
// VectorStore.updateCentroids over a real store: only the rows it is given change on disk (setCentroids deletes and re-inserts
// every row, so a row it did not touch would get a new rowid), the cached set agrees with the disk, and an id it does not hold is
// not created.
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { VectorStore } from '../../src/worker/vector-store.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

const C = 'c';

test('updateCentroids writes only the centroids it is given, and the cache and a fresh open both see them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ivf-cwrite-'));
  const dbPath = join(dir, 'vec.db');
  try {
    const store = new VectorStore({ dbPath, dimension: 4 });
    store.setCentroids(C, [
      { clusterId: 1, vector: [1, 0, 0, 0], hitCount: 5 },
      { clusterId: 2, vector: [0, 1, 0, 0], hitCount: 6 },
      { clusterId: 3, vector: [0, 0, 1, 0], hitCount: 7 },
    ], 90);
    store.setCentroids('other', [{ clusterId: 9, vector: [1, 1, 0, 0], hitCount: 1 }]);
    const rowids = () => (store as any).db.query('SELECT cluster_id, rowid FROM vec_cluster_centroids ORDER BY cluster_id').all() as Array<{ cluster_id: number; rowid: number }>;
    const before = rowids();

    store.updateCentroids(C, [{ clusterId: 2, vector: [0.1, 0.9, 0.1, 0], hitCount: 70 }, { clusterId: 77, vector: [1, 1, 1, 1], hitCount: 1 }]);

    expect(rowids()).toEqual(before);                                   // nothing deleted, nothing re-inserted, 77 not created
    const cached = store.getCentroids(C);
    expect(cached.map(c => [c.clusterId, c.hitCount])).toEqual([[1, 5], [2, 70], [3, 7]]);
    expect(cached.find(c => c.clusterId === 2)!.vector[1]).toBeCloseTo(0.9, 6);
    expect(store.bootstrapSize(C)).toBe(90);                            // a drift update leaves the recorded build size alone
    expect(store.getCentroids('other').length).toBe(1);

    const fresh = new VectorStore({ dbPath, dimension: 4, readonly: true });
    expect(fresh.getCentroids(C)).toEqual(cached);                       // what is on disk is what the cache holds, to the float
    fresh.close();
    store.updateCentroids(C, []);                                       // nothing to do
    store.close();
  } finally { rmWorkDir(dir); }
});
