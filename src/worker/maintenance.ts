import { Database } from 'bun:sqlite';
import { ensureExtensionCapableSqlite } from '../shared/sqlite-extensions.ts';
import * as sqliteVec from 'sqlite-vec';
import { VECTOR_BUSY_TIMEOUT_MS } from './vector-store.ts';
import { isMemoryFilePath } from './ingest.ts';

/** Housekeeping for the on-disk stores.
 *
 *  Measured on the heaviest known install: 807.9 MB of embeddings holding 195,518 vectors against
 *  138,146 live chunks, 57,373 of them (29.3%) pointing at a chunk that no longer exists.
 *
 *  Root cause (found 2026-09-30): `/reindex` with force dropped each document before re-indexing it, so
 *  the old vectors were never deleted; 97% of 26,818 orphans on the dev store came from that, the rest from
 *  two overlapping indexFile calls on one path. Both are fixed at the source. The worker still runs an
 *  hourly sweep (sweepOrphanVectors below) and REPORTS what it removed: a number that keeps coming back means a
 *  new leak.
 *
 *  Removing orphans frees little disk: vec0 keeps fixed 128-slot chunk blobs, and VACUUM after removing
 *  26.8K vectors took the 1206.5 MB store to 1191.5 MB (about 15 MB) for ~100 s of exclusive lock plus a
 *  1.3 GB WAL. The gain is search quality (one query had 9 of its top 10 slots taken by orphans), so
 *  embeddings.db is not VACUUMed here. */

/** Rows of vec_chunk_meta read per page while finding orphans. vec_chunk_meta is a rowid table, so a page
 *  is a rowid RANGE (bounded work whether it holds 0 orphans or all of them), not a LIMIT over matches.
 *  Measured on the federation line (identical code path), on a copy of the dev store (255k vectors, 2026-09-30): 41 pages,
 *  the longest 49-86 ms, ~0.4-0.8 s in all (the single-statement anti-join it replaced was 1.3 s in one block). */
export const ORPHAN_FIND_PAGE = 10_000;

/** Ids deleted per transaction. vec0 cannot use its key for an IN list (1.6-8.5 s per IN(500) on the dev
 *  store), so each id is its own primary-key delete, and the meta row goes by its full primary key
 *  (collection_name, chunk_id): by chunk_id alone it scans the table per id.
 *  Measured on the federation line (identical code path), on a copy of the dev store (2026-09-30): all 26,820 orphans in 1,073
 *  transactions of 25 with 50 ms between them: hold p50 32 ms, p95 63, p99 73, max 128 ms; a concurrent writer
 *  (probe every 25 ms) waited at most 129 ms, 0 errors. At 50 ids (synchronous=FULL) p95 was 138 ms; the old single IN-list
 *  transaction held the lock 129 s. */
export const ORPHAN_DELETE_BATCH = 25;

export interface OrphanVector { collection_name: string; chunk_id: string }

/** Vectors whose chunk is gone from the metadata database, with the collection each belongs to.
 *
 *  Joined on `chunk_id` (the TEXT key, e.g. `observation:9734:QVvPjBBp`), NOT `chunks.id`, which is a
 *  separate integer autoincrement. Using the wrong one reports every vector as orphaned, a result that
 *  looks authoritative and is nonsense: search plainly works, so vectors obviously do match chunks.
 *
 *  Paged by rowid range with `yieldToLoop` between pages, so a caller on the worker's thread never
 *  blocks for the whole scan. Each page is one statement, one consistent snapshot of both databases. */
export async function findOrphanVectors(
  vec: Database, metaDbPath: string, yieldToLoop?: () => Promise<void>,
): Promise<OrphanVector[]> {
  vec.exec(`ATTACH DATABASE '${metaDbPath.replace(/'/g, "''")}' AS meta_gc`);
  try {
    const max = (vec.query('SELECT MAX(rowid) AS m FROM vec_chunk_meta').get() as { m: number | null }).m ?? 0;
    const page = vec.query(
      `SELECT collection_name, chunk_id FROM vec_chunk_meta m
        WHERE m.rowid > ? AND m.rowid <= ?
          AND NOT EXISTS (SELECT 1 FROM meta_gc.chunks c WHERE c.chunk_id = m.chunk_id)`,
    );
    const out: OrphanVector[] = [];
    for (let lo = 0; lo < max; lo += ORPHAN_FIND_PAGE) {
      out.push(...(page.all(lo, lo + ORPHAN_FIND_PAGE) as OrphanVector[]));
      if (yieldToLoop) await yieldToLoop();
    }
    return out;
  } finally {
    try { vec.exec('DETACH DATABASE meta_gc'); } catch { /* already gone */ }
  }
}

