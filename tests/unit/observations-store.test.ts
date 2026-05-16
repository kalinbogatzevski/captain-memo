import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { ObservationsStore } from '../../src/worker/observations-store.ts';
import { getAppliedVersions } from '../../src/worker/migrations.ts';

let workDir: string;
let store: ObservationsStore;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-obs-'));
  store = new ObservationsStore(join(workDir, 'observations.db'));
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

test('ObservationsStore — insert returns row id and find roundtrips', () => {
  const id = store.insert({
    session_id: 's1',
    project_id: 'p1',
    prompt_number: 1,
    type: 'bugfix',
    title: 'fixed off-by-one',
    narrative: 'patched the loop bound',
    facts: ['index started at 1', 'should start at 0'],
    concepts: ['off-by-one'],
    files_read: ['a.ts'],
    files_modified: ['a.ts'],
    created_at_epoch: 1_700_000_000,
    branch: null,
    work_tokens: null,
  });
  expect(id).toBeGreaterThan(0);
  const got = store.findById(id);
  expect(got).not.toBeNull();
  expect(got!.title).toBe('fixed off-by-one');
  expect(got!.facts).toEqual(['index started at 1', 'should start at 0']);
  expect(got!.concepts).toEqual(['off-by-one']);
});

test('ObservationsStore — listForSession returns chronological order', () => {
  store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 2,
    type: 'feature', title: 'b', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 200, branch: null, work_tokens: null,
  });
  store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 'a', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100, branch: null, work_tokens: null,
  });
  const list = store.listForSession('s1');
  expect(list.map(o => o.title)).toEqual(['a', 'b']);
});

test('ObservationsStore — work_tokens roundtrips (numeric and null)', () => {
  const idWith = store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'discovery', title: 'with tokens', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 1_700_000_000,
    branch: null, work_tokens: 2_400,
  });
  const gotWith = store.findById(idWith);
  expect(gotWith!.work_tokens).toBe(2_400);

  const idNull = store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 2,
    type: 'discovery', title: 'no tokens', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 1_700_000_001,
    branch: null, work_tokens: null,
  });
  const gotNull = store.findById(idNull);
  expect(gotNull!.work_tokens).toBeNull();
});

test('ObservationsStore — listRecent respects limit', () => {
  for (let i = 0; i < 5; i++) {
    store.insert({
      session_id: 's', project_id: 'p', prompt_number: i,
      type: 'change', title: `t${i}`, narrative: '', facts: [], concepts: [],
      files_read: [], files_modified: [], created_at_epoch: 100 + i, branch: null, work_tokens: null,
    });
  }
  expect(store.listRecent(3)).toHaveLength(3);
});

test('ObservationsStore — schema_versions records migrations 1, 2 and 3 after construction', () => {
  store.close();
  const db = new Database(join(workDir, 'observations.db'), { readonly: true });
  const rows = getAppliedVersions(db);
  db.close();
  expect(rows).toHaveLength(3);
  expect(rows.map(r => r.version)).toEqual([1, 2, 3]);
  expect(rows.map(r => r.name)).toEqual(['add_branch', 'add_work_tokens', 'add_stored_tokens']);
  store = new ObservationsStore(join(workDir, 'observations.db'));
});

test('ObservationsStore — stored_tokens defaults to null on insert', () => {
  const id = store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: null,
  });
  expect(store.findById(id)!.stored_tokens).toBeNull();
});

test('ObservationsStore — setStoredTokens roundtrips', () => {
  const id = store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: null,
  });
  store.setStoredTokens(id, 137);
  expect(store.findById(id)!.stored_tokens).toBe(137);
});

test('ObservationsStore — sumWorkTokens / sumStoredTokens ignore NULL rows', () => {
  const mk = (work: number | null) => store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: work,
  });
  const a = mk(100); mk(200); mk(null);   // 3 rows, 2 with work_tokens
  store.setStoredTokens(a, 25);            // 1 row with stored_tokens

  expect(store.sumWorkTokens()).toEqual({ sum: 300, count: 2 });
  expect(store.sumStoredTokens()).toEqual({ sum: 25, count: 1 });
});
