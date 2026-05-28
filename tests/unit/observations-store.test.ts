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

test('ObservationsStore — schema_versions records all migrations after construction', () => {
  store.close();
  const db = new Database(join(workDir, 'observations.db'), { readonly: true });
  const rows = getAppliedVersions(db);
  db.close();
  expect(rows).toHaveLength(6);
  expect(rows.map(r => r.version)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(rows.map(r => r.name)).toEqual([
    'add_branch',
    'add_work_tokens',
    'add_stored_tokens',
    'add_retrieval_tracking',
    'add_retrieval_provenance',
    'add_dreaming_scaffold',
  ]);
  store = new ObservationsStore(join(workDir, 'observations.db'));
});

test('ObservationsStore — v6 Dreaming columns default sensibly on fresh inserts', () => {
  const id = store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: null,
  });
  const got = store.findById(id);
  expect(got!.archived).toBe(false);
  expect(got!.archived_into_theme_id).toBeNull();
  expect(got!.theme_member_ids).toBeNull();
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

test('ObservationsStore — sumPairedTokens sums only rows with BOTH tokens', () => {
  const mk = (work: number | null) => store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: work,
  });
  const a = mk(100);   // will get stored_tokens → paired
  const b = mk(200);   // will get stored_tokens → paired
  mk(300);             // work only, no stored → NOT paired
  const d = mk(null);  // stored only, no work → NOT paired
  store.setStoredTokens(a, 10);
  store.setStoredTokens(b, 20);
  store.setStoredTokens(d, 999);

  expect(store.sumPairedTokens()).toEqual({ work: 300, stored: 30, paired: 2 });
});

test('ObservationsStore — sumPairedTokens is zeroed on an empty corpus', () => {
  expect(store.sumPairedTokens()).toEqual({ work: 0, stored: 0, paired: 0 });
});

test('ObservationsStore — provenance counters default to 0 and last_surfaced_at to null', () => {
  const id = store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: null,
  });
  const got = store.findById(id);
  expect(got!.from_auto).toBe(0);
  expect(got!.from_search).toBe(0);
  expect(got!.from_drill).toBe(0);
  expect(got!.last_surfaced_at).toBeNull();
});

test('ObservationsStore — bumpRetrieval routes each source to its own column', () => {
  const id = store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: null,
  });
  const before = Math.floor(Date.now() / 1000);
  store.bumpRetrieval([id], 'auto');
  store.bumpRetrieval([id], 'auto');
  store.bumpRetrieval([id], 'search');
  store.bumpRetrieval([id], 'drill');
  const got = store.findById(id);
  expect(got!.from_auto).toBe(2);
  expect(got!.from_search).toBe(1);
  expect(got!.from_drill).toBe(1);
  expect(got!.last_surfaced_at!).toBeGreaterThanOrEqual(before);
});

test('ObservationsStore — bumpRetrieval handles multiple ids in one call', () => {
  const mk = () => store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: null,
  });
  const a = mk(); const b = mk(); const c = mk();
  store.bumpRetrieval([a, c], 'search');
  expect(store.findById(a)!.from_search).toBe(1);
  expect(store.findById(b)!.from_search).toBe(0);
  expect(store.findById(c)!.from_search).toBe(1);
});

test('ObservationsStore — bumpRetrieval([], source) is a no-op', () => {
  const id = store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: null,
  });
  store.bumpRetrieval([], 'auto');
  const got = store.findById(id);
  expect(got!.from_auto).toBe(0);
  expect(got!.last_surfaced_at).toBeNull();
});

test('ObservationsStore — getRecallStats: top_surfaced ranks by total bumps, top_recalled by drill', () => {
  const mk = (title: string) => store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'discovery', title, narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: null,
  });
  const a = mk('auto-heavy');     // lots of auto, no drill
  const b = mk('drill-heavy');    // few auto, many drill
  const c = mk('mixed');          // some of each
  mk('never-touched');

  for (let i = 0; i < 10; i++) store.bumpRetrieval([a], 'auto');
  store.bumpRetrieval([b], 'auto');
  for (let i = 0; i < 5; i++)  store.bumpRetrieval([b], 'drill');
  store.bumpRetrieval([c], 'auto');
  store.bumpRetrieval([c], 'search');
  store.bumpRetrieval([c], 'drill');

  const stats = store.getRecallStats(3);

  // 3 distinct observations got surfaced; 2 of them got drilled.
  expect(stats.surfaced_count).toBe(3);
  expect(stats.recalled_count).toBe(2);
  expect(stats.totals).toEqual({ auto: 12, search: 1, drill: 6 });

  // top_surfaced ranks by (auto+search+drill): a=10, b=6, c=3.
  expect(stats.top_surfaced.map(r => r.title)).toEqual(['auto-heavy', 'drill-heavy', 'mixed']);
  expect(stats.top_surfaced[0]!.from_auto).toBe(10);
  expect(stats.top_surfaced[0]!.from_drill).toBe(0);

  // top_recalled ranks by from_drill: b=5, c=1, a not present (drill=0).
  expect(stats.top_recalled.map(r => r.title)).toEqual(['drill-heavy', 'mixed']);
  expect(stats.top_recalled[0]!.from_drill).toBe(5);
});

test('ObservationsStore — getRecallStats handles empty / never-retrieved corpus', () => {
  store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'discovery', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: null,
  });
  const stats = store.getRecallStats(5);
  expect(stats.surfaced_count).toBe(0);
  expect(stats.recalled_count).toBe(0);
  expect(stats.totals).toEqual({ auto: 0, search: 0, drill: 0 });
  expect(stats.top_surfaced).toEqual([]);
  expect(stats.top_recalled).toEqual([]);
});

test('ObservationsStore — countMissingStoredTokens / listMissingStoredTokens', () => {
  const mk = () => store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: null,
  });
  const a = mk(); const b = mk(); mk();   // 3 rows, all stored_tokens NULL
  store.setStoredTokens(a, 5);            // a no longer missing

  expect(store.countMissingStoredTokens()).toBe(2);

  const missing = store.listMissingStoredTokens(10);
  expect(missing.map(o => o.id)).toEqual([b, b + 1]);

  expect(store.listMissingStoredTokens(1)).toHaveLength(1);   // respects limit
});
