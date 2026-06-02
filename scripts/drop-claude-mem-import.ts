#!/usr/bin/env bun
/**
 * One-shot: evict all `claude-mem://%` documents from meta + vector-db.
 *
 * The claude-mem import (~13.5K observations) was useful as a corpus seed when
 * we migrated, but is now permanently shadowed by native captain-memo
 * observations. Removing it reclaims roughly 340 MB of vector storage.
 *
 * Safe to run with the worker stopped — opens the SQLite files directly with
 * WAL. Worker MUST be stopped first (otherwise we race the observation
 * ingest path that also writes to meta).
 *
 *   systemctl --user stop captain-memo-worker
 *   bun scripts/drop-claude-mem-import.ts
 *   systemctl --user start captain-memo-worker
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import * as sqliteVec from 'sqlite-vec';

const DATA_DIR = process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo');
const META_PATH = join(DATA_DIR, 'meta.sqlite3');
const VEC_PATH = join(DATA_DIR, 'vector-db', 'embeddings.db');

const meta = new Database(META_PATH);
meta.exec('PRAGMA journal_mode = WAL;');
meta.exec('PRAGMA foreign_keys = ON;');

const vec = new Database(VEC_PATH);
sqliteVec.load(vec);
vec.exec('PRAGMA journal_mode = WAL;');

const docs = meta
  .query(`SELECT id, source_path FROM documents WHERE source_path LIKE 'claude-mem://%'`)
  .all() as Array<{ id: number; source_path: string }>;

if (docs.length === 0) {
  console.log('No claude-mem imports found — nothing to do.');
  process.exit(0);
}

const docIds = docs.map(d => d.id);
const chunkRows = meta
  .query(
    `SELECT chunk_id FROM chunks WHERE document_id IN (${docIds.map(() => '?').join(',')})`,
  )
  .all(...docIds) as Array<{ chunk_id: string }>;
const chunkIds = chunkRows.map(r => r.chunk_id);

console.log(`Found ${docs.length} claude-mem documents producing ${chunkIds.length} chunks.`);
console.log('Deleting from vector-db ...');

const VEC_BATCH = 500;
let vecDeleted = 0;
for (let i = 0; i < chunkIds.length; i += VEC_BATCH) {
  const batch = chunkIds.slice(i, i + VEC_BATCH);
  const placeholders = batch.map(() => '?').join(',');
  vec.query(`DELETE FROM vec_chunks WHERE chunk_id IN (${placeholders})`).run(...batch);
  vec.query(`DELETE FROM vec_chunk_meta WHERE chunk_id IN (${placeholders})`).run(...batch);
  vecDeleted += batch.length;
  process.stdout.write(`\r  ${vecDeleted}/${chunkIds.length}`);
}
process.stdout.write('\n');

console.log('Deleting from meta (cascades chunks + FTS) ...');
const tx = meta.transaction(() => {
  const stmt = meta.query(`DELETE FROM documents WHERE id = ?`);
  for (const id of docIds) stmt.run(id);
});
tx();

console.log(`\nDone. Removed ${docs.length} documents and ${chunkIds.length} chunks.`);
console.log('Run VACUUM on both DBs to reclaim disk:');
console.log(`  sqlite3 ${META_PATH} 'VACUUM'`);
console.log(`  sqlite3 ${VEC_PATH} 'VACUUM'`);

meta.close();
vec.close();
