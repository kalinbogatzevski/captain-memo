import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { VectorStore, VEC_CHUNK_SIZE, vectorOccupancy } from '../../src/worker/vector-store.ts';

// vec0 allocates ONE fixed-size chunk per partition and scans whole chunks. At the stock
// chunk_size of 1024 against targetPerCluster=300, a real 144k-vector store measured:
//
//   allocated 1888 MB · live data 563 MB · median chunk 147/1024 full -> 70% waste
//
// and queries paid for the empty space they scanned. Rebuilt at chunk_size=128, byte-identical
// results: 578 MB (-1.19 GB) and p50 62.7 ms -> 36.4 ms. Smaller AND faster, same answers.
const vec = (n: number, seed: number) =>
  Array.from({ length: n }, (_, i) => Math.sin(seed * 0.37 + i) );

function store(dir: string) {
  return new VectorStore({ dbPath: join(dir, 'v.db'), dimension: 8 });
}

test('a fresh store is created at the configured chunk size, not vec0 default 1024', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-vec-'));
  const s = store(dir);
  expect(s.chunkCapacity()).toBe(VEC_CHUNK_SIZE);
  expect(VEC_CHUNK_SIZE).toBeLessThan(1024);
  s.close(); rmSync(dir, { recursive: true, force: true });
});

test('rebuildChunkLayout is a no-op when the layout already matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-vec-'));
  const s = store(dir);
  await s.add('c', [{ id: 'a', embedding: vec(8, 1) }]);
  expect(s.rebuildChunkLayout()).toBeNull();     // null = nothing to do
  s.close(); rmSync(dir, { recursive: true, force: true });
});

test('rebuildChunkLayout preserves every vector, its cluster, and query results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-vec-'));
  const s = store(dir);
  const items = Array.from({ length: 40 }, (_, i) => ({ id: `id${i}`, embedding: vec(8, i) }));
  await s.add('c', items);
  // Spread them across clusters so the rebuild has real partitions to reproduce.
  s.reassignClusterBatch(items.map((it, i) => ({
    chunkId: it.id, embedding: Float32Array.from(it.embedding), clusterId: i % 5,
  })));
  const before = await s.query('c', vec(8, 3), 10);
  const forced = s.rebuildChunkLayout(VEC_CHUNK_SIZE * 2);  // always differs -> forces a real rebuild
  expect(forced?.moved).toBe(40);
  const after = await s.query('c', vec(8, 3), 10);
  expect(after.map(r => r.id)).toEqual(before.map(r => r.id));
  expect(s.countVectors('c')).toBe(40);
  s.close(); rmSync(dir, { recursive: true, force: true });
});

// ---- Compaction: why an index only gets sparser, and the re-lay that undoes it (rebuildChunkLayout(size, true)) ----
//
// MEASURED with the repo's sqlite-vec 0.1.9 (400 vectors in one partition = chunks of 128, 128, 128, 16):
//   - add() of an existing id (delete + insert) puts the row in the partition's LATEST chunk, never in the hole it left:
//     re-adding 60 ids of chunk 2 left chunk 2 at 68/128 and took chunk 4 from 16 to 76.
//   - a chunk with no live row left is freed (chunk 2 vanished once its last 68 were deleted); a part-empty one is not.
//   - so re-adding 100 ids each of chunks 1 and 3 (live still 400) filled the tail and opened two more chunks: 768 slots for 400.
// On the dev store (2026-10-26) that is 328k vectors in 4,944 chunks where 2,863 would do.
function shadow(path: string) {
  const db = new Database(path, { readonly: true });   // the shadow tables are plain tables: no vec0 extension needed
  const chunkOf = (id: string) => (db.query('SELECT chunk_id c FROM vec_chunks_p_rowids WHERE id = ?').get(id) as { c: number }).c;
  const liveIn = (chunk: number) => (db.query('SELECT COUNT(*) n FROM vec_chunks_p_rowids WHERE chunk_id = ?').get(chunk) as { n: number }).n;
  const layout = () => db.query(
    `SELECT r.id, r.chunk_id, r.chunk_offset, c.partition00 p FROM vec_chunks_p_rowids r JOIN vec_chunks_p_chunks c ON c.chunk_id = r.chunk_id ORDER BY r.id`,
  ).all();
  return { db, chunkOf, liveIn, layout, occ: () => vectorOccupancy(db)! };
}
const ids = (n: number, p = 'id') => Array.from({ length: n }, (_, i) => `${p}${i}`);

