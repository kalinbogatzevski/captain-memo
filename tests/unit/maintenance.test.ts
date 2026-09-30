import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { findOrphanVectors, deleteOrphanVectors, findZeroVectorChunks, sweepOrphanVectors } from '../../src/worker/maintenance.ts';
import { VectorStore } from '../../src/worker/vector-store.ts';
import { MetaStore } from '../../src/worker/meta.ts';

// The vector store accumulated 57,373 embeddings (29.3% of an 807.9 MB file) whose chunk no longer
// exists in meta.sqlite3. The cause was `/reindex` force dropping documents without their vectors (fixed
// at the source); the sweep keeps the store clean AND reports what it removed, so a new leak shows up
// as a number that keeps coming back instead of silence.
function beds() {
  const dir = mkdtempSync(join(tmpdir(), 'cm-mnt-'));
  const meta = new Database(join(dir, 'meta.sqlite3'));
  meta.exec('CREATE TABLE chunks (id INTEGER PRIMARY KEY, chunk_id TEXT)');
  const vec = new Database(join(dir, 'embeddings.db'));
  vec.exec('CREATE TABLE vec_chunk_meta (chunk_id TEXT NOT NULL, collection_name TEXT NOT NULL)');
  return { dir, meta, vec, metaPath: join(dir, 'meta.sqlite3') };
}

test('finds vectors whose chunk no longer exists, and only those', async () => {
  const { dir, meta, vec, metaPath } = beds();
  meta.query('INSERT INTO chunks (chunk_id) VALUES (?)').run('observation:1:aaa');
  meta.query('INSERT INTO chunks (chunk_id) VALUES (?)').run('observation:2:bbb');
  for (const id of ['observation:1:aaa', 'observation:2:bbb', 'observation:9:gone', 'memory:old:zzz'])
    vec.query('INSERT INTO vec_chunk_meta (chunk_id, collection_name) VALUES (?,?)').run(id, 'am_default');

  const orphans = await findOrphanVectors(vec, metaPath);
  expect(orphans.map(o => o.chunk_id).sort()).toEqual(['memory:old:zzz', 'observation:9:gone']);
  expect(orphans.every(o => o.collection_name === 'am_default')).toBe(true);
  meta.close(); vec.close(); rmSync(dir, { recursive: true, force: true });
});

test('a store with nothing orphaned reports nothing and deletes nothing', async () => {
  const { dir, meta, vec, metaPath } = beds();
  meta.query('INSERT INTO chunks (chunk_id) VALUES (?)').run('observation:1:aaa');
  vec.query('INSERT INTO vec_chunk_meta (chunk_id, collection_name) VALUES (?,?)').run('observation:1:aaa', 'am_default');
  expect(await findOrphanVectors(vec, metaPath)).toEqual([]);
  expect(await deleteOrphanVectors(vec, [])).toBe(0);
  expect(vec.query('SELECT COUNT(*) n FROM vec_chunk_meta').get()).toEqual({ n: 1 });
  meta.close(); vec.close(); rmSync(dir, { recursive: true, force: true });
});

test('deleting orphans leaves every live vector untouched', async () => {
  const { dir, meta, vec, metaPath } = beds();
  meta.query('INSERT INTO chunks (chunk_id) VALUES (?)').run('keep:1');
  for (const id of ['keep:1', 'drop:1', 'drop:2'])
    vec.query('INSERT INTO vec_chunk_meta (chunk_id, collection_name) VALUES (?,?)').run(id, 'am_default');

  const removed = await deleteOrphanVectors(vec, await findOrphanVectors(vec, metaPath));
  expect(removed).toBe(2);
  const left = (vec.query('SELECT chunk_id FROM vec_chunk_meta').all() as Array<{ chunk_id: string }>).map(r => r.chunk_id);
  expect(left).toEqual(['keep:1']);
  meta.close(); vec.close(); rmSync(dir, { recursive: true, force: true });
});

// 57k ids cannot go into one IN(...) — SQLite caps host parameters (default 999 in older builds).
test('handles far more orphans than a single statement can bind', async () => {
  const { dir, meta, vec, metaPath } = beds();
  meta.query('INSERT INTO chunks (chunk_id) VALUES (?)').run('keep:1');
  vec.query('INSERT INTO vec_chunk_meta (chunk_id, collection_name) VALUES (?,?)').run('keep:1', 'am_default');
  const ins = vec.query('INSERT INTO vec_chunk_meta (chunk_id, collection_name) VALUES (?,?)');
  // one transaction: 3 000 auto-committed inserts is 3 000 fsyncs and takes ~12 s on its own
  vec.transaction(() => { for (let i = 0; i < 3000; i++) ins.run('drop:' + i, 'am_default'); })();

  expect(await deleteOrphanVectors(vec, await findOrphanVectors(vec, metaPath))).toBe(3000);
  expect(vec.query('SELECT COUNT(*) n FROM vec_chunk_meta').get()).toEqual({ n: 1 });
  meta.close(); vec.close(); rmSync(dir, { recursive: true, force: true });
});

