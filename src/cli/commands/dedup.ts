// src/cli/commands/dedup.ts
//
// `captain-memo dedup` — fold near-duplicate observations into a single
// canonical row. The summarizer routinely emits several phrasings of one fact;
// this physically cleans the corpus so the dupes stop bloating stats + search.
//
// Safety model:
//   - Dry-run by DEFAULT. Nothing mutates without --apply.
//   - --apply backs up observations.db first, then ARCHIVES members into the
//     survivor (reversible: --undo, or flip archived=0). No hard deletes.
//   - --undo reverses every prior dedup merge.
//
// Operates on the DB file directly (separate SQLite connection). The worker
// re-queries on each request, so changes are picked up live.

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, copyFileSync } from 'fs';
import { ObservationsStore } from '../../worker/observations-store.ts';
import { DEFAULT_SIMILARITY_THRESHOLD } from '../../shared/title-similarity.ts';
import { cyan, cyanBold, dim, gold, green, bold } from '../../shared/ansi.ts';

const HELP = `captain-memo dedup — fold near-duplicate observations together

Usage:
  captain-memo dedup [--apply] [--threshold N] [--undo] [--json]

Options:
  (default)         Dry-run: show the merge groups, change nothing.
  --apply           Perform the merge. Backs up observations.db first.
  --undo            Reverse every prior dedup merge (un-archive members).
  --threshold N     Title-similarity threshold 0..1 (default ${DEFAULT_SIMILARITY_THRESHOLD}).
                    Lower = more aggressive merging. Review the dry-run first.
  --json            Machine-readable output.
  -h, --help        Show this help.

Notes:
  - Considers SURFACED observations (those that have been retrieved at least
    once) — the dupes that actually bloat stats and search.
  - Merges are reversible: members are archived (not deleted) into the survivor,
    and their counts are summed onto it. \`--undo\` restores them.
`;

function dataDir(): string {
  return process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo');
}

export async function dedupCommand(args: string[]): Promise<number> {
  let apply = false;
  let undo = false;
  let json = false;
  let threshold = DEFAULT_SIMILARITY_THRESHOLD;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--apply':     apply = true; break;
      case '--undo':      undo = true; break;
      case '--json':      json = true; break;
      case '--threshold': threshold = parseFloat(args[++i] ?? ''); break;
      case '-h': case '--help':
        console.log(HELP);
        return 0;
      default:
        console.error(`Unknown flag: ${a}`);
        console.error(HELP);
        return 2;
    }
  }

  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    console.error(`--threshold must be in (0, 1); got ${threshold}`);
    return 2;
  }

  const obsPath = join(dataDir(), 'observations.db');
  if (!existsSync(obsPath)) {
    console.error(`captain-memo dedup: observations.db not found at ${obsPath}`);
    return 1;
  }
  const store = new ObservationsStore(obsPath);
  try {
    if (undo) return runUndo(store, json);
    return runDedup(store, obsPath, threshold, apply, json);
  } finally {
    store.close();
  }
}

function runUndo(store: ObservationsStore, json: boolean): number {
  const survivors = store.mergedSurvivorIds();
  for (const id of survivors) store.unmergeDuplicateGroup(id);
  if (json) {
    console.log(JSON.stringify({ undone: survivors.length, survivor_ids: survivors }));
  } else if (survivors.length === 0) {
    console.log(dim('No prior merges to undo.'));
  } else {
    console.log(`${green('✓')} Reversed ${cyanBold(String(survivors.length))} merge(s); members un-archived.`);
  }
  return 0;
}

function runDedup(
  store: ObservationsStore, obsPath: string, threshold: number, apply: boolean, json: boolean,
): number {
  const groups = store.findDuplicateGroups(threshold);
  const archivable = groups.reduce((n, g) => n + g.members.length, 0);

  if (json) {
    const payload = {
      mode: apply ? 'apply' : 'dry-run',
      threshold,
      groups: groups.map(g => ({
        survivor: { id: g.survivor.id, title: g.survivor.title, total: g.survivor.total },
        member_ids: g.members.map(m => m.id),
      })),
      groups_count: groups.length,
      observations_archivable: archivable,
    };
    if (apply && groups.length > 0) {
      backup(obsPath);
      for (const g of groups) store.mergeDuplicateGroup(g.survivor.id, g.members.map(m => m.id));
    }
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  // Human-readable.
  console.log(`${cyanBold('captain-memo dedup')} ${dim(`· threshold ${threshold} · ${apply ? 'APPLY' : 'dry-run'}`)}`);
  console.log('');
  if (groups.length === 0) {
    console.log(dim('No near-duplicate groups found among surfaced observations. Nothing to do.'));
    return 0;
  }

  for (const g of groups) {
    console.log(`  ${green('✔ keep')}  ${cyanBold(`${g.survivor.total}×`.padStart(5))} ${dim(`[${g.survivor.type}]`)} ${bold(trim(g.survivor.title, 70))}`);
    for (const m of g.members) {
      console.log(`  ${dim('→ fold')}  ${dim(`${m.total}×`.padStart(5))} ${dim(`[${m.type}]`)} ${dim(trim(m.title, 70))}`);
    }
    console.log('');
  }

  const corpusNote = `${cyan(String(groups.length))} group(s) · ${cyan(String(archivable))} observation(s) would be archived`;
  if (!apply) {
    console.log(`${gold('▸')} ${corpusNote}.`);
    console.log(dim('  Re-run with --apply to perform the merge (observations.db is backed up first).'));
    return 0;
  }

  const backupPath = backup(obsPath);
  for (const g of groups) store.mergeDuplicateGroup(g.survivor.id, g.members.map(m => m.id));
  console.log(`${green('✓')} Merged ${corpusNote}.`);
  console.log(dim(`  Backup: ${backupPath}`));
  console.log(dim('  Reverse anytime with: captain-memo dedup --undo'));
  return 0;
}

function trim(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Copy observations.db next to itself with an epoch suffix before mutating. */
function backup(obsPath: string): string {
  const stamp = Math.floor(Date.now() / 1000);
  const dest = `${obsPath}.bak-${stamp}`;
  copyFileSync(obsPath, dest);
  return dest;
}
