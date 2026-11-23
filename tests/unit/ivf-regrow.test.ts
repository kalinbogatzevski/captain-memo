// tests/unit/ivf-regrow.test.ts
//
// The cluster count K is chosen once, at the bootstrap, and the corpus keeps growing into it (an outside user's store kept
// 11 centroids at 40.9k vectors). The sweep splits a cluster that holds more than regrowRatio x targetPerCluster vectors:
// seeds from its own members join the set beside it, its rows move straight to them (never through the unclustered
// partition a query scans flat), and once it is empty its centroid goes. Fake storage here; the real store is in
// tests/integration/ivf-regrow-store.test.ts.
import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runIvfSweepSlice, type IvfSweepDeps, type IvfSplitDeps } from '../../src/worker/ivf-sweep.ts';
import { DEFAULT_IVF_CONFIG, loadIvfConfig, UNCLUSTERED_CLUSTER, type Centroid } from '../../src/worker/ivf.ts';

const cfg = { ...DEFAULT_IVF_CONFIG, enabled: true, minCorpusSize: 10, targetPerCluster: 10, sweepBatch: 4, regrowRatio: 3 };
const cent = (id: number, v: number[], hitCount = 50): Centroid => ({ clusterId: id, vector: v, hitCount });
const row = (id: string, v: number[]) => ({ chunkId: id, embedding: Float32Array.from(v) });

/** In-memory index: centroids, each row's cluster, the split record, and every call the sweep makes. */
function fakeIndex(sizes: Record<number, number>) {
  let centroids: Centroid[] = Object.keys(sizes).map(Number).map((id, i) => cent(id, [i === 0 ? 1 : 0, i === 0 ? 0 : 1, 0, 0]));
  const rows = new Map<string, { cluster: number; v: number[] }>();
  for (const [id, n] of Object.entries(sizes)) for (let i = 0; i < n; i++) rows.set(`${id}-${i}`, { cluster: Number(id), v: [1, (i % 7) / 7, i % 2, 0] });
  let split: { clusterId: number; seedLo: number; seedHi: number } | null = null;
  let nextId = 1000;
  const moves: Array<{ chunkId: string; clusterId: number }> = [];
  const inCluster = (c: number) => [...rows].filter(([, r]) => r.cluster === c);
  const splitDeps: IvfSplitDeps = {
    current: () => split,
    largest: (ids) => ids.map(id => ({ clusterId: id, size: inCluster(id).length })).filter(x => x.size > 0)
      .sort((a, b) => b.size - a.size)[0] ?? null,
    rows: (c, limit) => inCluster(c).slice(0, limit).map(([id, r]) => row(id, r.v)),
    sample: (c, limit) => inCluster(c).slice(0, limit).map(([id, r]) => row(id, r.v)),
    start: (_c, clusterId, seeds) => {
      centroids = [...centroids, ...seeds];
      split = { clusterId, seedLo: Math.min(...seeds.map(s => s.clusterId)), seedHi: Math.max(...seeds.map(s => s.clusterId)) };
    },
    finish: (_c, clusterId, drop) => { if (drop) centroids = centroids.filter(c => c.clusterId !== clusterId); split = null; },
  };
  const deps: IvfSweepDeps = {
    collection: 'c', cfg,
    countLegacyRows: () => 0, migrateLegacyBatch: () => 0, countVectors: () => rows.size,
    getCentroids: () => centroids, setCentroids: (_c, cs) => { centroids = cs; },
    updateCentroids: (_c, changed) => { const m = new Map(changed.map(c => [c.clusterId, c])); centroids = centroids.map(c => m.get(c.clusterId) ?? c); },
    allocateClusterIds: (_c, n) => Array.from({ length: n }, () => nextId++),
    sampleAnyVectors: () => [], sampleClusteredVectors: () => [], getUnclusteredChunks: () => [],
    sampleRebalanceVectors: () => [],
    reassignClusterBatch: (items) => { for (const i of items) { moves.push({ chunkId: i.chunkId, clusterId: i.clusterId }); rows.get(i.chunkId)!.cluster = i.clusterId; } },
    sample: (n, k) => Array.from({ length: Math.min(n, k) }, (_, i) => i),
    yieldToLoop: () => Promise.resolve(),
    split: splitDeps,
  };
  return { deps, moves, rows, get centroids() { return centroids; }, get split() { return split; }, inCluster };
}

