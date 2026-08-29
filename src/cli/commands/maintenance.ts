import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, realpathSync, rmSync, statSync } from 'fs';
import { join, sep } from 'path';
import { DATA_DIR, QUEUE_DB_PATH, META_DB_PATH, VECTOR_DB_DIR } from '../../shared/paths.ts';
import { findOrphanVectors, deleteOrphanVectors, reclaimDb, openVectorDbForMaintenance } from '../../worker/maintenance.ts';
import { ObservationQueue } from '../../worker/observation-queue.ts';
import {
  CACHE_ROOT, DEFAULT_GRACE_DAYS, planPrune, reclaimableBytes,
  readCacheTrees, readInstalledPaths, readLivePluginRoots,
} from '../../shared/plugin-cache.ts';

const MB = 1024 * 1024;
const size = (p: string): number => (existsSync(p) ? statSync(p).size : 0);
const fmt = (b: number): string => `${(b / MB).toFixed(1)} MB`;

/** `captain-memo maintenance [--apply] [--retention-days N] [--grace-days N]`
 *
 *  Reports what the databases are carrying that nothing needs, and with --apply removes it. Dry-run by
 *  default: this deletes rows, and a tool that deletes should show its work before it does.
 *
 *  The database sweeps also run automatically in the worker on an hourly sweep — this command exists so
 *  they can be run on demand, and so the numbers are inspectable without reading a log. The plugin-cache
 *  prune below is deliberately NOT on that sweep: it deletes directories, so it stays a thing a human
 *  asks for after reading the dry-run. */
