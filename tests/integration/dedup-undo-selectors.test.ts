// tests/integration/dedup-undo-selectors.test.ts
//
// `captain-memo dedup --undo` used to be all-or-nothing. A tester's `consolidate --semantic
// --backlog` made 1,340 folds, 3 of them wrong, and the only undo would have thrown away the other
// 1,337. These tests pin the selectors (--member / --run / --since / --job), the PARTIAL reversal
// they ride on, and that plain `--undo` still behaves exactly as before.
//
// Synthetic rows only. Drives the real command against a temp observations.db via
// CAPTAIN_MEMO_DATA_DIR, with ledger rows written by the real mergeDuplicateGroup at chosen epochs
// and qm_runs rows written by the real recordQmRun.
//
//   run 1  semantic  1000..1030  S1<-[M1,M2]  S2<-[M3]
//   run 2  dedup     2000..2030  S1<-[M4]
//   run 3  semantic  3000..3030  S2<-[M5,M6]
//   run 4  semantic  3030..3060  S1<-[M7]      (starts the second run 3 finishes: a shared boundary)

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { ObservationsStore } from '../../src/worker/observations-store.ts';
import { dedupCommand } from '../../src/cli/commands/dedup.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

let workDir: string;
let dbPath: string;
let prevEnv: string | undefined;
let S1 = 0, S2 = 0;
let M: number[] = [];            // index 1..7; index 0 unused, so m(n) reads as "member n"
const m = (n: number): number => M[n]!;

// Baselines the fixture seeds BEFORE any merge.
const S1_AUTO = 10, S1_SURFACED = 500, S2_AUTO = 20, S2_SURFACED = 600;

function seed(store: ObservationsStore, title: string, auto: number, surfacedAt: number): number {
  const id = store.insert({
    session_id: 's', project_id: 'p', prompt_number: 1,
    type: 'discovery', title, narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100, branch: null, origin_agent: null, work_tokens: null,
  });
  for (let i = 0; i < auto; i++) store.bumpRetrieval([id], 'auto', surfacedAt);
  return id;
}

function recordRun(store: ObservationsStore, job: string, startedAt: number, finishedAt: number | null, merges: number): void {
  store.recordQmRun({ job, startedAt, finishedAt, rowsScanned: 9, merges, skippedNoVector: 0, abortedForIngest: false, errored: false });
}

async function cli(args: string[]): Promise<{ out: string; err: string; code: number }> {
  const origLog = console.log, origErr = console.error;
  const out: string[] = [], err: string[] = [];
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  let code = 0;
  try { code = await dedupCommand(args); } finally { console.log = origLog; console.error = origErr; }
  return { out: out.join('\n'), err: err.join('\n'), code };
}

/** Snapshot of the DB state the assertions care about, read eagerly through a fresh connection. */
function peek() {
  const store = new ObservationsStore(dbPath);
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = new Map([S1, S2, ...M.slice(1)].map(id => [id, store.findById(id)!] as const));
    const openMembers = (db.query('SELECT member_id FROM merge_events WHERE undone = 0 ORDER BY member_id').all() as Array<{ member_id: number }>)
      .map(r => r.member_id);
    return {
      archived: (id: number) => rows.get(id)!.archived,
      auto: (id: number) => rows.get(id)!.from_auto,
      surfaced: (id: number) => rows.get(id)!.last_surfaced_at,
      listed: (id: number) => rows.get(id)!.theme_member_ids,
      openMembers,
    };
  } finally { store.close(); db.close(); }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-undo-sel-'));
  dbPath = join(workDir, 'observations.db');
  const store = new ObservationsStore(dbPath);
  S1 = seed(store, 'survivor one', S1_AUTO, S1_SURFACED);
  S2 = seed(store, 'survivor two', S2_AUTO, S2_SURFACED);
  M = [0];
  for (let n = 1; n <= 7; n++) M.push(seed(store, `member ${n} restated`, n, 900 + n * 10));

  store.mergeDuplicateGroup(S1, [m(1), m(2)], 1000, 'semantic');
  store.mergeDuplicateGroup(S2, [m(3)], 1000, 'semantic');
  recordRun(store, 'semantic', 1000, 1030, 3);
  store.mergeDuplicateGroup(S1, [m(4)], 2000, 'dedup');
  recordRun(store, 'dedup', 2000, 2030, 1);
  store.mergeDuplicateGroup(S2, [m(5), m(6)], 3000, 'semantic');
  recordRun(store, 'semantic', 3000, 3030, 2);
  store.mergeDuplicateGroup(S1, [m(7)], 3030, 'semantic');
  recordRun(store, 'semantic', 3030, 3060, 1);
  store.close();

  prevEnv = process.env.CAPTAIN_MEMO_DATA_DIR;
  process.env.CAPTAIN_MEMO_DATA_DIR = workDir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.CAPTAIN_MEMO_DATA_DIR;
  else process.env.CAPTAIN_MEMO_DATA_DIR = prevEnv;
  rmWorkDir(workDir);
});

