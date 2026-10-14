// tests/unit/ivf-regrow.test.ts
//
// The cluster count K is chosen once, at the bootstrap. An outside user's store was seeded at ~3,300 vectors and kept 11
// centroids at 40.9k, an average cluster of 3,700, and the dedup / semantic / theme passes take their groups from cluster
// membership. The sweep now redoes the bootstrap (the zero-centroid repair's reset-then-replace) once the corpus is
// `regrowRatio` times the size the index was built for.
import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runIvfSweepSlice, type IvfSweepDeps } from '../../src/worker/ivf-sweep.ts';
import { DEFAULT_IVF_CONFIG, loadIvfConfig, outgrown, type Centroid } from '../../src/worker/ivf.ts';

const cfg = { ...DEFAULT_IVF_CONFIG, enabled: true, minCorpusSize: 10, targetPerCluster: 10, regrowRatio: 3 };

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
const TWO: Centroid[] = [cent(1, [1, 0, 0, 0]), cent(2, [0, 1, 0, 0])];

test('outgrown — compares the corpus with the size the index was built for, and 0 switches it off', () => {
  expect(outgrown(100, 299, cfg)).toBe(false);
  expect(outgrown(100, 300, cfg)).toBe(true);
  expect(outgrown(100, 5000, { ...cfg, regrowRatio: 0 })).toBe(false);
  expect(outgrown(0, 5000, cfg)).toBe(false);   // nothing recorded and no centroids: the bootstrap's business, not a regrow
});

test('loadIvfConfig — CAPTAIN_MEMO_IVF_REGROW_RATIO overrides, 0 included', () => {
  expect(loadIvfConfig({}).regrowRatio).toBe(0);                                  // off unless asked for
  expect(loadIvfConfig({ CAPTAIN_MEMO_IVF_REGROW_RATIO: '5' }).regrowRatio).toBe(5);
  expect(loadIvfConfig({ CAPTAIN_MEMO_IVF_REGROW_RATIO: '3' }).regrowRatio).toBe(3);
  expect(loadIvfConfig({ CAPTAIN_MEMO_IVF_REGROW_RATIO: 'x' }).regrowRatio).toBe(0);
});

test('regrow — the shipped default never rebuilds, recorded size or not, however far behind; =3 turns it on', async () => {
  // A rebuild makes every search 4.8-9.3 s for hours and the memory hook waits 1.5 s, so it is opt-in. That also means no
  // existing store is rebuilt by the update, including one with no recorded size whose K x targetPerCluster reads 3x low.
  const shipped = { ...loadIvfConfig({}), enabled: true, minCorpusSize: 10, targetPerCluster: 10 };
  const optedIn = { ...loadIvfConfig({ CAPTAIN_MEMO_IVF_REGROW_RATIO: '3' }), enabled: true, minCorpusSize: 10, targetPerCluster: 10 };
  const reset = async (c: typeof cfg, n: number, recorded: number | null): Promise<number> => (await runIvfSweepSlice(baseDeps({
    cfg: c, countVectors: () => n, getCentroids: () => TWO, bootstrapSize: () => recorded,
    sampleClusteredVectors: () => [{ chunkId: 'a', embedding: Float32Array.from([1, 0, 0, 0]), clusterId: 1 }],
  }))).reset;
  expect(await reset(shipped, 20, 20)).toBe(0);              // healthy
  expect(await reset(shipped, 60, 20)).toBe(0);              // 3x: would rebuild if it were on
  expect(await reset(shipped, 1_000_000, 20)).toBe(0);       // far behind
  expect(await reset(shipped, 1_000_000, null)).toBe(0);     // no recorded size: K x 10 = 20
  expect(await reset(optedIn, 60, 20)).toBe(1);
  expect(await reset(optedIn, 60, null)).toBe(1);
});

