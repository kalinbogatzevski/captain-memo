import { existsSync, statSync, statfsSync } from 'fs';
import { dirname, join } from 'path';
import { Database } from 'bun:sqlite';
import { workerGet } from '../client.ts';
import { fmtBytes } from '../../shared/format.ts';
import { VectorStore, VEC_CHUNK_SIZE, vectorOccupancy, type VectorOccupancy } from '../../worker/vector-store.ts';
import { DATA_DIR, DEFAULT_WORKER_PORT, META_DB_PATH, VECTOR_DB_DIR } from '../../shared/paths.ts';
import { isWindows } from '../../shared/platform.ts';
import { getServiceManager } from '../../services/service-manager/index.ts';

const TARGETS: Array<{ label: string; path: string }> = [
  { label: 'meta.sqlite3', path: META_DB_PATH },
  { label: 'vector-db/embeddings.db', path: join(VECTOR_DB_DIR, 'embeddings.db') },
];

/** Size of a SQLite database AS IT SITS ON DISK — the main file plus its -wal and -shm. A store
 *  mid-checkpoint can carry a -wal as large as the database itself, so measuring the main file
 *  alone reports a saving the user cannot see in `du`. */
function fileSize(path: string): number {
  let total = 0;
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(p)) continue;
    try { total += statSync(p).size; } catch { /* raced with a checkpoint; treat as 0 */ }
  }
  return total;
}

async function workerIsRunning(): Promise<boolean> {
  try {
    await workerGet('/health');
    return true;
  } catch {
    return false;
  }
}


/** A vector index already at VEC_CHUNK_SIZE is re-packed once a re-pack would shed at least this share of its chunks
 *  (vectorOccupancy: chunks against denseChunks). Not a fixed fill: a dense index of many small partitions sits well under 1
 *  (the dev store, 469 partitions: 0.90 dense), and a floor on the fill alone would re-pack such a store on every vacuum for nothing.
 *
 *  Dev store, 2026-10-26: 328,578 vectors in 4,944 chunks, 2,863 would do: 42% to shed, 1.04 GB of the 2.5 GB file. The cluster
 *  moves of the IVF rebalance (13-37k a day, 21.8k on average, journal 10-15..10-26) leave holes that only a re-pack refills, ~90 MB
 *  a day; at that rate (an estimate: one new slot per move) a store just re-packed is past 25% again in about a week. 25% keeps a
 *  vacuum run for another reason from a copy of every vector to win back a few percent.
 *
 *  TIME (synthetic, dim 1024, 50k vectors in 70 partitions at 54% fill, on disk, nice 19 + ionice idle, box at load ~10): the re-lay took
 *  86.4 s = 1.73 ms a vector (10k vectors: 1.58 ms), and the VACUUM after it 13.4 s. At the dev store's 328k vectors that is about
 *  9.5 min plus ~1.5 min of VACUUM, the worker down for all of it. */
export const COMPACT_RECLAIM_AT = 0.25;

/** Free space a re-pack needs, as a multiple of the dense payload (denseChunks x chunk size x dim x 4 bytes). The rebuild is one
 *  transaction: the relay copy is appended to the file (+1x; the old table's pages are only freed at the DROP, and the rebuilt
 *  table's pages go to the WAL first) and the WAL holds the relay and the rebuilt table (+2x) until the checkpoint after the commit.
 *  MEASURED, synthetic 10k vectors dim 1024 (43 MB dense): file system used grew by 131 MB at the commit = 3.07x. 3.5x leaves
 *  ~14% headroom. The VACUUM that follows is a copy of the result in a temp file plus the same again in the WAL, ~2x, so
 *  this is the peak of both. */
export const COMPACT_PEAK_FACTOR = 3.5;