test('fixture sanity — all seven members folded, counters summed', () => {
  const p = peek();
  expect(p.openMembers).toEqual([m(1), m(2), m(3), m(4), m(5), m(6), m(7)]);
  expect(p.archived(m(1))).toBe(true);
  expect(p.auto(S1)).toBe(S1_AUTO + 1 + 2 + 4 + 7);
  expect(p.auto(S2)).toBe(S2_AUTO + 3 + 5 + 6);
});

test('--undo --run restores ONLY that run — the other runs\' folds stay', async () => {
  const { out, code } = await cli(['--undo', '--run', '1']);
  expect(code).toBe(0);
  // Printed first: what it will undo, with ids and titles.
  expect(out).toContain('Undoing 3 merge(s) into 2 survivor(s)');
  expect(out).toContain(`#${m(1)}`);
  expect(out).toContain('member 3 restated');

  const p = peek();
  for (const n of [1, 2, 3]) expect(p.archived(m(n))).toBe(false);
  for (const n of [4, 5, 6, 7]) expect(p.archived(m(n))).toBe(true);
  expect(p.openMembers).toEqual([m(4), m(5), m(6), m(7)]);
  // Counters: exactly run 1's members' share comes off.
  expect(p.auto(S1)).toBe(S1_AUTO + 4 + 7);
  expect(p.auto(S2)).toBe(S2_AUTO + 5 + 6);
});

test('a PARTIAL undo keeps the survivor\'s recency and lists only the members still folded', async () => {
  await cli(['--undo', '--run', '1']);
  const p = peek();
  // S1 still has runs 2 and 4 folded into it: its last_surfaced_at (advanced by M7 to 970) is NOT
  // rolled back to the pre-run-1 value, because the ledger cannot say what M4 and M7 justify.
  expect(p.surfaced(S1)).toBe(970);
  expect(p.listed(S1)).toEqual([m(4), m(7)]);
  expect(p.listed(S2)).toEqual([m(5), m(6)]);
});

test('undoing EVERY fold into a survivor restores its pre-merge recency and clears the list', async () => {
  const { code } = await cli(['--undo', '--member', String(m(1)), String(m(2)), String(m(4)), String(m(7))]);
  expect(code).toBe(0);
  const p = peek();
  expect(p.surfaced(S1)).toBe(S1_SURFACED);
  expect(p.listed(S1)).toBeNull();
  expect(p.auto(S1)).toBe(S1_AUTO);
  // S2 was not named, so it is untouched.
  expect(p.auto(S2)).toBe(S2_AUTO + 3 + 5 + 6);
  expect(p.archived(m(3))).toBe(true);
});

