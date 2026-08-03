import { test, expect, beforeEach, afterEach } from 'bun:test';
import { VectorStore } from '../../src/worker/vector-store.ts';
import { cosine } from '../../src/shared/vector-math.ts';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmWorkDir } from '../support/worker-temp.ts';
import type { Centroid } from '../../src/worker/ivf.ts';
import { nearestCentroids } from '../../src/worker/ivf.ts';
import { DEFAULT_IVF_CONFIG } from '../../src/worker/ivf.ts';

let workDir: string;
let store: VectorStore;
const DIM = 4;  // small dim for tests
const DEFAULT_IVF_CONFIG_FOR_TEST = { ...DEFAULT_IVF_CONFIG, enabled: true, minCorpusSize: 0 };

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-vec-test-'));
  store = new VectorStore({ dbPath: join(workDir, 'vectors.sqlite3'), dimension: DIM });
});

afterEach(() => {
  store.close();
  if (existsSync(workDir)) rmWorkDir(workDir);
});

test('VectorStore — ensureCollection is idempotent (no-op)', async () => {
  await store.ensureCollection('coll_a');
  await store.ensureCollection('coll_a');  // second call must not throw
});

test('VectorStore — adds vectors and queries by similarity', async () => {
  await store.add('coll_a', [
    { id: 'apple',  embedding: [1, 0, 0, 0] },
    { id: 'car',    embedding: [0, 1, 0, 0] },
    { id: 'cherry', embedding: [0.95, 0.05, 0, 0] },
  ]);
  const results = await store.query('coll_a', [1, 0, 0, 0], 3);
  expect(results.length).toBeGreaterThan(0);
  // Closest to [1,0,0,0] should be "apple" (exact match, distance ~0)
  expect(results[0]!.id).toBe('apple');
  // "cherry" should be next (very similar vector)
  expect(results[1]!.id).toBe('cherry');
});

test('VectorStore — query is scoped to the requested collection', async () => {
  await store.add('coll_a', [{ id: 'a1', embedding: [1, 0, 0, 0] }]);
  await store.add('coll_b', [{ id: 'b1', embedding: [1, 0, 0, 0] }]);
  const a = await store.query('coll_a', [1, 0, 0, 0], 5);
  const b = await store.query('coll_b', [1, 0, 0, 0], 5);
  expect(a.map(r => r.id)).toEqual(['a1']);
  expect(b.map(r => r.id)).toEqual(['b1']);
});

test('VectorStore — delete removes specified ids only', async () => {
  await store.add('coll_a', [
    { id: 'd1', embedding: [1, 0, 0, 0] },
    { id: 'd2', embedding: [0, 1, 0, 0] },
  ]);
  await store.delete('coll_a', ['d1']);
  const results = await store.query('coll_a', [1, 0, 0, 0], 5);
  expect(results.find(r => r.id === 'd1')).toBeUndefined();
  expect(results.find(r => r.id === 'd2')).toBeDefined();
});

test('VectorStore — rejects embeddings of wrong dimension', async () => {
  await expect(
    store.add('coll_a', [{ id: 'wrong', embedding: [1, 2] }]),  // 2 dims != DIM (4)
  ).rejects.toThrow(/dimension/);
});

test('VectorStore — getEmbedding round-trips a stored vector by chunk id', async () => {
  const known = Array.from({ length: DIM }, (_, i) => Math.sin(i));
  await store.add('observation', [{ id: 'rt-1', embedding: known }]);

  const got = store.getEmbedding('rt-1');
  expect(got).not.toBeNull();
  expect(got!.length).toBe(DIM);
  expect(cosine(Array.from(got!), known)).toBeGreaterThan(0.9999);

  expect(store.getEmbedding('does-not-exist')).toBeNull();
});

test('VectorStore — rejects query embedding of wrong dimension', async () => {
  await expect(
    store.query('coll_a', [1, 2], 5),
  ).rejects.toThrow(/dimension/);
});

test('VectorStore — a fresh install has no legacy rows to migrate', async () => {
  expect(store.countLegacyRows()).toBe(0);
});

test('VectorStore — countVectors reflects only the requested collection', async () => {
  await store.add('coll_a', [{ id: 'a1', embedding: [1, 0, 0, 0] }, { id: 'a2', embedding: [0, 1, 0, 0] }]);
  await store.add('coll_b', [{ id: 'b1', embedding: [1, 0, 0, 0] }]);
  expect(store.countVectors('coll_a')).toBe(2);
  expect(store.countVectors('coll_b')).toBe(1);
});

