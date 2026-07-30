import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { findOrphanVectors, deleteOrphanVectors } from '../../src/worker/maintenance.ts';

// The vector store accumulated 57,373 embeddings (29.3% of an 807.9 MB file) whose chunk no longer
// exists in meta.sqlite3 — every live chunk WAS indexed, so nothing was missing; it was pure
// accumulation from re-indexing without cleanup. The current delete path looks correct, so rather than
// assert a root cause that cannot be proven from the data, the sweep keeps it bounded AND reports what
// it removed, so a genuine leak shows up as a number that keeps coming back instead of silence.
function beds() {
  const dir = mkdtempSync(join(tmpdir(), 'cm-mnt-'));
  const meta = new Database(join(dir, 'meta.sqlite3'));
  meta.exec('CREATE TABLE chunks (id INTEGER PRIMARY KEY, chunk_id TEXT)');
  const vec = new Database(join(dir, 'embeddings.db'));
  vec.exec('CREATE TABLE vec_chunk_meta (chunk_id TEXT NOT NULL, collection_name TEXT NOT NULL)');
  return { dir, meta, vec, metaPath: join(dir, 'meta.sqlite3') };
}

test('finds vectors whose chunk no longer exists, and only those', () => {
  const { dir, meta, vec, metaPath } = beds();
  meta.query('INSERT INTO chunks (chunk_id) VALUES (?)').run('observation:1:aaa');
  meta.query('INSERT INTO chunks (chunk_id) VALUES (?)').run('observation:2:bbb');
  for (const id of ['observation:1:aaa', 'observation:2:bbb', 'observation:9:gone', 'memory:old:zzz'])
    vec.query('INSERT INTO vec_chunk_meta (chunk_id, collection_name) VALUES (?,?)').run(id, 'am_default');

  const orphans = findOrphanVectors(vec, metaPath);
  expect(orphans.sort()).toEqual(['memory:old:zzz', 'observation:9:gone']);
  meta.close(); vec.close(); rmSync(dir, { recursive: true, force: true });
});

test('a store with nothing orphaned reports nothing and deletes nothing', () => {
  const { dir, meta, vec, metaPath } = beds();
  meta.query('INSERT INTO chunks (chunk_id) VALUES (?)').run('observation:1:aaa');
  vec.query('INSERT INTO vec_chunk_meta (chunk_id, collection_name) VALUES (?,?)').run('observation:1:aaa', 'am_default');
  expect(findOrphanVectors(vec, metaPath)).toEqual([]);
  expect(deleteOrphanVectors(vec, [])).toBe(0);
  expect(vec.query('SELECT COUNT(*) n FROM vec_chunk_meta').get()).toEqual({ n: 1 });
  meta.close(); vec.close(); rmSync(dir, { recursive: true, force: true });
});

test('deleting orphans leaves every live vector untouched', () => {
  const { dir, meta, vec, metaPath } = beds();
  meta.query('INSERT INTO chunks (chunk_id) VALUES (?)').run('keep:1');
  for (const id of ['keep:1', 'drop:1', 'drop:2'])
    vec.query('INSERT INTO vec_chunk_meta (chunk_id, collection_name) VALUES (?,?)').run(id, 'am_default');

  const removed = deleteOrphanVectors(vec, findOrphanVectors(vec, metaPath));
  expect(removed).toBe(2);
  const left = (vec.query('SELECT chunk_id FROM vec_chunk_meta').all() as Array<{ chunk_id: string }>).map(r => r.chunk_id);
  expect(left).toEqual(['keep:1']);
  meta.close(); vec.close(); rmSync(dir, { recursive: true, force: true });
});

// 57k ids cannot go into one IN(...) — SQLite caps host parameters (default 999 in older builds).
test('handles far more orphans than a single statement can bind', () => {
  const { dir, meta, vec, metaPath } = beds();
  meta.query('INSERT INTO chunks (chunk_id) VALUES (?)').run('keep:1');
  vec.query('INSERT INTO vec_chunk_meta (chunk_id, collection_name) VALUES (?,?)').run('keep:1', 'am_default');
  const ins = vec.query('INSERT INTO vec_chunk_meta (chunk_id, collection_name) VALUES (?,?)');
  // one transaction: 3 000 auto-committed inserts is 3 000 fsyncs and takes ~12 s on its own
  vec.transaction(() => { for (let i = 0; i < 3000; i++) ins.run('drop:' + i, 'am_default'); })();

  expect(deleteOrphanVectors(vec, findOrphanVectors(vec, metaPath))).toBe(3000);
  expect(vec.query('SELECT COUNT(*) n FROM vec_chunk_meta').get()).toEqual({ n: 1 });
  meta.close(); vec.close(); rmSync(dir, { recursive: true, force: true });
});