test('regrow — an index built for 20 vectors that now holds 60 sends a batch back to unclustered, and replaces nothing yet', async () => {
  const moved: Array<{ chunkId: string; clusterId: number }> = [];
  let written = false;
  const result = await runIvfSweepSlice(baseDeps({
    countVectors: () => 60,
    getCentroids: () => TWO,
    bootstrapSize: () => 20,
    sampleClusteredVectors: () => [{ chunkId: 'a', embedding: Float32Array.from([1, 0, 0, 0]), clusterId: 1 }],
    getUnclusteredChunks: () => { throw new Error('must not assign while rebuilding'); },
    reassignClusterBatch: (items) => { for (const i of items) moved.push({ chunkId: i.chunkId, clusterId: i.clusterId }); },
    setCentroids: () => { written = true; },
  }));
  expect(result).toEqual({ legacyMigrated: 0, bootstrapped: 0, assigned: 0, rebalanced: 0, reset: 1 });
  expect(moved).toEqual([{ chunkId: 'a', clusterId: -1 }]);
  expect(written).toBe(false);
});

test('regrow — with nothing clustered left it bootstraps with the K the corpus has NOW, and records the size it was built for', async () => {
  const seen: { k?: number; cs?: Centroid[]; builtFor?: number | undefined } = {};
  const result = await runIvfSweepSlice(baseDeps({
    countVectors: () => 60,
    getCentroids: () => TWO,
    bootstrapSize: () => 20,
    sampleClusteredVectors: () => [],
    sampleAnyVectors: (_c, k) => { seen.k = k; return Array.from({ length: k }, (_, i) => ({ chunkId: `s${i}`, embedding: Float32Array.from([1, i + 1, 0, 0]) })); },
    allocateClusterIds: (_c, n) => Array.from({ length: n }, (_, i) => 100 + i),
    setCentroids: (_c, cs, builtFor) => { seen.cs = cs; seen.builtFor = builtFor; },
  }));
  expect(seen.k).toBe(6);                       // 60 / 10, not the 2 centroids it had
  expect(result.bootstrapped).toBe(6);
  expect(seen.cs!.map(c => c.clusterId)).toEqual([100, 101, 102, 103, 104, 105]);
  expect(seen.builtFor).toBe(60);
});

test('regrow — an index within the ratio is left alone: it rebalances, as before', async () => {
  const moved: string[] = [];
  const result = await runIvfSweepSlice(baseDeps({
    countVectors: () => 59,                     // 59 < 3 x 20
    getCentroids: () => TWO,
    bootstrapSize: () => 20,
    sampleClusteredVectors: () => [{ chunkId: 'a', embedding: Float32Array.from([1, 0, 0, 0]), clusterId: 1 }],
    reassignClusterBatch: (items) => { for (const i of items) moved.push(i.chunkId); },
  }));
  expect(result).toEqual({ legacyMigrated: 0, bootstrapped: 0, assigned: 0, rebalanced: 0, reset: 0 });
  expect(moved).toEqual([]);                    // already in its nearest cluster: nothing sent back to -1 either
});

test('regrow — an index with no recorded size is read as K x targetPerCluster', async () => {
  const run = (n: number) => runIvfSweepSlice(baseDeps({
    countVectors: () => n,
    getCentroids: () => TWO,                    // 2 x 10 = built for 20
    bootstrapSize: () => null,
    sampleClusteredVectors: () => [{ chunkId: 'a', embedding: Float32Array.from([1, 0, 0, 0]), clusterId: 1 }],
  }));
  expect((await run(59)).reset).toBe(0);
  expect((await run(60)).reset).toBe(1);
});

test('regrow — regrowRatio 0 never rebuilds, however far behind the index is', async () => {
  const result = await runIvfSweepSlice(baseDeps({
    cfg: { ...cfg, regrowRatio: 0 },
    countVectors: () => 100_000,
    getCentroids: () => TWO,
    bootstrapSize: () => 20,
    sampleClusteredVectors: () => [{ chunkId: 'a', embedding: Float32Array.from([1, 0, 0, 0]), clusterId: 1 }],
  }));
  expect(result.reset).toBe(0);
});

test('the worker wires the recorded build size into the sweep (the dep is optional and falls back to K x targetPerCluster silently)', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/worker/index.ts'), 'utf-8');
  const call = src.slice(src.indexOf('runIvfSweepSlice({'), src.indexOf('sample: defaultSample'));
  expect(call).toContain('bootstrapSize: (coll) => vector.bootstrapSize(coll)');
  expect(call).toContain('vector.setCentroids(coll, centroids, bootstrapVectors)');
});