test('VectorStore — getCentroids is empty until setCentroids is called; setCentroids then getCentroids round-trips', async () => {
  expect(store.getCentroids('coll_a')).toEqual([]);
  const centroids: Centroid[] = [
    { clusterId: 10, vector: [1, 0, 0, 0], hitCount: 5 },
    { clusterId: 11, vector: [0, 1, 0, 0], hitCount: 3 },
  ];
  store.setCentroids('coll_a', centroids);
  const roundTripped = store.getCentroids('coll_a');
  expect(roundTripped.length).toBe(2);
  const byId = new Map(roundTripped.map(c => [c.clusterId, c]));
  expect(byId.get(10)?.vector).toEqual([1, 0, 0, 0]);
  expect(byId.get(10)?.hitCount).toBe(5);
  expect(byId.get(11)?.vector).toEqual([0, 1, 0, 0]);
});

test('VectorStore — setCentroids replaces the prior set for that collection, leaves other collections untouched', async () => {
  store.setCentroids('coll_a', [{ clusterId: 1, vector: [1, 0, 0, 0], hitCount: 1 }]);
  store.setCentroids('coll_b', [{ clusterId: 2, vector: [0, 1, 0, 0], hitCount: 1 }]);
  store.setCentroids('coll_a', [{ clusterId: 3, vector: [0, 0, 1, 0], hitCount: 1 }]);
  expect(store.getCentroids('coll_a').map(c => c.clusterId)).toEqual([3]);
  expect(store.getCentroids('coll_b').map(c => c.clusterId)).toEqual([2]);
});

test('VectorStore — allocateClusterIds hands out globally-unique, ever-increasing ids across collections', async () => {
  const first = store.allocateClusterIds('coll_a', 3);
  expect(first).toEqual([0, 1, 2]);
  const second = store.allocateClusterIds('coll_b', 2); // different collection, ids still continue upward
  expect(second).toEqual([3, 4]);
  const third = store.allocateClusterIds('coll_a', 1);
  expect(third).toEqual([5]);
});

test('VectorStore — new vectors default to the unclustered sentinel (-1) when the collection has no centroids yet', async () => {
  await store.add('coll_a', [{ id: 'a1', embedding: [1, 0, 0, 0] }]);
  const unclustered = store.getUnclusteredChunks('coll_a', 10);
  expect(unclustered.map(u => u.chunkId)).toEqual(['a1']);
});

test('VectorStore — a brand-new chunk added AFTER centroids exist is assigned immediately, not left unclustered', async () => {
  store.setCentroids('coll_a', [
    { clusterId: 0, vector: [1, 0, 0, 0], hitCount: 5 },
    { clusterId: 1, vector: [0, 1, 0, 0], hitCount: 5 },
  ]);
  await store.add('coll_a', [{ id: 'fresh', embedding: [0.9, 0.1, 0, 0] }]);
  expect(store.getUnclusteredChunks('coll_a', 10)).toEqual([]);
  const clustered = store.sampleClusteredVectors('coll_a', 10);
  expect(clustered.map(c => ({ id: c.chunkId, clusterId: c.clusterId }))).toEqual([{ id: 'fresh', clusterId: 0 }]);
});

test('VectorStore — reassignCluster moves a chunk out of the unclustered set and into its new cluster', async () => {
  await store.add('coll_a', [{ id: 'a1', embedding: [1, 0, 0, 0] }]);
  const [unclustered] = store.getUnclusteredChunks('coll_a', 10);
  store.reassignCluster(unclustered!.chunkId, unclustered!.embedding, 7);
  expect(store.getUnclusteredChunks('coll_a', 10)).toEqual([]);
  const clustered = store.sampleClusteredVectors('coll_a', 10);
  expect(clustered.map(c => ({ id: c.chunkId, clusterId: c.clusterId }))).toEqual([{ id: 'a1', clusterId: 7 }]);
});

test('VectorStore — reassignCluster preserves the embedding across the delete+reinsert', async () => {
  await store.add('coll_a', [{ id: 'a1', embedding: [0.5, 0.5, 0.5, 0.5] }]);
  const [unclustered] = store.getUnclusteredChunks('coll_a', 10);
  store.reassignCluster(unclustered!.chunkId, unclustered!.embedding, 9);
  const readBack = store.getEmbedding('a1');
  expect(Array.from(readBack!)).toEqual([0.5, 0.5, 0.5, 0.5]);
});

