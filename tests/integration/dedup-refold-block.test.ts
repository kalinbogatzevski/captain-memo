// tests/integration/dedup-refold-block.test.ts
//
// An UNDONE fold used to be forgotten: the next `consolidate --semantic --backlog` could fold the same
// member into the same survivor again (a tester's 3 wrong folds were the first real case).
// `dedup --undo` now writes a never-re-fold marker per undone (survivor, member) pair; the folding
// paths skip a marked pair; `dedup --allow-refold` takes the marker away again.
//
// Synthetic rows only. Drives the real command against a temp observations.db via CAPTAIN_MEMO_DATA_DIR.

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
let S = 0, M1 = 0, M2 = 0, N = 0;

function seed(store: ObservationsStore, title: string, auto: number): number {
  const id = store.insert({
    session_id: 's', project_id: 'p', prompt_number: 1,
    type: 'discovery', title, narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100, branch: null, origin_agent: null, work_tokens: null,
  });
  for (let i = 0; i < auto; i++) store.bumpRetrieval([id], 'auto');
  return id;
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

/** The marker rows, read through a fresh read-only connection. */
function markers(): Array<[number, number]> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query('SELECT survivor_id, member_id FROM refold_blocks ORDER BY member_id').all() as Array<{ survivor_id: number; member_id: number }>)
      .map(r => [r.survivor_id, r.member_id]);
  } finally { db.close(); }
}

function archived(id: number): boolean {
  const store = new ObservationsStore(dbPath);
  try { return store.findById(id)!.archived; } finally { store.close(); }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-refold-'));
  dbPath = join(workDir, 'observations.db');
  const store = new ObservationsStore(dbPath);
  S = seed(store, 'deploy script updates both servers', 5);      // survivor
  M1 = seed(store, 'deploy script updates both servers now', 3); // member
  M2 = seed(store, 'deploy script pushes to both servers', 2);   // member
  N = seed(store, 'completely unrelated topic xyz', 4);          // not a near-duplicate of anything
  store.mergeDuplicateGroup(S, [M1, M2], 1000, 'semantic');
  store.close();
  prevEnv = process.env.CAPTAIN_MEMO_DATA_DIR;
  process.env.CAPTAIN_MEMO_DATA_DIR = workDir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.CAPTAIN_MEMO_DATA_DIR;
  else process.env.CAPTAIN_MEMO_DATA_DIR = prevEnv;
  rmWorkDir(workDir);
});

test('--undo marks the pairs it undoes, in every form, and says so', async () => {
  const sel = await cli(['--undo', '--member', String(M1)]);
  expect(sel.code).toBe(0);
  expect(sel.out).toContain('will not be folded again');
  expect(markers()).toEqual([[S, M1]]);

  const all = await cli(['--undo']);
  expect(all.out).toContain('will not be folded again');
  expect(markers()).toEqual([[S, M1], [S, M2]]);
});

test('a marked pair is not proposed or folded by the dedup command; the escape hatch brings it back', async () => {
  await cli(['--undo', '--member', String(M1)]);                // M1 is live again, a near-duplicate of S
  const dry = JSON.parse((await cli(['--json'])).out) as { groups_count: number };
  expect(dry.groups_count).toBe(0);                             // M1 is the only candidate, and it is marked
  await cli(['--apply', '--json']);
  expect(archived(M1)).toBe(false);

  const hatch = await cli(['--allow-refold', '--member', String(M1)]);
  expect(hatch.code).toBe(0);
  expect(markers()).toEqual([]);
  expect((JSON.parse((await cli(['--json'])).out) as { groups_count: number }).groups_count).toBe(1);
  await cli(['--apply', '--json']);
  expect(archived(M1)).toBe(true);                              // folded again, as asked
});

test('the fold itself refuses a marked pair, in either order, and still folds the rest of the group', async () => {
  await cli(['--undo']);
  const store = new ObservationsStore(dbPath);
  try {
    expect(store.mergeDuplicateGroup(S, [M1, N], 2000)).toBe(1);   // M1 marked, N not
    expect(store.findById(M1)!.archived).toBe(false);
    expect(store.findById(N)!.archived).toBe(true);
    // The two rows could swap roles after an undo changed the counts: the marker holds both ways.
    expect(store.mergeDuplicateGroup(M2, [S], 2000)).toBe(0);
    expect(store.findById(S)!.archived).toBe(false);
  } finally { store.close(); }
});

test('--allow-refold: named ids, or all; an id with no marker changes nothing; it takes nothing else', async () => {
  await cli(['--undo']);
  expect(markers().length).toBe(2);

  const none = await cli(['--allow-refold', '--member', '99999']);
  expect(none.code).toBe(1);
  expect(markers().length).toBe(2);

  expect((await cli(['--allow-refold', '--member', String(M2)])).code).toBe(0);
  expect(markers()).toEqual([[S, M1]]);

  const j = await cli(['--allow-refold', '--json']);
  expect(JSON.parse(j.out)).toEqual({ cleared: 1 });
  expect(markers()).toEqual([]);

  for (const bad of [['--undo'], ['--apply'], ['--runs'], ['--run', '1'], ['--since', '5'], ['--job', 'dedup']]) {
    expect((await cli(['--allow-refold', ...bad])).code).toBe(2);
  }
});