test('a re-insert goes to the latest chunk of its partition, a hole in an older chunk is never refilled, an empty chunk is freed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-vec-'));
  const s = store(dir);
  const all = ids(400);
  await s.add('c', all.map((id, i) => ({ id, embedding: vec(8, i) })));
  const sh = shadow(join(dir, 'v.db'));
  expect(sh.occ()).toEqual({ live: 400, slots: 512, chunks: 4, denseChunks: 4 });
  const [c1, c2, c3, c4] = (sh.db.query('SELECT chunk_id c FROM vec_chunks_p_chunks ORDER BY chunk_id').all() as Array<{ c: number }>).map(r => r.c);
  expect([sh.liveIn(c1!), sh.liveIn(c2!), sh.liveIn(c4!)]).toEqual([128, 128, 16]);

  const fromC2 = all.filter(id => sh.chunkOf(id) === c2).slice(0, 60);
  await s.add('c', fromC2.map(id => ({ id, embedding: vec(8, 99) })));
  expect(fromC2.every(id => sh.chunkOf(id) === c4)).toBe(true);                    // all in the tail
  expect([sh.liveIn(c2!), sh.liveIn(c4!)]).toEqual([68, 76]);                      // the hole in chunk 2 stays
  expect(sh.occ().slots).toBe(512);

  const fromOlder = [c1, c3].flatMap(c => all.filter(id => sh.chunkOf(id) === c).slice(0, 100));   // part of a chunk, so none is freed
  await s.add('c', fromOlder.map(id => ({ id, embedding: vec(8, 7) })));
  expect([c1, c2, c3, c4].map(c => sh.liveIn(c!))).toEqual([28, 68, 28, 128]);     // the tail took 52, two new chunks the other 148
  expect(sh.occ()).toEqual({ live: 400, slots: 768, chunks: 6, denseChunks: 4 });  // 400 vectors in 6 chunks

  const left = (sh.db.query('SELECT id FROM vec_chunks_p_rowids WHERE chunk_id = ?').all(c2!) as Array<{ id: string }>).map(r => r.id);
  await s.delete('c', left);
  expect(sh.db.query('SELECT 1 FROM vec_chunks_p_chunks WHERE chunk_id = ?').get(c2!)).toBeNull();   // freed
  sh.db.close(); s.close(); rmSync(dir, { recursive: true, force: true });
});

// A store with several partitions where half of the rows of every older chunk are gone, like the dev store's.
async function sparseStore(dir: string, n = 600, clusters = 3) {
  const s = store(dir);
  const all = ids(n);
  await s.add('c', all.map((id, i) => ({ id, embedding: vec(8, i) })));
  s.reassignClusterBatch(all.map((id, i) => ({ chunkId: id, embedding: Float32Array.from(vec(8, i)), clusterId: i % clusters })));
  await s.delete('c', all.filter((_, i) => i % 2 === 0 && i < n - 60));    // holes in every older chunk, the tails stay as they are
  return s;
}

test('vectorOccupancy: dense after a plain insert, sparse after deletes, null without the table', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-vec-'));
  const s = store(dir);
  await s.add('c', ids(300).map((id, i) => ({ id, embedding: vec(8, i) })));
  const dense = shadow(join(dir, 'v.db'));
  expect(dense.occ()).toEqual({ live: 300, slots: 384, chunks: 3, denseChunks: 3 });   // 0.78 "full" and nothing to gain
  dense.db.close(); s.close();

  const dir2 = mkdtempSync(join(tmpdir(), 'cm-vec-'));
  const s2 = await sparseStore(dir2);
  const sh = shadow(join(dir2, 'v.db'));
  const o = sh.occ();
  expect(o.live).toBe(s2.countVectors('c'));
  expect(o.denseChunks).toBeLessThan(o.chunks);
  expect(o.denseChunks).toBe(3 * Math.ceil(o.live / 3 / VEC_CHUNK_SIZE));           // 3 partitions of ~150 live: one chunk each... or two
  sh.db.close(); s2.close();

  const plain = new Database(':memory:');
  expect(vectorOccupancy(plain)).toBeNull();
  plain.close();
  rmSync(dir, { recursive: true, force: true }); rmSync(dir2, { recursive: true, force: true });
});