test('VectorStore — sampleAnyVectors returns vectors regardless of cluster assignment', async () => {
  await store.add('coll_a', [{ id: 'a1', embedding: [1, 0, 0, 0] }, { id: 'a2', embedding: [0, 1, 0, 0] }]);
  const [u1] = store.getUnclusteredChunks('coll_a', 1);
  store.reassignCluster(u1!.chunkId, u1!.embedding, 0); // a1 (or a2) now clustered, the other still unclustered
  const anyVecs = store.sampleAnyVectors('coll_a', 10);
  expect(anyVecs.map(v => v.chunkId).sort()).toEqual(['a1', 'a2']);
});

test('VectorStore — sampleClusteredVectors excludes unclustered (-1) rows', async () => {
  await store.add('coll_a', [{ id: 'a1', embedding: [1, 0, 0, 0] }, { id: 'a2', embedding: [0, 1, 0, 0] }]);
  const [u1] = store.getUnclusteredChunks('coll_a', 1);
  store.reassignCluster(u1!.chunkId, u1!.embedding, 0);
  const clustered = store.sampleClusteredVectors('coll_a', 10);
  expect(clustered.length).toBe(1);
  expect(clustered[0]!.chunkId).toBe(u1!.chunkId);
  expect(clustered[0]!.clusterId).toBe(0);
});

test('VectorStore — countLegacyRows and migrateLegacyBatch against a real pre-A2-shape vec_chunks table', async () => {
  // Simulate an existing pre-A2 install: create the OLD-shape table by hand and
  // seed it directly (bypassing the new store's own add(), which only ever
  // writes to vec_chunks_p) — this is exactly the shape a real upgrade sees.
  const legacyStore = new VectorStore({ dbPath: join(workDir, 'legacy.sqlite3'), dimension: DIM });
  legacyStore.close();
  const { Database } = await import('bun:sqlite');
  const sqliteVec = await import('sqlite-vec');
  const raw = new Database(join(workDir, 'legacy.sqlite3'));
  sqliteVec.load(raw);
  const blob = (v: number[]) => new Uint8Array(new Float32Array(v).buffer);
  raw.exec(`DROP TABLE IF EXISTS vec_chunks_p`); // this test wants ONLY the old shape present
  raw.query(`INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)`).run('legacy1', blob([1, 0, 0, 0]));
  raw.query(`INSERT INTO vec_chunk_meta (chunk_id, collection_name) VALUES (?, ?)`).run('legacy1', 'coll_a');
  raw.close();

  const upgraded = new VectorStore({ dbPath: join(workDir, 'legacy.sqlite3'), dimension: DIM });
  expect(upgraded.countLegacyRows()).toBe(1);
  const migrated = upgraded.migrateLegacyBatch(10);
  expect(migrated).toBe(1);
  expect(upgraded.countLegacyRows()).toBe(0);
  const unclustered = upgraded.getUnclusteredChunks('coll_a', 10);
  expect(unclustered.map(u => u.chunkId)).toEqual(['legacy1']);
  upgraded.close();
});

test('VectorStore — query falls back to brute force when a collection has no centroids yet', async () => {
  await store.add('coll_a', [
    { id: 'apple', embedding: [1, 0, 0, 0] },
    { id: 'cherry', embedding: [0.95, 0.05, 0, 0] },
  ]);
  const results = await store.query('coll_a', [1, 0, 0, 0], 2);
  expect(results.map(r => r.id)).toEqual(['apple', 'cherry']);
});

test('VectorStore — a chunk still sitting in the OLD (pre-migration) vec_chunks table is found by query(), not silently invisible', async () => {
  // Simulates the exact scenario the plan's migration-decoupling fix targets:
  // an existing install's data hasn't reached vec_chunks_p yet (the sweep
  // hasn't run, or hasn't gotten to this row yet). Seed the OLD table directly
  // — bypassing add(), which only ever writes to vec_chunks_p — the same way
  // the countLegacyRows/migrateLegacyBatch test above does.
  const { Database } = await import('bun:sqlite');
  const sqliteVec = await import('sqlite-vec');
  const raw = new Database(join(workDir, 'vectors.sqlite3')); // same file `store` already opened
  sqliteVec.load(raw);
  const blob = (v: number[]) => new Uint8Array(new Float32Array(v).buffer);
  raw.query(`INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)`).run('not-yet-migrated', blob([1, 0, 0, 0]));
  raw.query(`INSERT INTO vec_chunk_meta (chunk_id, collection_name) VALUES (?, ?)`).run('not-yet-migrated', 'coll_a');
  raw.close();

  expect(store.countLegacyRows()).toBe(1); // confirms the row really is only in the old table
  const results = await store.query('coll_a', [1, 0, 0, 0], 5);
  expect(results.map(r => r.id)).toContain('not-yet-migrated');
});

