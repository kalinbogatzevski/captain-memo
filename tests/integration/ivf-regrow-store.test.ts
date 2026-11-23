// tests/integration/ivf-regrow-store.test.ts
//
// K, the cluster count, was chosen once, at the bootstrap. The sweep now splits a cluster the corpus has outgrown, and that
// must never strand a row under a cluster id no query probes, never park rows in the unclustered partition (a query scans it
// flat), and must survive a restart halfway. Real vec0 store, 4 dimensions.
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { VectorStore } from '../../src/worker/vector-store.ts';
import { runIvfSweepSlice, type IvfSweepDeps, type IvfSweepResult } from '../../src/worker/ivf-sweep.ts';
import { DEFAULT_IVF_CONFIG, defaultSample } from '../../src/worker/ivf.ts';
import { rmWorkDir } from '../support/worker-temp.ts';
import { realVectors } from '../support/ivf-vectors.ts';

const DIM = 4;
const C = 'c';
const cfg = { ...DEFAULT_IVF_CONFIG, enabled: true, minCorpusSize: 10, targetPerCluster: 10, sweepBatch: 8, regrowRatio: 3 };

function open(dir: string): VectorStore { return new VectorStore({ dbPath: join(dir, 'vec.db'), dimension: DIM, ivfConfig: cfg }); }

/** The wiring index.ts uses, over a real store. */
function depsFor(store: VectorStore, c: typeof cfg = cfg): IvfSweepDeps {
  return {
    collection: C, cfg: c,
    countLegacyRows: () => store.countLegacyRows(),
    migrateLegacyBatch: (n) => store.migrateLegacyBatch(n),
    countVectors: (k) => store.countVectors(k),
    getCentroids: (k) => store.getCentroids(k),
    setCentroids: (k, cs, builtFor) => store.setCentroids(k, cs, builtFor),
    updateCentroids: (k, cs) => store.updateCentroids(k, cs),
    split: {
      current: (k) => store.splitInProgress(k),
      largest: (ids, over) => store.largestCluster(ids, over),
      rows: (id, n) => store.clusterRows(id, n),
      sample: (id, n) => store.sampleClusterVectors(id, n),
      start: (k, id, seeds) => store.startSplit(k, id, seeds),
      finish: (k, id, drop) => store.finishSplit(k, id, drop),
    },
    allocateClusterIds: (k, n) => store.allocateClusterIds(k, n),
    sampleAnyVectors: (k, n) => store.sampleAnyVectors(k, n),
    sampleClusteredVectors: (k, n) => store.sampleClusteredVectors(k, n),
    sampleRebalanceVectors: (k, n) => store.sampleRebalanceVectors(k, n),
    getUnclusteredChunks: (k, n) => store.getUnclusteredChunks(k, n),
    reassignClusterBatch: (items) => store.reassignClusterBatch(items),
    sample: defaultSample,
    yieldToLoop: () => Promise.resolve(),
  };
}

async function sweep(store: VectorStore, slices: number, c: typeof cfg = cfg): Promise<IvfSweepResult> {
  const total: IvfSweepResult = { legacyMigrated: 0, bootstrapped: 0, assigned: 0, rebalanced: 0, reset: 0, split: 0 };
  const deps = depsFor(store, c);
  for (let i = 0; i < slices; i++) {
    const r = await runIvfSweepSlice(deps);
    for (const k of Object.keys(total) as Array<keyof IvfSweepResult>) total[k] += r[k];
  }
  return total;
}

