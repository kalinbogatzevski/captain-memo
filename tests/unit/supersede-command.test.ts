// tests/unit/supersede-command.test.ts
//
// Unit tests for `captain-memo supersede list` and `captain-memo supersede undo`.
// Mirrors the harness in tests/integration/dedup-command.test.ts:
//  - Build a temp data dir + store.
//  - Insert two version pairs, linkSupersede.
//  - Run `supersede list` and assert it prints the link.
//  - Run `supersede undo <older>` and assert supersedeLinkCount drops to 0.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ObservationsStore } from '../../src/worker/observations-store.ts';
import { supersedeCommand } from '../../src/cli/commands/supersede.ts';

const tideBase = {
  session_id: 's1', project_id: 'p1', prompt_number: 1, type: 'bugfix' as const,
  title: 't', narrative: 'n', facts: [], concepts: [], files_read: [], files_modified: [],
  created_at_epoch: 1_700_000_000, branch: null, work_tokens: null,
};

let workDir: string;
let dbPath: string;
let prevEnv: string | undefined;

async function capture(fn: () => Promise<number>): Promise<{ out: string; code: number }> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  let code = 0;
  try { code = await fn(); } finally { console.log = orig; }
  return { out: lines.join('\n'), code };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-supersede-'));
  dbPath = join(workDir, 'observations.db');
  prevEnv = process.env.CAPTAIN_MEMO_DATA_DIR;
  process.env.CAPTAIN_MEMO_DATA_DIR = workDir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.CAPTAIN_MEMO_DATA_DIR;
  else process.env.CAPTAIN_MEMO_DATA_DIR = prevEnv;
  rmSync(workDir, { recursive: true, force: true });
});

test('supersede list prints open links in older → newer format', async () => {
  const store = new ObservationsStore(dbPath);
  const older = store.insert({ ...tideBase, title: 'talq v0.6.0' });
  const newer = store.insert({ ...tideBase, title: 'talq v0.51.12' });
  store.linkSupersede(older, newer, { entityKey: 'talq', olderVersion: 'v0.6.0', newerVersion: 'v0.51.12', atEpoch: 1_700_000_100 });
  store.close();

  const { out, code } = await capture(() => supersedeCommand(['list']));
  expect(code).toBe(0);
  expect(out).toContain(`${older} → ${newer}`);
  expect(out).toContain('[talq]');
  expect(out).toContain('v0.6.0 ⇒ v0.51.12');
});

test('supersede list prints "No open supersede links." when none exist', async () => {
  const store = new ObservationsStore(dbPath);
  store.insert({ ...tideBase, title: 'solo v1.0.0' });
  store.close();

  const { out, code } = await capture(() => supersedeCommand(['list']));
  expect(code).toBe(0);
  expect(out).toContain('No open supersede links.');
});

test('supersede undo reverses the link and drops supersedeLinkCount to 0', async () => {
  const store = new ObservationsStore(dbPath);
  const older = store.insert({ ...tideBase, title: 'app v1.0.0' });
  const newer = store.insert({ ...tideBase, title: 'app v2.0.0' });
  store.linkSupersede(older, newer, { entityKey: 'app', olderVersion: 'v1.0.0', newerVersion: 'v2.0.0', atEpoch: 1_700_000_200 });
  expect(store.supersedeLinkCount()).toBe(1);
  store.close();

  const { code } = await capture(() => supersedeCommand(['undo', String(older)]));
  expect(code).toBe(0);

  const store2 = new ObservationsStore(dbPath, { readonly: true });
  expect(store2.supersedeLinkCount()).toBe(0);
  expect(store2.listSupersedeEvents(10)).toHaveLength(0);
  store2.close();
});

test('supersede undo prints confirmation message', async () => {
  const store = new ObservationsStore(dbPath);
  const older = store.insert({ ...tideBase, title: 'lib v3.0.0' });
  const newer = store.insert({ ...tideBase, title: 'lib v4.0.0' });
  store.linkSupersede(older, newer, { entityKey: 'lib', olderVersion: 'v3.0.0', newerVersion: 'v4.0.0', atEpoch: 1_700_000_300 });
  store.close();

  const { out, code } = await capture(() => supersedeCommand(['undo', String(older)]));
  expect(code).toBe(0);
  expect(out).toContain(String(older));
});

test('supersede undo returns exit 2 for missing id arg', async () => {
  const store = new ObservationsStore(dbPath);
  store.close();
  const errLines: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errLines.push(a.map(String).join(' ')); };
  const code = await supersedeCommand(['undo']).finally(() => { console.error = origErr; });
  expect(code).toBe(2);
});