/** Free bytes on the file system holding `dir`; throws where the platform cannot say. */
function freeBytesOn(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

const pctFull = (o: VectorOccupancy) => o.slots > 0 ? Math.round((o.live / o.slots) * 100) : 100;
const occupancyOf = (path: string): VectorOccupancy | null => {
  const db = new Database(path, { readonly: true });
  try { return vectorOccupancy(db); } finally { db.close(); }
};

/** Rebuild the partitioned vector table, if this file has one: at the current VEC_CHUNK_SIZE when it was built at another, or at the
 *  same size when it has gone sparse (COMPACT_RECLAIM_AT) and the disk has room for it (COMPACT_PEAK_FACTOR). Returns how many
 *  vectors were moved (0 when there is nothing to do, or it was not done). Opens its own handle and closes it before the caller
 *  opens the file for VACUUM. `freeBytes` is injectable for the test.
 *
 *  Failure is reported and swallowed: a chunk-layout re-lay is an optimisation and must never be
 *  the reason a vacuum aborts. A refusal for lack of room is the same: reported, and the vacuum goes on. */
export function rebuildVectorLayout(path: string, freeBytes: (dir: string) => number = freeBytesOn): number {
  let probe: Database | null = null;
  let dim = 0;
  let before: VectorOccupancy | null = null;
  try {
    probe = new Database(path, { readonly: true });
    const row = probe.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_chunks_p'`)
      .get() as { sql: string } | null;
    if (!row?.sql) return 0;                                     // not the vector db
    const m = /embedding\s+FLOAT\s*\[\s*(\d+)\s*\]/i.exec(row.sql);
    if (!m) return 0;                                            // unrecognised shape — leave it alone
    dim = Number(m[1]);
    const current = /chunk_size\s*=\s*(\d+)/.exec(row.sql);
    if (current && Number(current[1]) === VEC_CHUNK_SIZE) {
      // Already at the right size: only a sparse index is worth a copy of every vector.
      before = vectorOccupancy(probe);
      if (!before || before.chunks === 0 || before.denseChunks > before.chunks * (1 - COMPACT_RECLAIM_AT)) return 0;
      const need = Math.ceil(COMPACT_PEAK_FACTOR * before.denseChunks * VEC_CHUNK_SIZE * dim * 4);
      let free: number;
      try { free = freeBytes(dirname(path)); } catch (err) {
        console.log(`  vector index ${pctFull(before)}% full, NOT re-packed: cannot read the free space (${(err as Error).message}); it needs ${fmtBytes(need)}`);
        return 0;
      }
      // `!(free >= need)`, not `free < need`: a platform whose statfs lacks a field gives NaN, and that must refuse, not pass.
      if (!(free >= need)) {
        console.log(`  vector index ${pctFull(before)}% full, NOT re-packed: the rebuild needs ${fmtBytes(need)} free `
          + `(the relay copy and the rebuilt table, in the file and in the WAL, at once) and ${dirname(path)} has `
          + (Number.isFinite(free) ? fmtBytes(free) : 'no readable free-space figure'));
        return 0;
      }
      console.log(`  vector index ${pctFull(before)}% full (${before.live.toLocaleString()} vectors in ${before.slots.toLocaleString()} slots, `
        + `${fmtBytes(before.slots * dim * 4)}): re-packing into ${(before.denseChunks * VEC_CHUNK_SIZE).toLocaleString()} slots ...`);
    }
  } catch (err) {
    console.log(`  (vector chunk re-lay skipped: ${(err as Error).message})`);
    return 0;
  } finally {
    probe?.close();
  }
  let store: VectorStore | null = null;
  try {
    store = new VectorStore({ dbPath: path, dimension: dim });
    const moved = store.rebuildChunkLayout(VEC_CHUNK_SIZE, before !== null)?.moved ?? 0;
    store.close(); store = null;
    const after = before && occupancyOf(path);
    if (after) console.log(`  vector index re-packed: ${after.live.toLocaleString()} vectors in ${after.slots.toLocaleString()} slots, `
      + `${pctFull(after)}% full, ${fmtBytes(after.slots * dim * 4)}`);
    return moved;
  } catch (err) {
    console.log(`  (vector chunk re-lay skipped: ${(err as Error).message})`);
    return 0;
  } finally {
    store?.close();
  }
}

export async function vacuumCommand(args: string[] = []): Promise<number> {
  const force = args.includes('--force');

  // VACUUM acquires an exclusive write lock — racing with the worker corrupts
  // nothing but will block one side or fail. With --force we stop the worker
  // ourselves around the VACUUM and restart it after; otherwise we refuse and
  // tell the user how to stop it (OS-aware: no systemctl text on Windows).
  let stoppedByUs = false;
  if (await workerIsRunning()) {
    if (!force) {
      const stopHint = isWindows
        ? 'Stop the worker first so VACUUM can take an exclusive lock:\n' +
          '  captain-memo stop          (or disable the captain-memo-worker Scheduled Task)\n' +
          '  captain-memo vacuum\n' +
          '  captain-memo start'
        : 'Stop the worker first so VACUUM can take an exclusive lock:\n' +
          '  systemctl --user stop captain-memo-worker\n' +
          '  captain-memo vacuum\n' +
          '  systemctl --user start captain-memo-worker';
      console.error(
        'Worker is running. ' + stopHint +
        '\n\nOr re-run with --force to stop it automatically, VACUUM, then restart.',
      );
      return 1;
    }
    // --force: stop gracefully (POST /shutdown releases the SQLite lock cleanly).
    const svc = getServiceManager();
    console.log('Stopping worker for VACUUM ...');
    await svc.stop('captain-memo-worker', { graceful: true, port: DEFAULT_WORKER_PORT });
    stoppedByUs = true;
  }

  console.log(`Vacuuming ${DATA_DIR}/ ...`);
  let totalBefore = 0;
  let relaidChunks = 0;
  let totalAfter = 0;

  try {
    for (const t of TARGETS) {
      if (!existsSync(t.path)) {
        console.log(`  ${t.label.padEnd(32)} (missing — skipped)`);
        continue;
      }
      const before = fileSize(t.path);
      relaidChunks += rebuildVectorLayout(t.path);
      const db = new Database(t.path);
      try {
        // Checkpoint the WAL first so VACUUM sees the latest state on disk
        // (without this, freed pages held only in WAL frames don't get reclaimed).
        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* not all DBs are WAL */ }
        // Re-lay the vector index if it predates the chunk_size default. vec0 fixes chunk_size at
        // CREATE time and scans whole chunks, so a store built at the stock 1024 against ~300-vector
        // clusters carries ~70% empty space AND pays for scanning it. Measured on a 144k-vector
        // store: 1888 MB -> 578 MB, p50 62.7 ms -> 36.4 ms, results byte-identical.
        //
        // It belongs here rather than in the sweep: chunk_size cannot be altered in place, so the
        // rebuild is copy-out/drop/recreate/copy-back, and that needs the exclusive lock VACUUM has
        // already taken with the worker stopped. Running it under a live worker is not safe.
        db.exec('VACUUM;');
        // And checkpoint AFTER. VACUUM rewrites the entire database, and in WAL mode that rewrite
        // goes THROUGH the WAL — so vacuuming a 730 MB store leaves a ~730 MB -wal beside it and
        // the reported saving is fiction until it drains. Checkpointing before only (which is what
        // this did) made `vacuum` claim 1.17 GB freed while 734 MB sat in the WAL.
        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* not all DBs are WAL */ }
      } finally {
        db.close();
      }
      const after = fileSize(t.path);
      totalBefore += before;
      totalAfter += after;
      const saved = before - after;
      let pct = '';
      if (before > 0 && saved > 0) {
        pct = ` (-${((saved / before) * 100).toFixed(0)}%)`;
      }
      console.log(`  ${t.label.padEnd(32)} ${fmtBytes(before)} → ${fmtBytes(after)}${pct}`);
    }
  } finally {
    // Always restart the worker if we stopped it — even if VACUUM threw.
    if (stoppedByUs) {
      console.log('Restarting worker ...');
      await getServiceManager().start('captain-memo-worker');
    }
  }

  const totalSaved = totalBefore - totalAfter;
  console.log('─────────────────────────────────────────────');
  if (relaidChunks > 0) {
    console.log(`  Vector index re-laid at ${VEC_CHUNK_SIZE} vectors/chunk (${relaidChunks.toLocaleString()} vectors)`);
  }
  console.log(`  Total: ${fmtBytes(totalBefore)} → ${fmtBytes(totalAfter)}  (saved ${fmtBytes(totalSaved)})`);
  return 0;
}