test('a forced re-lay at the same chunk size packs every partition densely and keeps every vector, cluster, meta row and answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-vec-'));
  const s = await sparseStore(dir);
  const sh = shadow(join(dir, 'v.db'));
  const before = sh.occ();
  const clusterOf = () => Object.fromEntries((sh.layout() as Array<{ id: string; p: number }>).map(r => [r.id, r.p]));
  const liveIds = Object.keys(clusterOf());
  const vectors = new Map(liveIds.map(id => [id, Array.from(s.getEmbedding(id)!)]));
  const clusters = clusterOf();
  const answers = await s.query('c', vec(8, 3), 10);
  const meta = (s as unknown as { db: Database }).db.query('SELECT chunk_id, collection_name FROM vec_chunk_meta ORDER BY chunk_id').all();

  expect(s.rebuildChunkLayout()).toBeNull();                               // unforced: the size matches, nothing to do
  const r = s.rebuildChunkLayout(VEC_CHUNK_SIZE, true);
  expect(r?.moved).toBe(liveIds.length);

  const after = sh.occ();
  expect(after.live).toBe(before.live);
  expect(after.chunks).toBe(before.denseChunks);                           // ends at the dense chunk count
  expect(after.slots).toBe(before.denseChunks * VEC_CHUNK_SIZE);
  expect(after.denseChunks).toBe(after.chunks);
  expect(clusterOf()).toEqual(clusters);                                   // same cluster per id
  for (const id of liveIds) expect(Array.from(s.getEmbedding(id)!)).toEqual(vectors.get(id)!);   // same bytes
  expect((s as unknown as { db: Database }).db.query('SELECT chunk_id, collection_name FROM vec_chunk_meta ORDER BY chunk_id').all()).toEqual(meta);
  expect(await s.query('c', vec(8, 3), 10)).toEqual(answers);
  const idx = (sh.db.query(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_vec_chunks_p_%'`).all() as Array<{ name: string }>).map(x => x.name).sort();
  expect(idx).toEqual(['idx_vec_chunks_p_chunks_partition', 'idx_vec_chunks_p_rowids_chunk']);   // a drop took them, the re-lay put them back
  expect(s.chunkCapacity()).toBe(VEC_CHUNK_SIZE);
  expect(s.rebuildChunkLayout(VEC_CHUNK_SIZE, true)?.moved).toBe(liveIds.length);   // and a second one is harmless
  expect(sh.occ()).toEqual(after);
  sh.db.close(); s.close(); rmSync(dir, { recursive: true, force: true });
});

// A failure at any step of the re-lay must leave the ORIGINAL table, layout and all, exactly as it was.
async function expectRolledBack(fail: (sql: string) => boolean | 'skip', message: RegExp) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-vec-'));
  const s = await sparseStore(dir);
  const sh = shadow(join(dir, 'v.db'));
  const layout = sh.layout(), occ = sh.occ();
  const answers = await s.query('c', vec(8, 3), 10);
  const db = (s as unknown as { db: Database }).db;
  const exec = db.exec.bind(db);
  let hit = false;
  (db as unknown as { exec: (sql: string) => void }).exec = (sql: string) => {
    const f = fail(sql);
    if (f) { hit = true; if (f === 'skip') return; throw new Error('injected failure'); }
    return exec(sql);
  };
  expect(() => s.rebuildChunkLayout(VEC_CHUNK_SIZE, true)).toThrow(message);
  (db as unknown as { exec: typeof exec }).exec = exec;
  expect(hit).toBe(true);
  expect(sh.layout()).toEqual(layout);                                     // every id in the same chunk, offset and partition
  expect(sh.occ()).toEqual(occ);
  expect(sh.db.query(`SELECT name FROM sqlite_master WHERE name LIKE 'vec_chunks_p_relay%'`).all()).toEqual([]);
  expect((sh.db.query(`SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'idx_vec_chunks_p_%'`).get() as { n: number }).n).toBe(2);
  expect(await s.query('c', vec(8, 3), 10)).toEqual(answers);
  expect(s.rebuildChunkLayout(VEC_CHUNK_SIZE, true)?.moved).toBe(occ.live);   // the store is still good for a real one
  sh.db.close(); s.close(); rmSync(dir, { recursive: true, force: true });
}

test('a re-lay that fails after the original table was dropped rolls back to the original', async () => {
  // the last statement: the original is dropped, rebuilt and refilled by then
  await expectRolledBack(sql => sql.includes('DROP TABLE vec_chunks_p_relay'), /injected failure/);
});

test('a re-lay whose first copy came up short rolls back before it drops anything', async () => {
  await expectRolledBack(sql => sql.includes('INSERT INTO vec_chunks_p_relay') ? 'skip' : false, /copied 0 of \d+ vectors out/);
});

test('a re-lay whose copy back came up short rolls back after the original was dropped', async () => {
  await expectRolledBack(
    sql => /INSERT INTO vec_chunks_p\(chunk_id, cluster_id, embedding\)\s+SELECT chunk_id, cluster_id, embedding FROM vec_chunks_p_relay/.test(sql) ? 'skip' : false,
    /copied 0 of \d+ vectors back/);
});
