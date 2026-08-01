// tests/integration/dedup-command.test.ts
//
// End-to-end for `captain-memo dedup`: dry-run changes nothing, --apply
// archives near-dupe members into the survivor, --undo reverses it. Drives the
// real command against a temp observations.db via CAPTAIN_MEMO_DATA_DIR.

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

function seed(store: ObservationsStore, title: string, auto: number) {
  const id = store.insert({
    session_id: 's', project_id: 'p', prompt_number: 1,
    type: 'discovery', title, narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100, branch: null, origin_agent: null, work_tokens: null,
  });
  for (let i = 0; i < auto; i++) store.bumpRetrieval([id], 'auto');
  return id;
}

async function capture(fn: () => Promise<number>): Promise<{ out: string; code: number }> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  let code = 0;
  try { code = await fn(); } finally { console.log = orig; }
  return { out: lines.join('\n'), code };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-dedup-'));
  dbPath = join(workDir, 'observations.db');
  const store = new ObservationsStore(dbPath);
  seed(store, 'deploy script updates both servers', 5);       // survivor
  seed(store, 'deploy script updates both servers now', 3);   // member
  seed(store, 'deploy script pushes to both servers', 2);     // member
  seed(store, 'completely unrelated topic xyz', 4);           // own group
  store.close();
  prevEnv = process.env.CAPTAIN_MEMO_DATA_DIR;
  process.env.CAPTAIN_MEMO_DATA_DIR = workDir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.CAPTAIN_MEMO_DATA_DIR;
  else process.env.CAPTAIN_MEMO_DATA_DIR = prevEnv;
  rmWorkDir(workDir);
});

test('dedup dry-run finds the group and mutates nothing', async () => {
  const { out, code } = await capture(() => dedupCommand(['--json']));
  expect(code).toBe(0);
  const j = JSON.parse(out);
  expect(j.mode).toBe('dry-run');
  expect(j.groups_count).toBe(1);
  expect(j.observations_archivable).toBe(2);

  const store = new ObservationsStore(dbPath);
  expect(store.getRecallStats(50).surfaced_count).toBe(4);   // untouched
  store.close();
});

test('dedup --apply archives the members into the survivor', async () => {
  const { code } = await capture(() => dedupCommand(['--apply', '--json']));
  expect(code).toBe(0);

  const store = new ObservationsStore(dbPath);
  const stats = store.getRecallStats(50);
  expect(stats.surfaced_count).toBe(2);                       // survivor + unrelated
  const survivor = stats.top_surfaced.find(r => r.title.startsWith('deploy script updates both servers'))!;
  expect(survivor.from_auto).toBe(10);                        // 5 + 3 + 2 summed
  store.close();
});

test('dedup --undo reverses a prior --apply', async () => {
  await capture(() => dedupCommand(['--apply', '--json']));
  const { code } = await capture(() => dedupCommand(['--undo', '--json']));
  expect(code).toBe(0);

  const store = new ObservationsStore(dbPath);
  expect(store.getRecallStats(50).surfaced_count).toBe(4);   // restored
  store.close();
});

test('dedup --apply writes a backup file', async () => {
  await capture(() => dedupCommand(['--apply']));
  const { readdirSync } = await import('fs');
  const backups = readdirSync(workDir).filter(f => f.startsWith('observations.db.bak-'));
  expect(backups.length).toBe(1);
});

// The background sweep refuses to fold a row that was ever drilled into or explicitly anchored
// (runQmDedupSlice's memberIsProtected gate) — "a protected memory is never archived automatically".
// This command folded them anyway, so the MANUAL tool was more destructive than the automatic one.
// That was survivable while the automatic pass was opt-in and effectively nobody ran it. It is not
// survivable now that it ships on by default and this command is the sanctioned way to clear a backlog.
/** id of a seeded row by exact title — top_surfaced collapses near-dupes, so it cannot be used here. */
function idByTitle(title: string): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query('SELECT id FROM observations WHERE title = ?').get(title) as { id: number } | undefined;
  db.close();
  if (!row) throw new Error(`fixture missing: ${title}`);
  return row.id;
}
const archivedOf = (id: number): number => {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query('SELECT archived FROM observations WHERE id = ?').get(id) as { archived: number };
  db.close();
  return row.archived;
};

test('dedup --apply never folds a DRILLED member — the sweep protects it, so must this', async () => {
  const id = idByTitle('deploy script updates both servers now');
  const store = new ObservationsStore(dbPath);
  store.bumpRetrieval([id], 'drill');                         // an explicit drill-in protects it
  store.close();

  await capture(() => dedupCommand(['--apply', '--json']));

  expect(archivedOf(id)).toBe(0);                             // survived the fold
});

test('dedup --apply never folds an ANCHORED member', async () => {
  const id = idByTitle('deploy script pushes to both servers');
  const store = new ObservationsStore(dbPath);
  store.markAnchored(id);
  store.close();

  await capture(() => dedupCommand(['--apply', '--json']));

  expect(archivedOf(id)).toBe(0);
});
