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
//   - --undo reverses every prior dedup merge. With a selector (--member, --run, --since,
//     --job) it reverses only the merges that selector names; --runs lists the runs to pick from.
//   - PROTECTED rows (drilled into, or anchored) are never folded — the same
//     gate runQmDedupSlice applies. This was missing, so the manual command was
//     more destructive than the automatic sweep it exists to supplement.
//
// Why this command still exists alongside the background sweep: the sweep is
// bounded to the most-recently-surfaced CAPTAIN_MEMO_QM_DEDUP_WINDOW rows, and
// folding only slides that window by as much as it folds. Measured on a 14,409-row
// surfaced corpus it reaches a fixed point after ~3 sweeps having folded 212 of 846
// foldable rows, then goes quiet — the rest sit below the recency cut permanently.
// This command is the unbounded pass that clears them. It trades the sweep's cosine
// confirm for reach, which is why it is dry-run by default and asks you to look.
//
// Operates on the DB file directly (separate SQLite connection). The worker
// re-queries on each request, so changes are picked up live.

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, copyFileSync } from 'fs';
import { ObservationsStore, type MergeSelector } from '../../worker/observations-store.ts';
import { DEFAULT_SIMILARITY_THRESHOLD } from '../../shared/title-similarity.ts';
import { cyan, cyanBold, dim, gold, green, bold } from '../../shared/ansi.ts';

const HELP = `captain-memo dedup — fold near-duplicate observations together

Usage:
  captain-memo dedup [--apply] [--threshold N] [--json]
  captain-memo dedup --undo [<selector>...] [--json]
  captain-memo dedup --runs [--json]

Options:
  (default)         Dry-run: show the merge groups, change nothing.
  --apply           Perform the merge. Backs up observations.db first.
  --undo            Reverse every prior merge (un-archive members) — dedup AND semantic folds.
                    With a selector below, reverse only the merges it names.
  --member ID...    Undo the merges of these observation ids (space or comma separated).
  --run N           Undo the merges one run made (N from --runs).
  --since WHEN      Undo merges made at or after WHEN: epoch seconds, or an ISO date-time
                    (2026-10-14T09:30:00Z; with no offset it is your local time, a bare date is UTC).
  --job NAME        Restrict to 'dedup' or 'semantic' folds. Alone, undoes every fold of that job.
  --runs            List the 10 most recent runs that folded something (read-only).
  --threshold N     Title-similarity threshold 0..1 (default ${DEFAULT_SIMILARITY_THRESHOLD}).
                    Lower = more aggressive merging. Review the dry-run first.
  --json            Machine-readable output.
  -h, --help        Show this help.

Notes:
  - Considers SURFACED observations (those that have been retrieved at least
    once) — the dupes that actually bloat stats and search.
  - Never folds a PROTECTED row: anything you drilled into, or anchored. Same
    rule the hourly background sweep applies.
  - Gate differs from the background sweep: this pass decides on TITLE
    SIMILARITY alone, where the sweep additionally requires an embedding
    cosine >= 0.95. So it folds more, and more loosely. That is the point —
    it exists to clear a backlog the windowed sweep cannot reach — but review
    the dry-run rather than trusting it the way you would trust the sweep.
  - Merges are reversible: members are archived (not deleted) into the survivor,
    and their counts are summed onto it. \`--undo\` restores them.
  - A selector implies --undo and may be combined with the others (all must match). It
    PRINTS what it will undo, then does it, like plain --undo: there is no confirmation prompt.
    An id or run that matches nothing exits 1 and changes nothing; repeating an undo is a no-op.
  - A survivor's last-surfaced time goes back to its pre-fold value only when ONE command undoes
    every open fold into it. A partial undo leaves it as it is, so if the survivor's earliest folds
    were undone first, a later full undo restores the time the next fold recorded: slightly newer.
  - A run is matched to its merges by the time it ran and its job. A merge from a worker that
    stopped before recording its run belongs to no run: reach it with --member or --since.
`;

function dataDir(): string {
  return process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo');
}

