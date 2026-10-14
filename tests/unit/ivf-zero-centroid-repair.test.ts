// tests/unit/ivf-zero-centroid-repair.test.ts
//
// An outside user's store (2026-10-14): 11 centroids, 10 of them all-zero (seeded from the FIRST rows of the vector
// table, which were zero vectors an embed failure had stored before 0.48.0), so all 41,198 vectors sat in the 11th and
// every dedup pass walked 848M pairs. A zero centroid scores 0 and a populated one scores above it: it never wins a row,
// and the mini-batch update only moves winners, so a bad seed was permanent. This builds that state in a real vec0 store
// and runs the real sweep over it.
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { VectorStore } from '../../src/worker/vector-store.ts';
import { runIvfSweepSlice, type IvfSweepDeps } from '../../src/worker/ivf-sweep.ts';
import { DEFAULT_IVF_CONFIG, defaultSample, PARKED_CLUSTER, UNCLUSTERED_CLUSTER } from '../../src/worker/ivf.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

const DIM = 4;
const C = 'c';
const cfg = { ...DEFAULT_IVF_CONFIG, enabled: true, minCorpusSize: 10, targetPerCluster: 10, sweepBatch: 8 };

/** The same wiring the worker uses (index.ts), over a real store. */
function depsFor(store: VectorStore): IvfSweepDeps {
  return {
    collection: C, cfg,
    countLegacyRows: () => store.countLegacyRows(),
    migrateLegacyBatch: (n) => store.migrateLegacyBatch(n),
    countVectors: (c) => store.countVectors(c),
    getCentroids: (c) => store.getCentroids(c),
    setCentroids: (c, cs) => store.setCentroids(c, cs),
    allocateClusterIds: (c, n) => store.allocateClusterIds(c, n),
    sampleAnyVectors: (c, n) => store.sampleAnyVectors(c, n),
    sampleClusteredVectors: (c, n) => store.sampleClusteredVectors(c, n),
    getUnclusteredChunks: (c, n) => store.getUnclusteredChunks(c, n),
    reassignClusterBatch: (items) => store.reassignClusterBatch(items),
    sample: defaultSample,
    yieldToLoop: () => new Promise<void>(r => setImmediate(r)),
  };
}

/** 40 real vectors around the four axes (10 each), and 10 zero vectors. */
async function fill(store: VectorStore): Promise<void> {
  const items: Array<{ id: string; embedding: number[] }> = [];
  for (let a = 0; a < 4; a++) for (let j = 0; j < 10; j++) {
    const v = [0.05 * j, 0.05 * j, 0.05 * j, 0.05 * j]; v[a] = 1;
    items.push({ id: `real-${a}-${j}`, embedding: v });
  }
  for (let j = 0; j < 10; j++) items.push({ id: `zero-${j}`, embedding: [0, 0, 0, 0] });
  await store.add(C, items);
}

function open(dir: string): VectorStore { return new VectorStore({ dbPath: join(dir, 'vec.db'), dimension: DIM }); }

test('sampleAnyVectors draws only vectors with a direction, at random, up to the limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ivf-seed-'));
  try {
    const store = open(dir);
    await fill(store);
    const first = await store.sampleAnyVectors(C, 6);
    expect(first.length).toBe(6);
    expect(first.every(v => v.chunkId.startsWith('real-'))).toBe(true);
    // Not the first six rows each time: ten draws of six leave no single fixed set.
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) for (const v of await store.sampleAnyVectors(C, 6)) seen.add(v.chunkId);
    expect(seen.size).toBeGreaterThan(6);
    // Asking for more than exist hands back every vector that has a direction, and no zero one.
    const all = await store.sampleAnyVectors(C, 500);
    expect(all.length).toBe(40);
    store.close();
  } finally { rmWorkDir(dir); }
});

test('indexSummary counts the all-zero centroids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ivf-sum-'));
  try {
    const store = open(dir);
    expect(store.indexSummary(C).zeroCentroids).toBe(0);
    store.setCentroids(C, [
      { clusterId: 1, hitCount: 9, vector: [1, 0, 0, 0] },
      { clusterId: 2, hitCount: 1, vector: [0, 0, 0, 0] },
      { clusterId: 3, hitCount: 1, vector: [0, 0, 0, 0] },
    ]);
    expect(store.indexSummary(C)).toMatchObject({ centroids: 3, zeroCentroids: 2 });
    store.close();
  } finally { rmWorkDir(dir); }
});