export async function maintenanceCommand(args: string[]): Promise<number> {
  const apply = args.includes('--apply');
  const dIdx = args.indexOf('--retention-days');
  const retentionDays = dIdx >= 0 ? Number(args[dIdx + 1]) : 30;
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    console.error('--retention-days must be a non-negative number');
    return 2;
  }
  const gIdx = args.indexOf('--grace-days');
  const graceDays = gIdx >= 0 ? Number(args[gIdx + 1]) : DEFAULT_GRACE_DAYS;
  if (!Number.isFinite(graceDays) || graceDays < 0) {
    console.error('--grace-days must be a non-negative number');
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

  // ── 3. superseded plugin-cache trees left behind by upgrades ───────────────────────────────────
  pruneCaptainMemoCacheTrees(apply, graceDays);

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

/** Delete one cache tree, or say why it was refused. Three gates the planner cannot enforce because
 *  they are properties of the path AT DELETE TIME, not of the plan: a symlinked version dir must not
 *  let `rm -r` walk out of the cache and eat the checkout it points at; a non-directory is not ours to
 *  remove; and the resolved path must still sit strictly UNDER the cache root. */
export function removeCacheTree(path: string, realCacheRoot: string): string | null {
  let st;
  try { st = lstatSync(path); } catch { return 'vanished before the delete'; }
  if (st.isSymbolicLink()) return 'is a symlink — refusing (it would delete the target, not the tree)';
  if (!st.isDirectory()) return 'is not a directory';
  let real: string;
  try { real = realpathSync(path); } catch { return 'path could not be resolved'; }
  if (!real.startsWith(realCacheRoot + sep)) return `resolves outside the cache root (${real})`;
  try { rmSync(real, { recursive: true, force: true }); } catch (err) { return (err as Error).message; }
  return null;
}

/** Reclaim captain-memo's own superseded cache trees — the ones Claude Code marked `.orphaned_at` on
 *  upgrade and then never collected (see src/shared/plugin-cache.ts for the evidence).
 *
 *  Scoped to captain-memo. The same marker sits on other plugins' trees and on this host they are the
 *  bigger pile, but another vendor's cache is not ours to delete — the host-wide total is REPORTED at
 *  the end so the operator can see it and decide, and that is all. */
function pruneCaptainMemoCacheTrees(apply: boolean, graceDays: number): void {
  const label = 'plugin cache';
  if (!existsSync(CACHE_ROOT)) { console.log(`  ${label}: no ${CACHE_ROOT} on this host — nothing to prune`); return; }

  const installedPaths = readInstalledPaths();
  if (installedPaths === null) {
    // Fail closed. Without the inventory we cannot tell the ACTIVE tree from a superseded one, and
    // "found no active install" must never be read as "everything here is stale".
    console.log(`  ${label}: installed_plugins.json is missing or unreadable — pruning nothing (cannot tell which tree is active)`);
    return;
  }

  const all = readCacheTrees();
  const ours = all.filter(t => t.manifestName === 'captain-memo');
  // ONE /proc scan, shared with the other-plugins report below — which must apply the same vetoes, or
  // it would count a live-pinned tree as reclaimable and quote a number this tool would never act on.
  const livePins = readLivePluginRoots();
  const graceMs = graceDays * 86_400_000;
  const plan = planPrune({ trees: ours, installedPaths, livePins, nowMs: Date.now(), graceMs });

  // Per-tree: what removing THAT tree alone would free (hardlink-aware — see reclaimableBytes).
  const sized = plan.map(e => ({ ...e, bytes: reclaimableBytes([e.tree.path]) }));
  const doomed = sized.filter(e => e.prune);
  console.log(`  ${label}: ${sized.length} captain-memo tree(s) under ${CACHE_ROOT}`);
  for (const e of sized) {
    console.log(`    ${e.tree.version.padEnd(14)} ${fmt(e.bytes).padStart(9)}  ${e.prune ? 'DELETE' : 'keep  '}  ${e.reason}`);
  }

  // The JOINT figure, not the sum of the per-tree ones: two doomed trees that hardlink to each other
  // free those shared bytes only when BOTH go, so summing per-tree numbers would undercount here.
  const freed = reclaimableBytes(doomed.map(e => e.tree.path));
  if (doomed.length === 0) {
    console.log(`  ${label}: nothing to reclaim`);
  } else if (!apply) {
    console.log(`  ${label}: would remove ${doomed.length} tree(s), ${fmt(freed)}`);
  } else {
    const realCacheRoot = realpathSync(CACHE_ROOT);
    let removed = 0;
    for (const e of doomed) {
      const err = removeCacheTree(e.tree.path, realCacheRoot);
      if (err) console.log(`    ! ${e.tree.version}: ${err}`);
      else removed++;
    }
    // `freed` was computed over ALL doomed trees. If any refused, the bytes cannot be re-measured (the
    // survivors' hardlink counts have changed and the removed files are gone), so say the estimate no
    // longer holds rather than printing a figure that did not happen.
    console.log(`  ${label}: removed ${removed} of ${doomed.length} tree(s)`
      + (removed === doomed.length ? `, ${fmt(freed)} reclaimed`
                                   : ` — less than the ${fmt(freed)} estimate, which assumed all of them`));
  }

  reportOtherPluginsOrphaned(all.filter(t => t.manifestName !== null && t.manifestName !== 'captain-memo'),
    { installedPaths, livePins, graceMs, graceDays });
}

/** One line naming what the SAME condition costs across every other plugin on this host. Report only —
 *  captain-memo never deletes another plugin's cache.
 *
 *  Runs the REAL planner rather than re-deriving "orphaned past grace": a second copy of the predicate
 *  drifts from the first, and this one had already lost the live-pin veto — so it would have quoted an
 *  operator disk that this tool would refuse to reclaim. */
function reportOtherPluginsOrphaned(
  others: ReturnType<typeof readCacheTrees>,
  opts: { installedPaths: ReadonlySet<string>; livePins: ReadonlySet<string> | null; graceMs: number; graceDays: number },
): void {
  const stale = planPrune({ trees: others, nowMs: Date.now(), ...opts })
    .filter(e => e.prune).map(e => e.tree);
  if (stale.length === 0) return;
  const bytes = reclaimableBytes(stale.map(t => t.path));
  const names = [...new Set(stale.map(t => t.plugin))].sort().join(', ');
  console.log(`  plugin cache: ${stale.length} tree(s) of OTHER plugins (${names}) are also orphaned past `
    + `${opts.graceDays}d — ${fmt(bytes)}, not touched (captain-memo prunes only its own)`);
}
