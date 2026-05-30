import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { workerGet } from '../client.ts';
import { fmtBytes } from '../../shared/format.ts';
import { DATA_DIR, DEFAULT_WORKER_PORT, META_DB_PATH, VECTOR_DB_DIR } from '../../shared/paths.ts';
import { isWindows } from '../../shared/platform.ts';
import { getServiceManager } from '../../services/service-manager/index.ts';

const TARGETS: Array<{ label: string; path: string }> = [
  { label: 'meta.sqlite3', path: META_DB_PATH },
  { label: 'vector-db/embeddings.db', path: join(VECTOR_DB_DIR, 'embeddings.db') },
];

function fileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

async function workerIsRunning(): Promise<boolean> {
  try {
    await workerGet('/health');
    return true;
  } catch {
    return false;
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
  let totalAfter = 0;

  try {
    for (const t of TARGETS) {
      if (!existsSync(t.path)) {
        console.log(`  ${t.label.padEnd(32)} (missing — skipped)`);
        continue;
      }
      const before = fileSize(t.path);
      const db = new Database(t.path);
      try {
        // Checkpoint the WAL first so VACUUM sees the latest state on disk
        // (without this, freed pages held only in WAL frames don't get reclaimed).
        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* not all DBs are WAL */ }
        db.exec('VACUUM;');
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
  console.log(`  Total: ${fmtBytes(totalBefore)} → ${fmtBytes(totalAfter)}  (saved ${fmtBytes(totalSaved)})`);
  return 0;
}