/** Remove those vectors from both the index and its side table, ORPHAN_DELETE_BATCH ids per transaction,
 *  awaiting `pause` between transactions so a live worker gets the write lock back. Returns how many
 *  vec_chunk_meta rows went.
 *
 *  `vec_chunks_p` is the live partitioned index; the older unpartitioned `vec_chunks` still exists on
 *  installs that predate the migration, so whichever are present are cleared together. */
export async function deleteOrphanVectors(
  vec: Database, orphans: OrphanVector[], pause?: () => Promise<void>,
): Promise<number> {
  if (orphans.length === 0) return 0;

  // WHICH vector tables this database actually has. `vec_chunks_p` is the live partitioned index;
  // the older unpartitioned `vec_chunks` still exists on installs that predate that migration.
  const present = (vec.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('vec_chunks_p','vec_chunks')",
  ).all() as Array<{ name: string }>).map(r => r.name);

  // FAIL RATHER THAN HALF-CLEAN. Deleting from a vec0 virtual table needs the sqlite-vec extension
  // loaded in THIS process. Swallowing that error would clear vec_chunk_meta while leaving the actual
  // embeddings behind, orphaned in the opposite direction, invisible to this very check, and strictly
  // worse than the state we set out to fix. If the index cannot be written, nothing is written.
  for (const table of present) {
    try { vec.query(`SELECT chunk_id FROM ${table} LIMIT 1`).get(); }
    catch (err) {
      throw new Error(
        `cannot access ${table} (the sqlite-vec extension is not loaded in this process), refusing to `
        + `delete vec_chunk_meta rows on their own, which would leave the embeddings orphaned the other `
        + `way: ${(err as Error).message}`,
      );
    }
  }

  const delVec = present.map(t => vec.query(`DELETE FROM ${t} WHERE chunk_id = ?`));
  const delMeta = vec.query('DELETE FROM vec_chunk_meta WHERE collection_name = ? AND chunk_id = ?');
  let removed = 0;
  for (let i = 0; i < orphans.length; i += ORPHAN_DELETE_BATCH) {
    if (i > 0 && pause) await pause();
    vec.transaction(() => {
      for (const o of orphans.slice(i, i + ORPHAN_DELETE_BATCH)) {
        for (const d of delVec) d.run(o.chunk_id);
        removed += Number(delMeta.run(o.collection_name, o.chunk_id).changes ?? 0);
      }
    })();
  }
  return removed;
}

/** Memory-channel documents that are not markdown: files a too-wide watcher indexed as memory (a captain
 *  had ~/.codex/logs_2.sqlite-wal and models_cache.json). The rule is the one ingest now refuses by, not
 *  "no watch pattern matches": remembered memories live outside every watch pattern and must stay.
 *  With `apply` the documents go, their chunks with them (ON DELETE CASCADE); the vectors are then orphans
 *  for the orphan step that follows. Returns the paths. */
export function removeNonMarkdownMemoryDocuments(metaDbPath: string, apply: boolean): string[] {
  const db = new Database(metaDbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    const paths = (db.query("SELECT source_path FROM documents WHERE channel = 'memory'").all() as Array<{ source_path: string }>)
      .map(r => r.source_path).filter(p => !isMemoryFilePath(p));
    if (apply) {
      const del = db.query('DELETE FROM documents WHERE source_path = ?');
      db.transaction(() => { for (const p of paths) del.run(p); })();
    }
    return paths;
  } finally {
    db.close();
  }
}

export interface ZeroVectorChunk { chunk_id: string; source_path: string; sha: string; channel: string }