test('VectorStore — query merges old-table and new-table results by distance, not old-first/new-first', async () => {
  await store.add('coll_a', [{ id: 'new-close', embedding: [0.99, 0.01, 0, 0] }]); // goes to vec_chunks_p
  const { Database } = await import('bun:sqlite');
  const sqliteVec = await import('sqlite-vec');
  const raw = new Database(join(workDir, 'vectors.sqlite3'));
  sqliteVec.load(raw);
  const blob = (v: number[]) => new Uint8Array(new Float32Array(v).buffer);
  raw.query(`INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)`).run('old-exact', blob([1, 0, 0, 0]));
  raw.query(`INSERT INTO vec_chunk_meta (chunk_id, collection_name) VALUES (?, ?)`).run('old-exact', 'coll_a');
  raw.close();

  const results = await store.query('coll_a', [1, 0, 0, 0], 2);
  // old-exact is a perfect match (distance 0); new-close is merely very close —
  // old-exact must rank first despite living in the "legacy" table.
  expect(results[0]!.id).toBe('old-exact');
  expect(results.map(r => r.id)).toContain('new-close');
});

test('VectorStore — query uses the clustered fast path once centroids exist, and still finds the true nearest neighbor', async () => {
  await store.add('coll_a', [
    { id: 'apple', embedding: [1, 0, 0, 0] },
    { id: 'car', embedding: [0, 1, 0, 0] },
    { id: 'cherry', embedding: [0.95, 0.05, 0, 0] },
  ]);
  // Move every chunk out of the unclustered set into one of two real clusters,
  // shaped so "apple" and "cherry" (the truly similar pair) land together.
  for (const [id, clusterId] of [['apple', 0], ['cherry', 0], ['car', 1]] as const) {
    const row = store.getUnclusteredChunks('coll_a', 10).find(u => u.chunkId === id)
      ?? { chunkId: id, embedding: store.getEmbedding(id)! };
    store.reassignCluster(row.chunkId, row.embedding, clusterId);
  }
  store.setCentroids('coll_a', [
    { clusterId: 0, vector: [1, 0, 0, 0], hitCount: 2 },
    { clusterId: 1, vector: [0, 1, 0, 0], hitCount: 1 },
  ]);
  const results = await store.query('coll_a', [1, 0, 0, 0], 3);
  expect(results[0]!.id).toBe('apple');
  expect(results.map(r => r.id)).toContain('cherry');
});

test('VectorStore — query still respects collection scoping on the clustered fast path', async () => {
  await store.add('coll_a', [{ id: 'a1', embedding: [1, 0, 0, 0] }]);
  await store.add('coll_b', [{ id: 'b1', embedding: [1, 0, 0, 0] }]);
  const a1 = store.getUnclusteredChunks('coll_a', 10)[0]!;
  const b1 = store.getUnclusteredChunks('coll_b', 10)[0]!;
  store.reassignCluster(a1.chunkId, a1.embedding, 0);
  store.reassignCluster(b1.chunkId, b1.embedding, 1); // globally-unique ids — no collision with coll_a's cluster 0
  store.setCentroids('coll_a', [{ clusterId: 0, vector: [1, 0, 0, 0], hitCount: 1 }]);
  store.setCentroids('coll_b', [{ clusterId: 1, vector: [1, 0, 0, 0], hitCount: 1 }]);
  const aResults = await store.query('coll_a', [1, 0, 0, 0], 5);
  const bResults = await store.query('coll_b', [1, 0, 0, 0], 5);
  expect(aResults.map(r => r.id)).toEqual(['a1']);
  expect(bResults.map(r => r.id)).toEqual(['b1']);
});

