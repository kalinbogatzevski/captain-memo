import { ObservationQueue } from '../../worker/observation-queue.ts';
import { QUEUE_DB_PATH } from '../../shared/paths.ts';
import { existsSync } from 'fs';

/** `captain-memo queue dedupe [--apply]`
 *
 *  Repair tool for installs affected by the capture amplification bug (fixed in 0.27.44): a growing
 *  session's whole history was re-enqueued on every tick, so the queue filled with re-summarisations of
 *  turns the corpus already holds. Each pending row is a real LLM call, so draining them spends money to
 *  produce duplicates.
 *
 *  Dry-run by default. Deletes ONLY rows whose (session_id, prompt_number) is already `done` or already
 *  present on an earlier pending row; never touches anything in flight. */
export async function queueCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub !== 'dedupe' && sub !== 'retry') {
    console.log('usage: captain-memo queue <dedupe|retry> [--apply] [--limit N]');
    console.log('  dedupe  Removes re-enqueued duplicate observations left by the pre-0.27.44 capture bug.');
    console.log('  retry   Releases DEAD-LETTERED observations back to pending (e.g. rows that failed');
    console.log('          while the summarizer had no credentials). The worker re-tries these on its');
    console.log('          own once a provider comes back; this is the on-demand version.');
    console.log('  Both run as a DRY RUN unless --apply is given.');
    return sub ? 2 : 0;
  }
  const apply = args.includes('--apply');

  if (sub === 'retry') {
    if (!existsSync(QUEUE_DB_PATH)) {
      console.log(`no queue at ${QUEUE_DB_PATH} — nothing to do`);
      return 0;
    }
    const li = args.indexOf('--limit');
    const parsed = li >= 0 ? Number(args[li + 1]) : NaN;
    // Each released row is a real model call, so an unbounded release on a large pile is a bill.
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1000;
    const q = new ObservationQueue(QUEUE_DB_PATH);
    try {
      const before = q.failedCount();
      const r = q.retryFailed({ limit, dryRun: !apply });
      console.log(`  dead-lettered       : ${before.toLocaleString()}`);
      console.log(`  ${apply ? 'RELEASED' : 'would release'}      : ${r.revived.toLocaleString()}${before > limit ? `  (capped at --limit ${limit})` : ''}`);
      if (apply) {
        console.log(`  pending now         : ${q.pendingCount().toLocaleString()}`);
        console.log(`  still dead-lettered : ${r.failedRemaining.toLocaleString()}`);
      } else if (r.revived > 0) {
        console.log('\n  Nothing was changed. Re-run with --apply to release them.');
      }
      return 0;
    } finally {
      q.close();
    }
  }

  if (!existsSync(QUEUE_DB_PATH)) {
    console.log(`no queue at ${QUEUE_DB_PATH} — nothing to do`);
    return 0;
  }
  // The worker holds this db open; SQLite WAL makes concurrent access safe, but a row it is CURRENTLY
  // summarising is 'processing' and dedupePending never touches those.
  const queue = new ObservationQueue(QUEUE_DB_PATH);
  try {
    const r = queue.dedupePending({ apply });
    const removable = r.duplicate_of_done + r.duplicate_pending;
    console.log(`  pending before      : ${r.pending_before.toLocaleString()}`);
    console.log(`  already summarised  : ${r.duplicate_of_done.toLocaleString()}  (turn is already 'done')`);
    console.log(`  duplicate of pending: ${r.duplicate_pending.toLocaleString()}  (keeping the earliest of each)`);
    console.log(`  ${apply ? 'REMOVED' : 'would remove'}       : ${removable.toLocaleString()}`);
    if (apply) {
      console.log(`  pending after       : ${queue.pendingCount().toLocaleString()}`);
    } else if (removable > 0) {
      console.log('\n  Nothing was changed. Re-run with --apply to remove them.');
    }
    return 0;
  } finally {
    queue.close();
  }
}