test('setCentroids records the size the index was built for only when the bootstrap says so, and a bootstrap drops a split', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ivf-boot-'));
  try {
    const store = open(dir);
    const cs = [{ clusterId: 1, vector: [1, 0, 0, 0], hitCount: 1 }];
    expect(store.bootstrapSize(C)).toBeNull();
    store.setCentroids(C, cs);
    expect(store.bootstrapSize(C)).toBeNull();
    store.setCentroids(C, cs, 120);
    expect(store.bootstrapSize(C)).toBe(120);
    store.setCentroids(C, cs);                           // a drift update from an assign or rebalance slice
    expect(store.bootstrapSize(C)).toBe(120);
    expect(store.bootstrapSize('elsewhere')).toBeNull();
    store.startSplit(C, 1, [{ clusterId: 2, vector: [0, 1, 0, 0], hitCount: 1 }]);
    expect(store.splitInProgress(C)).toEqual({ clusterId: 1, seedLo: 2, seedHi: 2 });
    store.setCentroids(C, cs);                           // a drift update keeps the split
    expect(store.splitInProgress(C)).not.toBeNull();
    store.setCentroids(C, cs, 130);                      // a bootstrap replaces the ids it named
    expect(store.splitInProgress(C)).toBeNull();
    store.close();
  } finally { rmWorkDir(dir); }
});

/** One store whose bootstrap saw 30 vectors (3 clusters), then 60 more near one of them: that cluster is past 3 x 10. */
async function grown(store: VectorStore): Promise<Array<{ id: string; embedding: number[] }>> {
  const first = realVectors(30, 'a-', 3);
  await store.add(C, first);
  await sweep(store, 12);
  expect(store.getCentroids(C).length).toBe(3);
  const near = first[0]!.embedding;
  const more = realVectors(60, 'b-', 5).map(r => ({ id: r.id, embedding: near.map((x, i) => x + 0.05 * r.embedding[i]!) }));
  await store.add(C, more);                            // add() places each in its nearest cluster
  return [...first, ...more];
}

const sizes = async (store: VectorStore): Promise<Map<number, number>> =>
  new Map([...await store.clusterMembership(C)].map(([k, ids]) => [k, ids.length]));

test('an oversized cluster is split into seeds of its own: no row is ever unclustered or hidden while that happens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ivf-split-'));
  try {
    const store = open(dir);
    const all = await grown(store);
    expect(Math.max(...(await sizes(store)).values())).toBeGreaterThan(30);
    let splitRows = 0;
    for (let i = 0; i < 60; i++) {
      const r = await runIvfSweepSlice(depsFor(store));
      splitRows += r.split;
      expect(r.reset).toBe(0);
      const m = await sizes(store);
      expect(m.get(-1) ?? 0).toBe(0);                    // never parked in the partition a query scans flat
      expect(store.indexSummary(C).assigned).toBe(90);
      const live = new Set(store.getCentroids(C).map(c => c.clusterId));
      expect([...m.keys()].every(id => live.has(id))).toBe(true);
      for (const v of all.filter((_, j) => j % 9 === 0)) {
        expect((await store.query(C, v.embedding, 3)).map(t => t.id)).toContain(v.id);
      }
    }
    expect(splitRows).toBeGreaterThan(30);
    expect(store.splitInProgress(C)).toBeNull();
    const after = await sizes(store);
    expect(Math.max(...after.values())).toBeLessThanOrEqual(30);
    expect([...after.values()].reduce((a, b) => a + b, 0)).toBe(90);
    store.close();
  } finally { rmWorkDir(dir); }
});

test('a split survives a restart halfway: the record is on disk and the next worker carries on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ivf-split-restart-'));
  try {
    let store = open(dir);
    await grown(store);
    const first = await runIvfSweepSlice(depsFor(store));
    expect(first.split).toBe(8);
    const rec = store.splitInProgress(C)!;
    expect(rec).not.toBeNull();
    store.close();

    store = open(dir);
    expect(store.splitInProgress(C)).toEqual(rec);
    const r = await runIvfSweepSlice(depsFor(store));
    expect(r.split).toBe(8);
    expect(store.splitInProgress(C)!.clusterId).toBe(rec.clusterId);   // the same split, not a second one
    await sweep(store, 60);
    expect(store.splitInProgress(C)).toBeNull();
    expect(store.getCentroids(C).some(c => c.clusterId === rec.clusterId)).toBe(false);
    expect(Math.max(...(await sizes(store)).values())).toBeLessThanOrEqual(30);
    store.close();
  } finally { rmWorkDir(dir); }
});
