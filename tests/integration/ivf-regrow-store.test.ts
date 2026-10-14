// tests/integration/ivf-regrow-store.test.ts
//
// K, the cluster count, was chosen once, at the bootstrap. The sweep now rebuilds an index the corpus has outgrown, and that
// must never strand a row under a cluster id no query probes, nor repeat itself on a store whose bootstrap found few usable
// seeds. Real vec0 store, 4 dimensions.
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { VectorStore } from '../../src/worker/vector-store.ts';
import { runIvfSweepSlice, type IvfSweepDeps, type IvfSweepResult } from '../../src/worker/ivf-sweep.ts';
import { DEFAULT_IVF_CONFIG, defaultSample } from '../../src/worker/ivf.ts';
import { rmWorkDir } from '../support/worker-temp.ts';
import { realVectors, zeros } from '../support/ivf-vectors.ts';

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
    bootstrapSize: (k) => store.bootstrapSize(k),
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
  const total: IvfSweepResult = { legacyMigrated: 0, bootstrapped: 0, assigned: 0, rebalanced: 0, reset: 0 };
  const deps = depsFor(store, c);
  for (let i = 0; i < slices; i++) {
    const r = await runIvfSweepSlice(deps);
    for (const k of Object.keys(total) as Array<keyof IvfSweepResult>) total[k] += r[k];
  }
  return total;
}

test('setCentroids records the size the index was built for only when the bootstrap says so', () => {
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
    store.close();
  } finally { rmWorkDir(dir); }
});

test('a corpus that has outgrown its index is rebuilt with the K it has now, and no row is ever hidden while that happens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ivf-regrow-'));
  try {
    const store = open(dir);
    const first = realVectors(30, 'a-', 3);
    await store.add(C, first);
    await sweep(store, 12);
    expect(store.getCentroids(C).length).toBe(3);        // 30 / 10
    expect(store.bootstrapSize(C)).toBe(30);

    const more = realVectors(60, 'b-', 5);
    await store.add(C, more);                            // 90 = 3 x 30
    const all = [...first, ...more];
    const probe = async (): Promise<void> => {
      for (const r of all.filter((_, i) => i % 9 === 0)) {
        const top = await store.query(C, r.embedding, 3);
        expect(top.map(t => t.id)).toContain(r.id);       // a stranded row (a cluster id nobody probes) would be missing
      }
    };
    let sawReset = false;
    for (let i = 0; i < 80; i++) {
      const r = await runIvfSweepSlice(depsFor(store));
      if (r.reset > 0) sawReset = true;
      await probe();
    }
    expect(sawReset).toBe(true);
    expect(store.getCentroids(C).length).toBe(9);        // 90 / 10
    expect(store.bootstrapSize(C)).toBe(90);

    const live = new Set(store.getCentroids(C).map(c => c.clusterId));
    const members = await store.clusterMembership(C);
    expect([...members.keys()].every(id => live.has(id))).toBe(true);   // no -1 left, none under a retired id
    expect([...members.values()].reduce((n, ids) => n + ids.length, 0)).toBe(90);
    store.close();
  } finally { rmWorkDir(dir); }
});

test('a store of mostly unusable vectors is rebuilt once per tripling, not once per sweep', async () => {
  // 4 vectors with a direction and 36 without: the bootstrap asks for 20 seeds and finds 4. Compared by seed count the index
  // always looks undersized (4 x 3 < 20) and would reset the whole corpus again and again; compared with the size it was
  // built for, it is left alone until the corpus has actually tripled.
  const dir = mkdtempSync(join(tmpdir(), 'cm-ivf-loop-'));
  const small = { ...cfg, targetPerCluster: 2, sweepBatch: 16 };
  try {
    const store = open(dir);
    await store.add(C, [...realVectors(4, 'real-'), ...zeros(36, 'zero-')]);
    const t1 = await sweep(store, 60, small);
    expect(t1.bootstrapped).toBe(4);
    expect(t1.reset).toBe(0);
    expect(store.bootstrapSize(C)).toBe(40);

    await store.add(C, zeros(80, 'more-'));              // 120 = 3 x 40
    const t2 = await sweep(store, 80, small);
    expect(t2.reset).toBeGreaterThan(0);
    expect(t2.bootstrapped).toBe(4);                      // rebuilt once
    expect(store.bootstrapSize(C)).toBe(120);

    const t3 = await sweep(store, 80, small);
    expect(t3.bootstrapped).toBe(0);
    expect(t3.reset).toBe(0);
    store.close();
  } finally { rmWorkDir(dir); }
});
