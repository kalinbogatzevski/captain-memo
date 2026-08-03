import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { workerGet } from '../client.ts';
import { fmtBytes } from '../../shared/format.ts';
import { VectorStore, VEC_CHUNK_SIZE } from '../../worker/vector-store.ts';
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


/** Rebuild the partitioned vector table at the current VEC_CHUNK_SIZE, if this file has one and
 *  it differs. Returns how many vectors were moved (0 when there is nothing to do). Opens its own
 *  handle and closes it before the caller opens the file for VACUUM.
 *
 *  Failure is reported and swallowed: a chunk-layout re-lay is an optimisation and must never be
 *  the reason a vacuum aborts. */
function rebuildVectorLayout(path: string): number {
  let probe: Database | null = null;
  let dim = 0;
  try {
    probe = new Database(path, { readonly: true });
    const row = probe.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_chunks_p'`)
      .get() as { sql: string } | null;
    if (!row?.sql) return 0;                                     // not the vector db
    const current = /chunk_size\s*=\s*(\d+)/.exec(row.sql);
    if (current && Number(current[1]) === VEC_CHUNK_SIZE) return 0;
    const m = /embedding\s+FLOAT\s*\[\s*(\d+)\s*\]/i.exec(row.sql);
    if (!m) return 0;                                            // unrecognised shape — leave it alone
    dim = Number(m[1]);
  } catch (err) {
    console.log(`  (vector chunk re-lay skipped: ${(err as Error).message})`);
    return 0;
  } finally {
    probe?.close();
  }
  let store: VectorStore | null = null;
  try {
    store = new VectorStore({ dbPath: path, dimension: dim });
    return store.rebuildChunkLayout()?.moved ?? 0;
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