test('the sweep repairs a store seeded with zero centroids: nothing left zero, rows spread, zero vectors parked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ivf-repair-'));
  try {
    const store = open(dir);
    await fill(store);

    // The reported state: one real centroid (a mean-like vector, positive against every row) plus three zero ones,
    // and every row in the real one.
    const [real, ...zeros] = store.allocateClusterIds(C, 4);
    store.setCentroids(C, [
      { clusterId: real!, hitCount: 5000, vector: [0.5, 0.5, 0.5, 0.5] },
      ...zeros.map(clusterId => ({ clusterId, hitCount: 1, vector: [0, 0, 0, 0] })),
    ]);
    const rows = await store.sampleAnyVectors(C, 500);
    store.reassignClusterBatch([
      ...rows.map(r => ({ chunkId: r.chunkId, embedding: r.embedding, clusterId: real! })),
      ...['zero-0', 'zero-1', 'zero-2', 'zero-3', 'zero-4', 'zero-5', 'zero-6', 'zero-7', 'zero-8', 'zero-9']
        .map(chunkId => ({ chunkId, embedding: new Float32Array(DIM), clusterId: real! })),
    ]);
    const before = await store.clusterMembership(C);
    expect([...before.keys()]).toEqual([real!]);
    expect(store.indexSummary(C).zeroCentroids).toBe(3);

    // Run the real sweep until it has nothing left to reset, seed or assign.
    const total = { reset: 0, bootstrapped: 0, assigned: 0 };
    for (let i = 0; i < 200; i++) {
      const r = await runIvfSweepSlice(depsFor(store));
      total.reset += r.reset; total.bootstrapped += r.bootstrapped; total.assigned += r.assigned;
      if (i > 3 && r.reset === 0 && r.bootstrapped === 0 && r.assigned === 0) break;
    }
    expect(total.reset).toBe(50);          // every row went back to unclustered, 8 a slice
    expect(total.bootstrapped).toBeGreaterThan(1);
    expect(total.assigned).toBe(50);       // and was placed again

    expect(store.indexSummary(C).zeroCentroids).toBe(0);
    const ids = new Set(store.getCentroids(C).map(c => c.clusterId));
    expect(ids.has(real!)).toBe(false);    // a fresh set, not the old one patched
    const after = await store.clusterMembership(C);
    let parked = 0, unclustered = 0, placed = 0;
    const populated = new Set<number>();
    for (const [cluster, chunks] of after) {
      if (cluster === PARKED_CLUSTER) { parked += chunks.length; expect(chunks.every(c => c.startsWith('zero-'))).toBe(true); }
      else if (cluster === UNCLUSTERED_CLUSTER) unclustered += chunks.length;
      else { expect(ids.has(cluster)).toBe(true); placed += chunks.length; populated.add(cluster); }
    }
    expect(parked).toBe(10);               // the zero vectors belong to no centroid
    expect(unclustered).toBe(0);
    expect(placed).toBe(40);
    expect(populated.size).toBeGreaterThan(1);   // before: one cluster held everything
    store.close();
  } finally { rmWorkDir(dir); }
});

test('add() does not write a cluster id that a replaced centroid set no longer has', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ivf-race-'));
  try {
    const store = open(dir);
    store.setCentroids(C, [{ clusterId: 10, hitCount: 5, vector: [1, 0, 0, 0] }]);
    // add() picks its cluster, then yields; the repair replaces the whole set in that gap.
    const pending = store.add(C, [{ id: 'late', embedding: [1, 0, 0, 0] }, { id: 'later', embedding: [0.9, 0.1, 0, 0] }]);
    store.setCentroids(C, [{ clusterId: 11, hitCount: 1, vector: [1, 0, 0, 0] }]);
    await pending;
    const m = await store.clusterMembership(C);
    expect(m.has(10)).toBe(false);                       // an id no query probes: the chunk would never be found
    expect([...(m.get(UNCLUSTERED_CLUSTER) ?? [])].sort()).toEqual(['late', 'later']);
    store.close();
  } finally { rmWorkDir(dir); }
});
