import { Database } from 'bun:sqlite';
import { ensureExtensionCapableSqlite } from '../shared/sqlite-extensions.ts';
import * as sqliteVec from 'sqlite-vec';

/** Housekeeping for the on-disk stores.
 *
 *  Measured on the heaviest known install: 807.9 MB of embeddings holding 195,518 vectors against
 *  138,146 live chunks — 57,373 of them (29.3%) pointing at a chunk that no longer exists, roughly
 *  235 MB. Every live chunk WAS indexed (0 missing), so nothing was broken; the store had simply never
 *  had anything remove what re-indexing left behind.
 *
 *  The current delete path looks correct, so this deliberately does NOT claim a root cause. It keeps the
 *  store bounded and REPORTS what it removed — if a leak still exists, the number comes back every sweep
 *  instead of accumulating in silence, which is the only way to tell the two apart from the outside. */

/** Chunk ids present in the vector store whose chunk is gone from the metadata database.
 *
 *  Joined on `chunk_id` (the TEXT key, e.g. `observation:9734:QVvPjBBp`) — NOT `chunks.id`, which is a
 *  separate integer autoincrement. Using the wrong one reports every vector as orphaned, a result that
 *  looks authoritative and is nonsense: search plainly works, so vectors obviously do match chunks. */
export function findOrphanVectors(vec: Database, metaDbPath: string): string[] {
  vec.exec(`ATTACH DATABASE '${metaDbPath.replace(/'/g, "''")}' AS meta_gc`);
  try {
    const rows = vec.query(
      `SELECT DISTINCT chunk_id FROM vec_chunk_meta
        WHERE chunk_id NOT IN (SELECT chunk_id FROM meta_gc.chunks)`,
    ).all() as Array<{ chunk_id: string }>;
    return rows.map(r => r.chunk_id);
  } finally {
    try { vec.exec('DETACH DATABASE meta_gc'); } catch { /* already gone */ }
  }
}

/** Remove those vectors from both the index and its side table. Returns how many went.
 *
 *  Batched because SQLite caps host parameters per statement (999 in older builds) and a real sweep
 *  carries tens of thousands of ids — one IN(...) would simply throw.
 *
 *  `vec_chunks_p` is the live partitioned index; the older unpartitioned `vec_chunks` still exists on
 *  installs that predate the migration, so whichever are present are cleared together. */
export function deleteOrphanVectors(vec: Database, ids: string[]): number {
  if (ids.length === 0) return 0;

  // WHICH vector tables this database actually has. `vec_chunks_p` is the live partitioned index;
  // the older unpartitioned `vec_chunks` still exists on installs that predate that migration.
  const present = (vec.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('vec_chunks_p','vec_chunks')",
  ).all() as Array<{ name: string }>).map(r => r.name);

  // FAIL RATHER THAN HALF-CLEAN. Deleting from a vec0 virtual table needs the sqlite-vec extension
  // loaded in THIS process. Swallowing that error would clear vec_chunk_meta while leaving the actual
  // embeddings behind — orphaned in the opposite direction, invisible to this very check, and strictly
  // worse than the state we set out to fix. If the index cannot be written, nothing is written.
  for (const table of present) {
    try { vec.query(`SELECT chunk_id FROM ${table} LIMIT 1`).get(); }
    catch (err) {
      throw new Error(
        `cannot access ${table} (the sqlite-vec extension is not loaded in this process) — refusing to `
        + `delete vec_chunk_meta rows on their own, which would leave the embeddings orphaned the other `
        + `way: ${(err as Error).message}`,
      );
    }
  }

  const BATCH = 500;   // SQLite caps host parameters per statement; a real sweep carries tens of thousands
  let removed = 0;
  const tx = vec.transaction(() => {
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const q = slice.map(() => '?').join(',');
      for (const table of present) {
        vec.query(`DELETE FROM ${table} WHERE chunk_id IN (${q})`).run(...slice);
      }
      const r = vec.query(`DELETE FROM vec_chunk_meta WHERE chunk_id IN (${q})`).run(...slice);
      removed += Number(r.changes ?? 0);
    }
  });
  tx();
  return removed;
}

/** Return freed pages to the filesystem.
 *
 *  SQLite does not shrink a file on DELETE — the pages go on the free list — and in WAL mode VACUUM
 *  writes the rewrite into the -wal sidecar, so without the checkpoint the main database stays exactly
 *  as large as before. Measured: VACUUM alone left a 2.8 MB test file at 2.8 MB. */
export function reclaimDb(db: Database): void {
  db.exec('VACUUM');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

/** Open the embeddings database WITH the vec0 extension loaded.
 *
 *  Reading or writing a vec0 virtual table requires the extension in the calling process — a plain
 *  `new Database(path)` can see `vec_chunk_meta` (an ordinary table) but not `vec_chunks_p`. That
 *  asymmetry is the trap: a maintenance pass without the extension would happily clear the side table
 *  and leave every embedding behind. */
export function openVectorDbForMaintenance(dbPath: string): Database {
  ensureExtensionCapableSqlite();
  const db = new Database(dbPath);
  sqliteVec.load(db);
  return db;
}