test('runs sharing a boundary second: the later run owns it', async () => {
  // Run 3 finished at 3030 and run 4 started at 3030, whose merge is stamped 3030: inside BOTH windows.
  await cli(['--undo', '--run', '3']);
  let p = peek();
  expect(p.archived(m(5))).toBe(false);
  expect(p.archived(m(6))).toBe(false);
  // Everything that is not run 3's stays folded: run 1 and run 2 (outside its window), run 4 (the shared second).
  expect(p.openMembers).toEqual([m(1), m(2), m(3), m(4), m(7)]);

  await cli(['--undo', '--run', '4']);
  p = peek();
  expect(p.openMembers).toEqual([m(1), m(2), m(3), m(4)]);
});

test('--run needs the run to exist, to be a fold job, and to have a finish time', async () => {
  const store = new ObservationsStore(dbPath);
  recordRun(store, 'supersede', 4000, 4010, 5);
  store.close();
  const raw = new Database(dbPath);
  raw.exec(`INSERT INTO qm_runs (job, started_at_epoch, finished_at_epoch) VALUES ('semantic', 5000, NULL)`);
  raw.close();

  for (const [id, why] of [['99', 'not found'], ['5', 'supersede run'], ['6', 'no finish time']] as const) {
    const { err, code } = await cli(['--undo', '--run', id]);
    expect(code).toBe(1);
    expect(err).toContain(why);
    expect(err).toContain('Nothing was changed');
  }
  expect(peek().openMembers.length).toBe(7);
});

test('--run on a run that made no folds is "matches nothing", not a silent success', async () => {
  const store = new ObservationsStore(dbPath);
  recordRun(store, 'dedup', 7000, 7010, 0);
  store.close();
  const { err, code } = await cli(['--run', '5']);     // a selector alone implies --undo
  expect(code).toBe(1);
  expect(err).toContain('no merge matches run 5');
  expect(peek().openMembers.length).toBe(7);
});

test('--member undoes exactly the named observations (space and comma forms, repeatable)', async () => {
  const { out, code } = await cli(['--member', String(m(2)), `${m(5)},${m(6)}`, '--member', String(m(3))]);
  expect(code).toBe(0);
  expect(out).toContain('Reversed 4 merge(s)');
  const p = peek();
  for (const n of [2, 3, 5, 6]) expect(p.archived(m(n))).toBe(false);
  for (const n of [1, 4, 7]) expect(p.archived(m(n))).toBe(true);
  expect(p.auto(S1)).toBe(S1_AUTO + 1 + 4 + 7);
});

test('--member with an id that was never folded: exit 1, and NOTHING is changed (not even the valid ids)', async () => {
  const { err, code } = await cli(['--undo', '--member', String(m(1)), '99999']);
  expect(code).toBe(1);
  expect(err).toContain('99999');
  expect(err).toContain('Nothing was changed');
  const p = peek();
  expect(p.openMembers.length).toBe(7);
  expect(p.archived(m(1))).toBe(true);
});

test('--since (epoch and ISO) undoes merges made at or after it; --job narrows it', async () => {
  // 1970-01-01T00:33:20Z is epoch 2000: runs 2, 3 and 4, not run 1.
  const iso = await cli(['--undo', '--since', '1970-01-01T00:33:20Z', '--job', 'semantic']);
  expect(iso.code).toBe(0);
  expect(iso.out).toContain('since 1970-01-01T00:33:20.000Z');
  let p = peek();
  expect(p.openMembers).toEqual([m(1), m(2), m(3), m(4)]);     // run 2 is job 'dedup': kept; run 1 is before it

  const epoch = await cli(['--since', '2000']);
  expect(epoch.code).toBe(0);
  p = peek();
  expect(p.openMembers).toEqual([m(1), m(2), m(3)]);           // now run 2's M4 went too
});

test('an unparseable or oversized --since, a bad --run/--job/--member, and --apply + selector are usage errors (exit 2)', async () => {
  for (const args of [
    ['--since', 'banana'], ['--since', '1790000000000'], ['--run', 'x'], ['--run'], ['--job', 'theme'],
    ['--member'], ['--member', 'abc'], ['--apply', '--member', '1'], ['--runs', '--undo'],
  ]) {
    const { code } = await cli(args);
    expect(code).toBe(2);
  }
  expect(peek().openMembers.length).toBe(7);
});

