import { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { DATA_DIR, QUEUE_DB_PATH, META_DB_PATH, VECTOR_DB_DIR } from '../../shared/paths.ts';
import { findOrphanVectors, deleteOrphanVectors, reclaimDb, openVectorDbForMaintenance } from '../../worker/maintenance.ts';
import { ObservationQueue } from '../../worker/observation-queue.ts';

const MB = 1024 * 1024;
const size = (p: string): number => (existsSync(p) ? statSync(p).size : 0);
const fmt = (b: number): string => `${(b / MB).toFixed(1)} MB`;

/** `captain-memo maintenance [--apply] [--retention-days N]`
 *
 *  Reports what the databases are carrying that nothing needs, and with --apply removes it. Dry-run by
 *  default: this deletes rows, and a tool that deletes should show its work before it does.
 *
 *  The same work runs automatically in the worker on an hourly sweep — this command exists so it can be
 *  run on demand, and so the numbers are inspectable without reading a log. */
export async function maintenanceCommand(args: string[]): Promise<number> {
  const apply = args.includes('--apply');
  const dIdx = args.indexOf('--retention-days');
  const retentionDays = dIdx >= 0 ? Number(args[dIdx + 1]) : 30;
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    console.error('--retention-days must be a non-negative number');
    return 2;
  }

  const vecPath = join(VECTOR_DB_DIR, 'embeddings.db');
  console.log(`\n  data dir: ${DATA_DIR}\n`);
  console.log('  before:');
  for (const [label, p] of [['queue.db', QUEUE_DB_PATH], ['meta.sqlite3', META_DB_PATH], ['embeddings.db', vecPath]] as const) {
    if (size(p) > 0) console.log(`    ${label.padEnd(16)} ${fmt(size(p)).padStart(10)}`);
  }
  console.log();

  // ── 1. finished queue rows past the retention window ───────────────────────────────────────────
  if (existsSync(QUEUE_DB_PATH) && retentionDays > 0) {
    const queue = new ObservationQueue(QUEUE_DB_PATH);
    try {
      const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86_400;
      const doneTotal = queue.doneCount();
      if (apply) {
        const removed = queue.pruneDone(cutoff);
        if (removed > 0) queue.reclaim();
        console.log(`  queue: removed ${removed.toLocaleString()} finished row(s) older than ${retentionDays}d (of ${doneTotal.toLocaleString()} finished)`);
      } else {
        // Count without deleting — same predicate the prune uses.
        const n = (queue as unknown as { db: Database }).db
          .query("SELECT COUNT(*) AS n FROM observation_queue WHERE status = 'done' AND processed_at_epoch < ?")
          .get(cutoff) as { n: number };
        console.log(`  queue: would remove ${n.n.toLocaleString()} finished row(s) older than ${retentionDays}d (of ${doneTotal.toLocaleString()} finished)`);
      }
    } finally { queue.close(); }
  }

  // ── 2. embeddings whose chunk no longer exists ─────────────────────────────────────────────────
  if (existsSync(vecPath) && existsSync(META_DB_PATH)) {
    const vec = openVectorDbForMaintenance(vecPath);
    try {
      const orphans = findOrphanVectors(vec, META_DB_PATH);
      if (apply) {
        const removed = deleteOrphanVectors(vec, orphans);
        if (removed > 0) reclaimDb(vec);
        console.log(`  vectors: removed ${removed.toLocaleString()} orphaned embedding(s)`);
      } else {
        console.log(`  vectors: would remove ${orphans.length.toLocaleString()} orphaned embedding(s)`);
      }
    } finally { vec.close(); }
  }

  if (apply) {
    console.log('\n  after:');
    for (const [label, p] of [['queue.db', QUEUE_DB_PATH], ['meta.sqlite3', META_DB_PATH], ['embeddings.db', vecPath]] as const) {
      if (size(p) > 0) console.log(`    ${label.padEnd(16)} ${fmt(size(p)).padStart(10)}`);
    }
  } else {
    console.log('\n  Nothing was changed. Re-run with --apply to reclaim it.');
  }
  console.log();
  return 0;
}