test('VectorStore — a custom ivfConfig.probeClusters narrows which clusters are probed', async () => {
  const narrow = new VectorStore({
    dbPath: join(workDir, 'narrow.sqlite3'),
    dimension: DIM,
    ivfConfig: { ...DEFAULT_IVF_CONFIG_FOR_TEST, probeClusters: 1 },
  });
  await narrow.add('coll_a', [
    { id: 'near', embedding: [1, 0, 0, 0] },
    { id: 'far', embedding: [0, 0, 0, 1] },
  ]);
  const nearRow = narrow.getUnclusteredChunks('coll_a', 10).find(u => u.chunkId === 'near')!;
  const farRow = narrow.getUnclusteredChunks('coll_a', 10).find(u => u.chunkId === 'far')!;
  narrow.reassignCluster(nearRow.chunkId, nearRow.embedding, 0);
  narrow.reassignCluster(farRow.chunkId, farRow.embedding, 1);
  narrow.setCentroids('coll_a', [
    { clusterId: 0, vector: [1, 0, 0, 0], hitCount: 1 },
    { clusterId: 1, vector: [0, 0, 0, 1], hitCount: 1 },
  ]);
  // Query vector is closest to cluster 0's centroid — with probeClusters=1,
  // only cluster 0 is searched, so "far" (in cluster 1) must NOT come back
  // even though it would be found under an unfiltered scan.
  const results = await narrow.query('coll_a', [1, 0, 0, 0], 5);
  expect(results.map(r => r.id)).toEqual(['near']);
  narrow.close();
});

test('VectorStore — mid-backfill: a bootstrap tick that seeds centroids without reassigning any row must not make the still-unclustered corpus invisible', async () => {
  // Reproduces the exact bootstrap race from runIvfSweepSlice: its
  // centroid-seeding branch calls setCentroids but reassigns nothing, so the
  // instant centroids first exist the whole corpus is still cluster_id = -1.
  // add() must run BEFORE setCentroids here — add() auto-assigns to existing
  // centroids, so seeding centroids first would prevent the bug from reproducing.
  await store.add('coll_a', [
    { id: 'apple', embedding: [1, 0, 0, 0] },
    { id: 'car', embedding: [0, 1, 0, 0] },
    { id: 'cherry', embedding: [0.95, 0.05, 0, 0] },
  ]);
  store.setCentroids('coll_a', [
    { clusterId: 0, vector: [1, 0, 0, 0], hitCount: 0 },
    { clusterId: 1, vector: [0, 1, 0, 0], hitCount: 0 },
  ]);
  // Pin the precondition: every row is still unclustered right before querying.
  expect(store.getUnclusteredChunks('coll_a', 10).map(u => u.chunkId).sort())
    .toEqual(['apple', 'car', 'cherry']);

  const midBackfill = await store.query('coll_a', [1, 0, 0, 0], 3);
  expect(midBackfill[0]?.id).toBe('apple'); // must still find the true nearest neighbor, not []
  expect(midBackfill.map(r => r.id)).toContain('cherry');

  // Now simulate the assign-sweep reaching "apple": moved to a real cluster.
  store.reassignCluster('apple', store.getEmbedding('apple')!, 0);
  const afterAssign = await store.query('coll_a', [1, 0, 0, 0], 3);
  expect(afterAssign[0]!.id).toBe('apple'); // found via its real cluster now, not just the -1 fallback
  expect(afterAssign.map(r => r.id)).toContain('cherry'); // still unclustered, still found via -1
});

test('VectorStore — the -1 fallback on the clustered path stays collection-scoped: another collection\'s unclustered rows never leak in', async () => {
  // -1 is shared across every collection's not-yet-assigned rows (unlike real
  // cluster ids, which are globally unique) — this pins that queryClustered's
  // required vec_chunk_meta join actually scopes the sentinel per collection.
  await store.add('coll_a', [{ id: 'a1', embedding: [1, 0, 0, 0] }]);
  await store.add('coll_b', [{ id: 'b1', embedding: [1, 0, 0, 0] }]); // identical vector, both still at -1
  store.setCentroids('coll_a', [{ clusterId: 0, vector: [1, 0, 0, 0], hitCount: 0 }]); // only coll_a is "bootstrapped"

  const results = await store.query('coll_a', [1, 0, 0, 0], 5);
  expect(results.map(r => r.id)).toEqual(['a1']); // NOT ['a1', 'b1'] — coll_b's -1 rows must not leak in
});