test('loadIvfConfig — CAPTAIN_MEMO_IVF_REGROW_RATIO overrides, 0 included', () => {
  expect(loadIvfConfig({ CAPTAIN_MEMO_IVF_REGROW_RATIO: '5' }).regrowRatio).toBe(5);
  expect(loadIvfConfig({ CAPTAIN_MEMO_IVF_REGROW_RATIO: '0' }).regrowRatio).toBe(0);
  expect(loadIvfConfig({ CAPTAIN_MEMO_IVF_REGROW_RATIO: 'x' }).regrowRatio).toBe(DEFAULT_IVF_CONFIG.regrowRatio);
});

test('split — regrowRatio 0 never splits, however large a cluster is', async () => {
  const ix = fakeIndex({ 1: 500, 2: 5 });
  const r = await runIvfSweepSlice({ ...ix.deps, cfg: { ...cfg, regrowRatio: 0 } });
  expect(r.split).toBe(0);
  expect(ix.split).toBeNull();
  expect(ix.centroids.length).toBe(2);
});

test('split — no cluster past ratio x target: it rebalances, as before', async () => {
  const ix = fakeIndex({ 1: 30, 2: 5 });                 // 30 is not more than 3 x 10
  expect(await runIvfSweepSlice(ix.deps)).toEqual({ legacyMigrated: 0, bootstrapped: 0, assigned: 0, rebalanced: 0, reset: 0, split: 0 });
  expect(ix.split).toBeNull();
});

test('split — the largest oversized cluster gets round(size/target) seeds from its own rows; its rows go to them, never to -1', async () => {
  const ix = fakeIndex({ 1: 45, 2: 62 });
  const r = await runIvfSweepSlice(ix.deps);
  expect(r.split).toBe(4);                               // one batch moved
  expect(ix.split).toMatchObject({ clusterId: 2 });      // 62, the larger
  const seeds = ix.centroids.filter(c => c.clusterId >= 1000);
  expect(seeds.length).toBe(6);                          // round(62 / 10)
  expect(ix.centroids.some(c => c.clusterId === 2)).toBe(true);   // still probed until it is empty
  expect(ix.moves.every(m => m.clusterId >= 1000)).toBe(true);
});

test('split — runs to the end: the drained cluster loses its centroid, the next split starts, and nothing ever sits at -1', async () => {
  const ix = fakeIndex({ 1: 45, 2: 62, 3: 8 });
  for (let i = 0; i < 200 && (i === 0 || ix.split); i++) {
    await runIvfSweepSlice(ix.deps);
    expect(ix.inCluster(UNCLUSTERED_CLUSTER).length).toBe(0);
    const live = new Set(ix.centroids.map(c => c.clusterId));
    expect([...ix.rows.values()].every(r => live.has(r.cluster))).toBe(true);   // no row under an id no query probes
  }
  expect(ix.split).toBeNull();
  const ids = ix.centroids.map(c => c.clusterId);
  expect(ids).not.toContain(1);
  expect(ids).not.toContain(2);
  expect(ids).toContain(3);                              // 8 is small: left alone
  expect(ix.rows.size).toBe(115);
});

test('split — a split whose seeds are gone (the set was replaced) is forgotten, and the cluster keeps its centroid', async () => {
  const ix = fakeIndex({ 1: 20, 2: 5 });
  ix.deps.split!.start('c', 1, [cent(1000, [1, 0, 0, 0], 1)]);
  ix.deps.setCentroids('c', ix.centroids.filter(c => c.clusterId < 1000));
  await runIvfSweepSlice(ix.deps);
  expect(ix.split).toBeNull();
  expect(ix.centroids.map(c => c.clusterId)).toContain(1);
});

test('the worker wires the split storage into the sweep (the dep is optional: absent, nothing is split)', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/worker/index.ts'), 'utf-8');
  const call = src.slice(src.indexOf('runIvfSweepSlice({'), src.indexOf('sample: defaultSample'));
  for (const w of ['vector.splitInProgress(coll)', 'vector.largestCluster(ids, over)', 'vector.clusterRows(id, limit)',
    'vector.sampleClusterVectors(id, limit)', 'vector.startSplit(coll, id, seeds)', 'vector.finishSplit(coll, id, drop)']) {
    expect(call).toContain(w);
  }
  expect(src).toContain('r.reset > 0 || r.split > 0');   // a split slice runs at the build cadence
});