// The tester's case: folds undone BEFORE this release have undone ledger rows and no marker table.
test('a database without the table migrates, and the backfill marks folds that were already undone, once', () => {
  const store = new ObservationsStore(dbPath);
  store.close();
  let db = new Database(dbPath);
  db.exec('UPDATE merge_events SET undone = 1 WHERE member_id = ' + M1);   // what an older release's --undo left
  db.exec('DROP TABLE IF EXISTS refold_blocks; DELETE FROM schema_versions WHERE version = 26;');
  db.close();

  new ObservationsStore(dbPath).close();                                    // opening the store migrates
  expect(markers()).toEqual([[S, M1]]);                                     // M2's fold is still open: no marker

  db = new Database(dbPath);
  db.exec('DELETE FROM schema_versions WHERE version = 26;');               // run the migration a second time
  db.close();
  new ObservationsStore(dbPath).close();
  expect(markers()).toEqual([[S, M1]]);

  db = new Database(dbPath, { readonly: true });
  expect((db.query('SELECT name FROM schema_versions WHERE version = 26').get() as { name: string }).name).toBe('add_refold_blocks');
  db.close();
});

// `--refold-blocks`: the read-only listing of the markers `--allow-refold` clears.
test('--refold-blocks says so when nothing is marked; --json is an empty list', async () => {
  const r = await cli(['--refold-blocks']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('No never-re-fold markers');
  expect(JSON.parse((await cli(['--refold-blocks', '--json'])).out)).toEqual([]);
});

test('--refold-blocks lists each marked pair with both titles and changes nothing; --member narrows it', async () => {
  await cli(['--undo']);
  const before = markers();
  expect(before).toEqual([[S, M1], [S, M2]]);

  const r = await cli(['--refold-blocks']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('2 undone pair(s)');
  for (const id of [S, M1, M2]) expect(r.out).toContain(`#${id}`);
  for (const t of ['deploy script updates both servers', 'deploy script updates both servers now', 'deploy script pushes to both servers']) {
    expect(r.out).toContain(t);
  }
  expect(r.out).toMatch(/marked \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  expect(r.out).toContain('--allow-refold');

  const one = await cli(['--refold-blocks', '--member', String(M2)]);
  expect(one.out).toContain('1 undone pair(s)');
  expect(one.out).toContain('deploy script pushes to both servers');
  expect(one.out).not.toContain('updates both servers now');
  // Either side of the pair selects it, exactly as --allow-refold would.
  expect((await cli(['--refold-blocks', '--member', String(S)])).out).toContain('2 undone pair(s)');
  const none = await cli(['--refold-blocks', '--member', '99999']);
  expect(none.code).toBe(0);
  expect(none.out).toContain('No never-re-fold marker involves observation id(s) 99999');

  const json = JSON.parse((await cli(['--refold-blocks', '--json'])).out) as Array<Record<string, unknown>>;
  expect(json.map(j => [j.survivor_id, j.member_id]).sort()).toEqual([[S, M1], [S, M2]]);
  expect(json[0]).toHaveProperty('member_title');
  expect(json[0]).toHaveProperty('marked_at');

  expect(markers()).toEqual(before);                            // read-only: nothing cleared
  expect(archived(M1)).toBe(false);
});

test('--refold-blocks shows the ten newest, truncates titles, and marks a row that is gone', async () => {
  await cli(['--undo']);
  const db = new Database(dbPath);
  const ins = db.query('INSERT INTO refold_blocks (survivor_id, member_id, marked_at) VALUES (?, ?, ?)');
  for (let i = 0; i < 11; i++) ins.run(N, 5000 + i, 1_000_000 + i);   // 5000+i never existed; oldest of all
  db.query('UPDATE observations SET title = ? WHERE id = ?').run('x'.repeat(200), N);
  db.close();

  const r = await cli(['--refold-blocks']);
  expect(r.out).toContain('13 undone pair(s)');
  expect(r.out).toContain('… and 3 more');
  expect(r.out).toContain('#5010');                               // newest of the inserted, shown
  expect(r.out).not.toContain('#5000');                          // the oldest three fall below the ten shown
  expect(r.out).toContain('(row gone)');
  expect(r.out).not.toContain('x'.repeat(100));                   // 70 chars at most
  expect(JSON.parse((await cli(['--refold-blocks', '--json'])).out)).toHaveLength(13);  // --json prints them all
});

test('--refold-blocks only lists: it refuses every other mode, and --help names it', async () => {
  for (const bad of [['--undo'], ['--apply'], ['--runs'], ['--allow-refold'], ['--run', '1'], ['--since', '5'], ['--job', 'dedup']]) {
    expect((await cli(['--refold-blocks', ...bad])).code).toBe(2);
  }
  expect((await cli(['--help'])).out).toContain('--refold-blocks');
});