test('a second undo of the same selection is a no-op: exit 0, counters not subtracted twice', async () => {
  await cli(['--undo', '--member', String(m(1)), String(m(3))]);
  const before = peek();

  const again = await cli(['--undo', '--member', String(m(1)), String(m(3))]);
  expect(again.code).toBe(0);
  expect(again.out).toContain('already undone');
  const after = peek();
  expect(after.auto(S1)).toBe(before.auto(S1));
  expect(after.auto(S2)).toBe(before.auto(S2));
  expect(after.openMembers).toEqual(before.openMembers);

  // Same through --run: run 1 is now fully undone, and a repeat says so rather than failing.
  await cli(['--undo', '--member', String(m(2))]);
  const run = await cli(['--undo', '--run', '1', '--json']);
  expect(run.code).toBe(0);
  expect(JSON.parse(run.out)).toMatchObject({ undone: 0, merges: 0, already_undone: 3 });
});

test('a preview over ten merges shows the first ten and says how many more', async () => {
  const store = new ObservationsStore(dbPath);
  const many = Array.from({ length: 12 }, (_, i) => seed(store, `bulk member ${i}`, 1, 800));
  store.mergeDuplicateGroup(S2, many, 9000, 'dedup');
  store.close();

  const { out, code } = await cli(['--since', '9000']);
  expect(code).toBe(0);
  expect(out).toContain('Undoing 12 merge(s) into 1 survivor(s)');
  expect(out).toContain('… and 2 more');
  expect(out).toContain('bulk member 0');
  expect(out).not.toContain('bulk member 11');
  expect(peek().openMembers.length).toBe(7);                   // the 12 are gone, the rest stay
});

test('plain --undo (no selector) behaves exactly as before: every survivor, same JSON shape', async () => {
  const { out, code } = await cli(['--undo', '--json']);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ undone: 2, survivor_ids: [S1, S2] });
  const p = peek();
  expect(p.openMembers).toEqual([]);
  for (let n = 1; n <= 7; n++) expect(p.archived(m(n))).toBe(false);
  expect(p.auto(S1)).toBe(S1_AUTO);
  expect(p.auto(S2)).toBe(S2_AUTO);
  expect(p.surfaced(S1)).toBe(S1_SURFACED);
  expect(p.surfaced(S2)).toBe(S2_SURFACED);
  expect(p.listed(S1)).toBeNull();
  // And a second plain --undo finds nothing, as it always did.
  expect((await cli(['--undo'])).out).toContain('No prior merges to undo.');
});

test('plain --undo after a partial undo finishes the job and still restores the survivor\'s recency', async () => {
  await cli(['--undo', '--run', '2']);
  await cli(['--undo']);
  const p = peek();
  expect(p.openMembers).toEqual([]);
  expect(p.auto(S1)).toBe(S1_AUTO);
  expect(p.surfaced(S1)).toBe(S1_SURFACED);
});

test('--runs lists the runs that folded something, newest first, with what is still folded', async () => {
  await cli(['--undo', '--run', '1']);
  const store = new ObservationsStore(dbPath);
  recordRun(store, 'dedup', 8000, 8010, 0);                    // folded nothing: not listed
  recordRun(store, 'theme', 8100, 8110, 4);                    // not a fold job: not listed
  store.close();

  const j = await cli(['--runs', '--json']);
  expect(j.code).toBe(0);
  const runs = JSON.parse(j.out) as Array<{ id: number; job: string; folded: number; still_folded: number }>;
  expect(runs.map(r => r.id)).toEqual([4, 3, 2, 1]);
  expect(runs.map(r => r.still_folded)).toEqual([1, 2, 1, 0]);
  expect(runs[3]).toMatchObject({ job: 'semantic', folded: 3 });

  const h = await cli(['--runs']);
  expect(h.out).toContain('#1');
  expect(h.out).toContain('0 still folded');
  expect(h.out).toContain('dedup --undo --run <id>');
});