/** Vectors that are all zeros (or non-finite), and which of them still belong to a live chunk. Those were
 *  stored by an embed failure that used to fall back to zero vectors; the live ones can be re-embedded
 *  through the pending_embed queue under the same chunk id. A full vec0 scan: 17.9 s over 255,591 vectors on
 *  the dev store (2026-09-30, measured on the federation line), in the CLI process; WAL readers do not block the worker. */
export function findZeroVectorChunks(vec: Database, metaDbPath: string): { total: number; live: ZeroVectorChunk[] } {
  const first = vec.query('SELECT vec_length(embedding) AS d FROM vec_chunks_p LIMIT 1').get() as { d: number } | null;
  if (!first) return { total: 0, live: [] };
  const origin = new Uint8Array(new Float32Array(first.d).buffer);
  // NULL is how SQLite returns a NaN distance; > 1e300 catches an infinite one.
  const ids = (vec.query(
    `SELECT chunk_id FROM (SELECT chunk_id, vec_distance_l2(embedding, ?) AS d FROM vec_chunks_p)
      WHERE (d > 0 AND d < 1e300) IS NOT 1`,
  ).all(origin) as Array<{ chunk_id: string }>).map(r => r.chunk_id);
  if (ids.length === 0) return { total: 0, live: [] };
  vec.exec(`ATTACH DATABASE '${metaDbPath.replace(/'/g, "''")}' AS meta_zv`);
  try {
    const q = vec.query(
      `SELECT c.chunk_id, c.sha, d.source_path, d.channel FROM meta_zv.chunks c
         JOIN meta_zv.documents d ON d.id = c.document_id WHERE c.chunk_id = ?`,
    );
    const live = ids.map(id => q.get(id) as ZeroVectorChunk | null).filter((r): r is ZeroVectorChunk => r !== null);
    return { total: ids.length, live };
  } finally {
    try { vec.exec('DETACH DATABASE meta_zv'); } catch { /* already gone */ }
  }
}

/** Most orphans one worker sweep removes. The first sweep after an upgrade meets the whole backlog (26,820
 *  on the dev store); the rest goes on later sweeps, or at once with `captain-memo maintenance --apply`. */
export const ORPHAN_SWEEP_MAX = 5_000;

/** Pause between delete transactions in the worker sweep, so the writer thread spends at most ~15% of the
 *  sweep's wall time in it (p50 hold ~32 ms against this pause). */
export const ORPHAN_SWEEP_PAUSE_MS = 250;

/** The worker's hourly orphan sweep, on its own connection: find (paged, yielding between pages), then
 *  delete up to ORPHAN_SWEEP_MAX in paced batches. `pause` may throw to stop early (worker shutdown).
 *  Measured on the federation line (identical code path), on a copy of the dev store (26,820 orphans,
 *  2026-09-30): a backlog sweep ran 57 s wall, 7.1-7.5 s of it not paused (12-13%), longest event-loop block
 *  80 ms (one 811 ms outlier on the first run of a freshly copied file); a clean sweep (0 orphans) is
 *  ~0.45 s wall, longest block 59 ms, once an hour. */
export async function sweepOrphanVectors(
  vectorDbPath: string, metaDbPath: string, pause: () => Promise<void>,
): Promise<{ found: number; removed: number }> {
  const vec = openVectorDbForMaintenance(vectorDbPath);
  try {
    const orphans = await findOrphanVectors(vec, metaDbPath, () => new Promise<void>(r => setImmediate(r)));
    const removed = await deleteOrphanVectors(vec, orphans.slice(0, ORPHAN_SWEEP_MAX), pause);
    return { found: orphans.length, removed };
  } finally {
    vec.close();
  }
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
  db.exec(`PRAGMA busy_timeout = ${VECTOR_BUSY_TIMEOUT_MS}`);   // wait out a worker write, don't throw SQLITE_BUSY
  // As the worker's own connection (vector-store.ts). At the default FULL every commit fsyncs the WAL, and
  // that fsync was ~35-45 ms of each ~50 ms delete transaction, all of it with the write lock held.
  db.exec('PRAGMA synchronous = NORMAL');
  sqliteVec.load(db);
  return db;
}