export async function dedupCommand(args: string[]): Promise<number> {
  let apply = false;
  let undo = false;
  let json = false;
  let threshold = DEFAULT_SIMILARITY_THRESHOLD;
  let listRuns = false;
  const sel: MergeSelector = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--apply':     apply = true; break;
      case '--undo':      undo = true; break;
      case '--json':      json = true; break;
      case '--threshold': threshold = parseFloat(args[++i] ?? ''); break;
      case '--runs':      listRuns = true; break;
      case '--member': {
        const ids: number[] = [];
        while (/^\d+(,\d+)*$/.test(args[i + 1] ?? '')) ids.push(...args[++i]!.split(',').map(Number));
        if (ids.length === 0) { console.error('--member expects one or more observation ids'); return 2; }
        sel.memberIds = [...(sel.memberIds ?? []), ...ids];
        break;
      }
      case '--run': {
        const raw = args[++i] ?? '';
        if (!/^\d+$/.test(raw)) { console.error(`--run expects a run id (see --runs); got "${raw}"`); return 2; }
        sel.runId = Number(raw);
        break;
      }
      case '--since': {
        const raw = args[++i] ?? '';
        const at = parseSince(raw);
        if (at === null) {
          console.error(`--since expects epoch seconds or an ISO date-time like 2026-10-14T09:30:00Z; got "${raw}"`);
          return 2;
        }
        sel.since = at;
        break;
      }
      case '--job': {
        const raw = args[++i] ?? '';
        if (raw !== 'dedup' && raw !== 'semantic') { console.error(`--job expects dedup or semantic; got "${raw}"`); return 2; }
        sel.job = raw;
        break;
      }
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
  const selective = Object.keys(sel).length > 0;
  if (listRuns && (selective || undo || apply)) {
    console.error('--runs only lists; use it on its own');
    return 2;
  }
  if (selective && apply) {
    console.error('An undo selector (--member, --run, --since, --job) cannot be combined with --apply');
    return 2;
  }

  const obsPath = join(dataDir(), 'observations.db');
  if (!existsSync(obsPath)) {
    console.error(`captain-memo dedup: observations.db not found at ${obsPath}`);
    return 1;
  }
  const store = new ObservationsStore(obsPath);
  try {
    if (listRuns) return listFoldRuns(store, json);
    if (selective) return runSelectiveUndo(store, json, sel);
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

/** Epoch seconds as typed, or an ISO date-time (Date.parse). Null when it is neither, or when a
 *  bare number is too large to be seconds — milliseconds would otherwise match nothing, silently. */
function parseSince(raw: string): number | null {
  if (/^\d+$/.test(raw)) { const n = Number(raw); return n <= 1e11 ? n : null; }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function describeSelector(sel: MergeSelector): string {
  return [
    sel.memberIds && `member ${sel.memberIds.join(', ')}`,
    sel.runId !== undefined && `run ${sel.runId}`,
    sel.since !== undefined && `since ${new Date(sel.since * 1000).toISOString()}`,
    sel.job && `job ${sel.job}`,
  ].filter(Boolean).join(' · ');
}

const PREVIEW_ROWS = 10;

/** Undo only what `sel` names, through the same per-survivor reversal `--undo` uses. */
function runSelectiveUndo(store: ObservationsStore, json: boolean, sel: MergeSelector): number {
  const fail = (msg: string): number => {
    console.error(`captain-memo dedup: ${msg} Nothing was changed.`);
    return 1;
  };
  if (sel.runId !== undefined) {
    const run = store.qmRunById(sel.runId);
    if (!run) return fail(`run ${sel.runId} not found (\`captain-memo dedup --runs\` lists the runs that folded something).`);
    if (run.job !== 'dedup' && run.job !== 'semantic') {
      return fail(`run ${run.id} is a ${run.job} run; only dedup and semantic runs fold observations.`);
    }
    if (run.finishedAt === null) {
      return fail(`run ${run.id} has no finish time, so its merges cannot be told from its neighbours'; use --since.`);
    }
  }
  const rows = store.selectMergeEvents(sel);
  // All-or-nothing on a typo: one unknown id must not quietly undo the rest of a list.
  const known = new Set(rows.map(r => r.member_id));
  const unknown = (sel.memberIds ?? []).filter(id => !known.has(id));
  if (unknown.length > 0) return fail(`no merge matches observation id(s) ${unknown.join(', ')} (never folded, or outside the other selectors).`);
  if (rows.length === 0) return fail(`no merge matches ${describeSelector(sel)}.`);

  const open = rows.filter(r => r.undone === 0);
  const already = rows.length - open.length;
  if (open.length === 0) {
    if (json) console.log(JSON.stringify({ undone: 0, survivor_ids: [], member_ids: [], merges: 0, already_undone: already }));
    else console.log(dim(`Nothing to undo: all ${rows.length} matching merge(s) are already undone.`));
    return 0;
  }

  const bySurvivor = new Map<number, number[]>();
  for (const r of open) bySurvivor.set(r.survivor_id, [...(bySurvivor.get(r.survivor_id) ?? []), r.id]);

  if (!json) {
    console.log(`${cyanBold('captain-memo dedup --undo')} ${dim(`· ${describeSelector(sel)}`)}`);
    console.log(`${gold('▸')} Undoing ${cyan(String(open.length))} merge(s) into ${bySurvivor.size} survivor(s)`
      + (already > 0 ? dim(` (${already} already undone, skipped)`) : '') + ':');
    for (const r of open.slice(0, PREVIEW_ROWS)) {
      console.log(`  ${dim('↶')} #${r.member_id} ${dim(`[${r.job}]`)} ${trim(r.member_title ?? '(row gone)', 70)} ${dim(`← folded into #${r.survivor_id}`)}`);
    }
    if (open.length > PREVIEW_ROWS) console.log(dim(`  … and ${open.length - PREVIEW_ROWS} more`));
  }

  let unarchived = 0;
  for (const [survivorId, eventIds] of bySurvivor) unarchived += store.unmergeDuplicateGroup(survivorId, eventIds);

  if (json) {
    console.log(JSON.stringify({
      undone: bySurvivor.size, survivor_ids: [...bySurvivor.keys()], member_ids: open.map(r => r.member_id),
      merges: open.length, members_unarchived: unarchived, already_undone: already,
    }));
    return 0;
  }
  console.log(`${green('✓')} Reversed ${cyanBold(String(open.length))} merge(s) into ${bySurvivor.size} survivor(s); `
    + `${cyanBold(String(unarchived))} member(s) un-archived.`);
  if (unarchived < open.length) {
    console.log(dim(`  ${open.length - unarchived} member(s) were no longer folded into that survivor and were left as they are.`));
  }
  return 0;
}

/** `--runs`: the dedup/semantic runs that folded something, newest first, and how much of each is still folded. */
function listFoldRuns(store: ObservationsStore, json: boolean): number {
  const runs = store.foldRuns(10).map(run => ({
    run,
    stillFolded: store.selectMergeEvents({ runId: run.id }).filter(e => e.undone === 0).length,
  }));
  if (json) {
    console.log(JSON.stringify(runs.map(({ run, stillFolded }) => ({
      id: run.id, job: run.job, started_at: run.startedAt, finished_at: run.finishedAt,
      folded: run.merges, still_folded: stillFolded,
    }))));
    return 0;
  }
  if (runs.length === 0) {
    console.log(dim('No dedup or semantic run has folded anything yet.'));
    return 0;
  }
  console.log(`${cyanBold('captain-memo dedup --runs')} ${dim('· most recent runs that folded something')}`);
  for (const { run, stillFolded } of runs) {
    const when = new Date(run.startedAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`  ${cyan(`#${run.id}`.padEnd(7))} ${run.job.padEnd(9)} ${dim(`${when} UTC`)}  `
      + `${cyanBold(String(run.merges))} folded ${dim(`· ${stillFolded} still folded`)}`);
  }
  console.log(dim('  Undo one run: captain-memo dedup --undo --run <id>'));
  return 0;
}

function runDedup(
  store: ObservationsStore, obsPath: string, threshold: number, apply: boolean, json: boolean,
): number {
  // A drilled-into or anchored row is protected from automatic folding — runQmDedupSlice skips it
  // outright ("a protected memory is never archived automatically"). This command bypassed that
  // gate entirely, which made the MANUAL tool more destructive than the background sweep. Filtered
  // here rather than at apply-time so the dry-run never promises a fold that will not happen.
  const groups = store.findDuplicateGroups(threshold)
    .map(g => ({ ...g, members: g.members.filter(m => !store.isProtected(m.id)) }))
    .filter(g => g.members.length > 0);
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
      const atEpoch = Math.floor(Date.now() / 1000);
      for (const g of groups) store.mergeDuplicateGroup(g.survivor.id, g.members.map(m => m.id), atEpoch);
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

  // Tense follows the mode: --apply has already done it by the time this prints.
  const corpusNote = (tense: 'would be' | 'were') =>
    `${cyan(String(groups.length))} group(s) · ${cyan(String(archivable))} observation(s) ${tense} archived`;
  if (!apply) {
    console.log(`${gold('▸')} ${corpusNote('would be')}.`);
    console.log(dim('  Matched on title similarity alone (no embedding check, unlike the background sweep): read each group before applying.'));
    console.log(dim('  Re-run with --apply to perform the merge (observations.db is backed up first).'));
    return 0;
  }

  const backupPath = backup(obsPath);
  const atEpoch = Math.floor(Date.now() / 1000);
  for (const g of groups) store.mergeDuplicateGroup(g.survivor.id, g.members.map(m => m.id), atEpoch);
  console.log(`${green('✓')} Merged ${corpusNote('were')}.`);
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