// The fixtures above have no vec0 table. This one uses the real VectorStore + MetaStore, so the per-id
// vec0 delete, the (collection, chunk_id) meta delete, the paged find and the pause between batches all run.
function realBeds() {
  const dir = mkdtempSync(join(tmpdir(), 'cm-mnt-real-'));
  const metaPath = join(dir, 'meta.sqlite3');
  const vecPath = join(dir, 'embeddings.db');
  const meta = new MetaStore(metaPath);
  const store = new VectorStore({ dbPath: vecPath, dimension: 4 });
  const docId = meta.upsertDocument({ source_path: '/m/x.md', channel: 'memory', project_id: 'p', sha: 's', mtime_epoch: 1, metadata: {} });
  meta.replaceChunksForDocument(docId, [
    { chunk_id: 'memory:x:live', text: 'live', sha: 'a', position: 0, metadata: {} },
    { chunk_id: 'memory:x:zero', text: 'zero', sha: 'b', position: 1, metadata: {} },
  ]);
  return { dir, meta, store, metaPath, vecPath };
}
const vecCount = (path: string) => {
  const db = new Database(path, { readonly: true });
  try { return (db.query('SELECT COUNT(*) n FROM vec_chunk_meta').get() as { n: number }).n; } finally { db.close(); }
};

test('the worker sweep deletes orphaned vec0 rows in paused batches and keeps live ones', async () => {
  const { dir, meta, store, metaPath, vecPath } = realBeds();
  await store.add('am_p', [
    { id: 'memory:x:live', embedding: [1, 0, 0, 0] },
    ...Array.from({ length: 60 }, (_, i) => ({ id: `memory:x:gone${i}`, embedding: [0, 1, 0, 0] })),
  ]);
  let pauses = 0;
  const r = await sweepOrphanVectors(vecPath, metaPath, async () => { pauses++; });
  expect(r).toEqual({ found: 60, removed: 60 });
  expect(pauses).toBe(2);                       // 60 ids in batches of 25: three transactions
  expect(vecCount(vecPath)).toBe(1);
  expect(store.getEmbedding('memory:x:live')).not.toBeNull();
  expect(store.getEmbedding('memory:x:gone0')).toBeNull();   // the vec0 row went, not just its meta row
  store.close(); meta.close(); rmSync(dir, { recursive: true, force: true });
});

test('a pause that throws stops the sweep between batches (worker shutdown)', async () => {
  const { dir, meta, store, metaPath, vecPath } = realBeds();
  await store.add('am_p', Array.from({ length: 60 }, (_, i) => ({ id: `memory:x:gone${i}`, embedding: [0, 1, 0, 0] })));
  await expect(sweepOrphanVectors(vecPath, metaPath, async () => { throw new Error('stopping'); })).rejects.toThrow('stopping');
  expect(vecCount(vecPath)).toBe(35);           // exactly one batch of 25 committed
  store.close(); meta.close(); rmSync(dir, { recursive: true, force: true });
});

test('finds all-zero and non-finite vectors, and which of them belong to a live chunk', async () => {
  const { dir, meta, store, metaPath, vecPath } = realBeds();
  await store.add('am_p', [
    { id: 'memory:x:live', embedding: [1, 0, 0, 0] },
    { id: 'memory:x:zero', embedding: [0, 0, 0, 0] },
    { id: 'memory:x:orphan-zero', embedding: [0, 0, 0, 0] },
    { id: 'memory:x:orphan-nan', embedding: [NaN, 0, 0, 0] },
  ]);
  store.close();
  const { openVectorDbForMaintenance } = await import('../../src/worker/maintenance.ts');
  const vec = openVectorDbForMaintenance(vecPath);
  const z = findZeroVectorChunks(vec, metaPath);
  expect(z.total).toBe(3);
  expect(z.live).toEqual([{ chunk_id: 'memory:x:zero', sha: 'b', source_path: '/m/x.md', channel: 'memory' }]);
  vec.close(); meta.close(); rmSync(dir, { recursive: true, force: true });
});
