import { test, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, statfsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { COMPACT_PEAK_FACTOR, COMPACT_RECLAIM_AT, rebuildVectorLayout } from '../../../src/cli/commands/vacuum.ts';
import { VectorStore, VEC_CHUNK_SIZE, vectorOccupancy } from '../../../src/worker/vector-store.ts';

// `captain-memo vacuum` re-packs a vector index that went sparse (the IVF rebalance and file re-indexes leave holes in old
// chunks that only a re-lay refills; dev store 2026-10-26: 328k vectors in 4,944 chunks, 2,863 would do) — but only when a
// re-pack sheds enough, when the disk has room for its peak, and with the worker stopped, which vacuumCommand already requires.
const DIM = 8;
const vec = (seed: number) => Array.from({ length: DIM }, (_, i) => Math.sin(seed * 0.37 + i));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A vector db with 3 partitions where half of every older chunk is gone: 330 live in 6 chunks, 3 would do. */
async function sparseDb(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cm-repack-'));
  dirs.push(dir);
  const path = join(dir, 'embeddings.db');
  const s = new VectorStore({ dbPath: path, dimension: DIM });
  const all = Array.from({ length: 600 }, (_, i) => `id${i}`);
  await s.add('c', all.map((id, i) => ({ id, embedding: vec(i) })));
  s.reassignClusterBatch(all.map((id, i) => ({ chunkId: id, embedding: Float32Array.from(vec(i)), clusterId: i % 3 })));
  await s.delete('c', all.filter((_, i) => i % 2 === 0 && i < 540));
  s.close();
  return path;
}
const occupancy = (path: string) => { const db = new Database(path, { readonly: true }); try { return vectorOccupancy(db); } finally { db.close(); } };
const needFor = (path: string) => Math.ceil(COMPACT_PEAK_FACTOR * occupancy(path)!.denseChunks * VEC_CHUNK_SIZE * DIM * 4);
/** One partition of `chunks` full chunks, then the first `gone` rows of every chunk deleted: no chunk is emptied, so none is freed. */
async function oneClusterDb(path: string, chunks: number, gone: number) {
  const s = new VectorStore({ dbPath: path, dimension: DIM });
  const all = Array.from({ length: chunks * VEC_CHUNK_SIZE }, (_, i) => `n${i}`);
  await s.add('c', all.map((id, i) => ({ id, embedding: vec(i) })));
  s.reassignClusterBatch(all.map((id, i) => ({ chunkId: id, embedding: Float32Array.from(vec(i)), clusterId: 0 })));
  await s.delete('c', all.filter((_, i) => i % VEC_CHUNK_SIZE < gone));
  s.close();
  return occupancy(path)!;
}
const noRoom = () => { throw new Error('the free space was asked for'); };

function logged<T>(fn: () => T): { result: T; out: string } {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try { return { result: fn(), out: lines.join('\n') }; } finally { console.log = log; }
}

test('a sparse index is re-packed to its dense chunk count, with before and after printed', async () => {
  const path = await sparseDb();
  const before = occupancy(path)!;
  expect(before).toEqual({ live: 330, slots: 768, chunks: 6, denseChunks: 3 });
  expect(1 - before.denseChunks / before.chunks).toBeGreaterThanOrEqual(COMPACT_RECLAIM_AT);

  const { result, out } = logged(() => rebuildVectorLayout(path, () => needFor(path)));   // exactly the room it needs
  expect(result).toBe(330);
  expect(occupancy(path)).toEqual({ live: 330, slots: 384, chunks: 3, denseChunks: 3 });
  expect(out).toContain('43% full (330 vectors in 768 slots');
  expect(out).toContain('re-packed: 330 vectors in 384 slots, 86% full');

  const again = logged(() => rebuildVectorLayout(path, noRoom));                         // dense now: nothing to do, and no free-space question
  expect(again.result).toBe(0);
  expect(again.out).toBe('');
});

test('it refuses before starting when the disk cannot hold the rebuild, naming the number, and leaves the file alone', async () => {
  const path = await sparseDb();
  const need = needFor(path);
  const bytes = readFileSync(path);
  const { result, out } = logged(() => rebuildVectorLayout(path, () => need - 1));
  expect(result).toBe(0);
  expect(out).toContain('NOT re-packed');
  expect(out).toMatch(/needs \d/);
  expect(out).toContain('relay copy and the rebuilt table');
  expect(readFileSync(path).equals(bytes)).toBe(true);                                   // not a byte written
  expect(occupancy(path)!.chunks).toBe(6);
});

test('it refuses when the free space cannot be read', async () => {
  const path = await sparseDb();
  const { result, out } = logged(() => rebuildVectorLayout(path, () => { throw new Error('statfs unsupported'); }));
  expect(result).toBe(0);
  expect(out).toContain('cannot read the free space (statfs unsupported)');
  expect(occupancy(path)!.chunks).toBe(6);
});

test('it refuses when the free-space figure is not a number (a statfs without the field gives NaN)', async () => {
  const path = await sparseDb();
  const bytes = readFileSync(path);
  const { result, out } = logged(() => rebuildVectorLayout(path, () => NaN));
  expect(result).toBe(0);
  expect(out).toContain('NOT re-packed');
  expect(out).toContain('no readable free-space figure');
  expect(readFileSync(path).equals(bytes)).toBe(true);
});

test('the real free-space probe answers for a temp dir', async () => {
  let ok = true;
  try { statfsSync(tmpdir()); } catch { ok = false; }
  if (!ok) return;                                                                       // a platform without statfs refuses (above) — nothing to prove here
  const path = await sparseDb();
  expect(logged(() => rebuildVectorLayout(path)).result).toBe(330);
});

test('a dense index, an index just under the threshold, and a file with no vector table are all left alone', async () => {
  // dense: a plain insert, 3 chunks for 300 vectors (78% "full" — fullness alone is not the test)
  const dir = mkdtempSync(join(tmpdir(), 'cm-repack-'));
  dirs.push(dir);
  const dense = join(dir, 'dense.db');
  const s = new VectorStore({ dbPath: dense, dimension: DIM });
  await s.add('c', Array.from({ length: 300 }, (_, i) => ({ id: `d${i}`, embedding: vec(i) })));
  s.close();
  // just under the threshold: 5 chunks in one partition, 26 rows gone from each, so 4 would do: 20% to shed against 25%
  const near = join(dir, 'near.db');
  const o = await oneClusterDb(near, 5, 26);
  expect(o).toEqual({ live: 510, slots: 640, chunks: 5, denseChunks: 4 });
  expect(1 - o.denseChunks / o.chunks).toBeLessThan(COMPACT_RECLAIM_AT);
  // no vec table: any other sqlite file (meta.sqlite3)
  const meta = join(dir, 'meta.sqlite3');
  const m = new Database(meta); m.exec('CREATE TABLE documents (id INTEGER PRIMARY KEY)'); m.close();

  for (const p of [dense, near, meta]) {
    const bytes = readFileSync(p);
    const r = logged(() => rebuildVectorLayout(p, noRoom));
    expect(r.result).toBe(0);
    expect(r.out).toBe('');
    expect(readFileSync(p).equals(bytes)).toBe(true);
  }
  expect(new Database(meta, { readonly: true }).query(`SELECT name FROM sqlite_master WHERE name LIKE 'vec%'`).all()).toEqual([]);   // and it made no vector table
});

test('an index built at another chunk size is still re-laid at VEC_CHUNK_SIZE, without asking about space', async () => {
  const path = await sparseDb();
  const s = new VectorStore({ dbPath: path, dimension: DIM });
  s.rebuildChunkLayout(VEC_CHUNK_SIZE * 2);
  expect(s.chunkCapacity()).toBe(VEC_CHUNK_SIZE * 2);
  s.close();
  const { result, out } = logged(() => rebuildVectorLayout(path, noRoom));
  expect(result).toBe(330);
  expect(out).toBe('');                                                                  // today's path: the same quiet re-lay
  const s2 = new VectorStore({ dbPath: path, dimension: DIM });
  expect(s2.chunkCapacity()).toBe(VEC_CHUNK_SIZE);
  s2.close();
});

test('the threshold is inclusive: 4 chunks that 3 would hold (exactly 25% to shed) are re-packed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-repack-'));
  dirs.push(dir);
  const path = join(dir, 'edge.db');
  expect(await oneClusterDb(path, 4, 33)).toEqual({ live: 380, slots: 512, chunks: 4, denseChunks: 3 });
  expect(logged(() => rebuildVectorLayout(path, () => needFor(path))).result).toBe(380);
  expect(occupancy(path)).toEqual({ live: 380, slots: 384, chunks: 3, denseChunks: 3 });
});
