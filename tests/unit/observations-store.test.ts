import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { ObservationsStore } from '../../src/worker/observations-store.ts';
import { getAppliedVersions } from '../../src/worker/migrations.ts';
import { DEFAULT_TIDE_CONFIG, nextStability } from '../../src/worker/tide.ts';

const tideBase = {
  session_id: 's1', project_id: 'p1', prompt_number: 1, type: 'bugfix' as const,
  title: 't', narrative: 'n', facts: [], concepts: [], files_read: [], files_modified: [],
  created_at_epoch: 1_700_000_000, branch: null, work_tokens: null,
};

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

test('ObservationsStore — migration v8 adds Tide lifecycle columns + partial index', () => {
  const db = new Database(join(workDir, 'observations.db'));
  const cols = db.query('PRAGMA table_info(observations)').all() as Array<{ name: string; dflt_value: unknown }>;
  const byName = new Map(cols.map(c => [c.name, c]));

  // New columns exist
  expect(byName.has('stability_days')).toBe(true);
  expect(byName.has('tide_state')).toBe(true);
  expect(byName.has('tide_state_changed_at')).toBe(true);
  expect(byName.has('is_anchored')).toBe(true);

  // Correct defaults (PRAGMA reports the literal SQL default text)
  expect(String(byName.get('tide_state')!.dflt_value)).toContain('active');
  expect(Number(byName.get('is_anchored')!.dflt_value)).toBe(0);
  // stability_days is nullable with no default (NULL ⇒ seed from channel S0 at read time)
  expect(byName.get('stability_days')!.dflt_value).toBeNull();

  // Partial index exists (mirrors the v6 archived pattern)
  const idx = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_obs_tide_state'").all();
  expect(idx.length).toBe(1);

  // v8 recorded as applied
  expect(getAppliedVersions(db).some(v => v.version === 8)).toBe(true);
  db.close();
});

test('ObservationsStore — migration v9 adds merge_events ledger table + partial index', () => {
  const db = new Database(join(workDir, 'observations.db'));
  const cols = db.query('PRAGMA table_info(merge_events)').all() as Array<{ name: string; dflt_value: unknown }>;
  const byName = new Map(cols.map(c => [c.name, c]));

  // Ledger columns exist
  for (const c of ['id', 'survivor_id', 'member_id', 'summed_auto', 'summed_search',
                   'summed_drill', 'merged_at', 'job', 'undone', 'survivor_prev_surfaced_at']) {
    expect(byName.has(c)).toBe(true);
  }

  // Defaults (PRAGMA reports literal SQL default text)
  expect(Number(byName.get('summed_auto')!.dflt_value)).toBe(0);
  expect(Number(byName.get('undone')!.dflt_value)).toBe(0);
  expect(String(byName.get('job')!.dflt_value)).toContain('dedup');

  // Partial index exists (mirrors the v6/v8 archived/state pattern)
  const idx = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_merge_events_survivor'").all();
  expect(idx.length).toBe(1);

  // v9 recorded as applied
  expect(getAppliedVersions(db).some(v => v.version === 9)).toBe(true);
  db.close();
});

test('tideRowsAmong — returns buoyancy inputs; empty input → empty map', () => {
  const id = store.insert({ ...tideBase });
  expect(store.tideRowsAmong([]).size).toBe(0);
  const map = store.tideRowsAmong([id, 999999]);
  expect(map.has(id)).toBe(true);
  expect(map.has(999999)).toBe(false);
  const r = map.get(id)!;
  expect(r.created_at_epoch).toBe(1_700_000_000);
  expect(r.last_surfaced_at).toBeNull();
  expect(r.stability_days).toBeNull();
  expect(r.from_drill).toBe(0);
  expect(r.is_anchored).toBe(false);
});

test('bumpRetrieval — Tide disabled: stability stays NULL, existing bump intact', () => {
  const id = store.insert({ ...tideBase });
  store.bumpRetrieval([id], 'search', 1_700_000_100);
  expect(store.tideRowsAmong([id]).get(id)!.stability_days).toBeNull();
  const got = store.findById(id)!;
  expect(got.from_search).toBe(1);
  expect(got.last_surfaced_at).toBe(1_700_000_100);
});

test('bumpRetrieval — Tide enabled: a recall seeds from S0 then grows stability', () => {
  const ts = new ObservationsStore(join(workDir, 'tide-enabled.db'), {
    tideConfig: { ...DEFAULT_TIDE_CONFIG, enabled: true },
  });
  const id = ts.insert({ ...tideBase });
  expect(ts.tideRowsAmong([id]).get(id)!.stability_days).toBeNull();
  ts.bumpRetrieval([id], 'search', 1_700_000_100);
  const s1 = ts.tideRowsAmong([id]).get(id)!.stability_days!;
  expect(s1).toBeGreaterThan(DEFAULT_TIDE_CONFIG.s0.observation); // seeded from S0=7, then strengthened
  ts.bumpRetrieval([id], 'search', 1_700_000_200);
  const s2 = ts.tideRowsAmong([id]).get(id)!.stability_days!;
  expect(s2).toBeGreaterThan(s1); // each recall strengthens
  ts.close();
});

test('bumpRetrieval — Tide enabled: drill strengthens more than auto (source-weighted)', () => {
  const ts = new ObservationsStore(join(workDir, 'tide-src.db'), {
    tideConfig: { ...DEFAULT_TIDE_CONFIG, enabled: true },
  });
  const idAuto = ts.insert({ ...tideBase });
  const idDrill = ts.insert({ ...tideBase });
  ts.bumpRetrieval([idAuto], 'auto', 1_700_000_100);
  ts.bumpRetrieval([idDrill], 'drill', 1_700_000_100);
  const sAuto = ts.tideRowsAmong([idAuto]).get(idAuto)!.stability_days!;
  const sDrill = ts.tideRowsAmong([idDrill]).get(idDrill)!.stability_days!;
  expect(sDrill).toBeGreaterThan(sAuto);
  ts.close();
});

test('bumpRetrieval — SQL stability update equals tide.ts nextStability (JS↔SQL parity)', () => {
  // Guards against the SQLite integer-division trap: the SQL UPDATE must compute
  // the SAME value as the pure-JS nextStability, to the float bit.
  const cfg = { ...DEFAULT_TIDE_CONFIG, enabled: true };
  const ts = new ObservationsStore(join(workDir, 'tide-parity.db'), { tideConfig: cfg });
  const id = ts.insert({ ...tideBase });
  ts.bumpRetrieval([id], 'search', 1_700_000_100);
  const sql = ts.tideRowsAmong([id]).get(id)!.stability_days!;
  const js = nextStability(null, 'search', cfg, 'observation');
  expect(sql).toBeCloseTo(js, 9);
  ts.close();
});

test('getTideStats — empty corpus: zeros and null max', () => {
  const s = store.getTideStats();
  expect(s.strengthened).toBe(0);
  expect(s.by_state).toEqual({ active: 0, dormant: 0, archived: 0 });
  expect(s.anchored).toBe(0);
  expect(s.max_stability_days).toBeNull();
});

test('getTideStats — counts strengthened, tier breakdown, anchored, max stability', () => {
  const a = store.insert({ ...tideBase });   // strengthened, stays active
  const b = store.insert({ ...tideBase });   // strengthened, dormant
  const c = store.insert({ ...tideBase });   // archived, never strengthened
  const anc = store.insert({ ...tideBase }); // anchored, active
  // tide_state / is_anchored / stability_days have no MVP setters (Phase 2 owns the
  // transitions), so seed the lifecycle columns directly to exercise the aggregate.
  const raw = new Database(join(workDir, 'observations.db'));
  raw.run('UPDATE observations SET stability_days = 12.5 WHERE id = ?', [a]);
  raw.run("UPDATE observations SET stability_days = 40.0, tide_state = 'dormant' WHERE id = ?", [b]);
  raw.run("UPDATE observations SET tide_state = 'archived' WHERE id = ?", [c]);
  raw.run('UPDATE observations SET is_anchored = 1 WHERE id = ?', [anc]);
  raw.close();

  const s = store.getTideStats();
  expect(s.strengthened).toBe(2);                          // a + b have stability_days
  expect(s.by_state).toEqual({ active: 2, dormant: 1, archived: 1 }); // a + anc active
  expect(s.anchored).toBe(1);                              // anc
  expect(s.max_stability_days).toBeCloseTo(40.0, 5);
});

// ── tier persistence (Phase 2) ─────────────────────────────────────────────
test('sunkAmong — returns dormant + archived ids, never active; empty → empty', () => {
  const a = store.insert({ ...tideBase });
  const d = store.insert({ ...tideBase });
  const ar = store.insert({ ...tideBase });
  store.setTideState(d, 'dormant', 1);
  store.setTideState(ar, 'archived', 1);
  const sunk = store.sunkAmong([a, d, ar]);
  expect(sunk.has(a)).toBe(false);
  expect(sunk.has(d)).toBe(true);
  expect(sunk.has(ar)).toBe(true);
  expect(store.sunkAmong([]).size).toBe(0);
});

test('setTideState + restoreObservation: three-way (restored / already_active / not_found)', () => {
  const id = store.insert({ ...tideBase });
  store.setTideState(id, 'dormant', 111);
  expect(store.sunkAmong([id]).has(id)).toBe(true);
  expect(store.restoreObservation(id, 222)).toBe('restored');       // re-surfaced
  expect(store.sunkAmong([id]).has(id)).toBe(false);
  expect(store.restoreObservation(id, 333)).toBe('already_active'); // no-op
  expect(store.restoreObservation(999_999, 444)).toBe('not_found'); // typo'd id ≠ "already fine"
});

test('listByTideState — returns rows of a tier, most-recently-changed first', () => {
  const d1 = store.insert({ ...tideBase, title: 'd1' });
  const d2 = store.insert({ ...tideBase, title: 'd2' });
  store.setTideState(d1, 'dormant', 100);
  store.setTideState(d2, 'dormant', 200);   // changed later → listed first
  const list = store.listByTideState('dormant', 10);
  expect(list.map(r => r.id)).toEqual([d2, d1]);
  expect(store.listByTideState('archived', 10)).toEqual([]);
});

test('tierSweepCandidates — bounded, oldest-first, excludes drilled/anchored/archived', () => {
  const cfg = { ...DEFAULT_TIDE_CONFIG, enabled: true };
  const ts = new ObservationsStore(join(workDir, 'tide-cands.db'), { tideConfig: cfg });
  const old1 = ts.insert({ ...tideBase, created_at_epoch: 1000 });
  const old2 = ts.insert({ ...tideBase, created_at_epoch: 2000 });
  const drilled = ts.insert({ ...tideBase, created_at_epoch: 1500 });
  ts.bumpRetrieval([drilled], 'drill', 1600);     // from_drill > 0 → excluded
  const archived = ts.insert({ ...tideBase, created_at_epoch: 1200 });
  ts.setTideState(archived, 'archived', 1300);    // archived tier → excluded
  const anchored = ts.insert({ ...tideBase, created_at_epoch: 1100 });
  const raw = new Database(join(workDir, 'tide-cands.db'));
  raw.run('UPDATE observations SET is_anchored = 1 WHERE id = ?', [anchored]);
  raw.close();

  const ids = ts.tierSweepCandidates('active', 10, 5_000).map(c => c.id); // future olderThan → all qualify by age
  expect(ids).toContain(old1);
  expect(ids).toContain(old2);
  expect(ids).not.toContain(drilled);             // from_drill
  expect(ids).not.toContain(archived);            // not 'active' (it's archived)
  expect(ids).not.toContain(anchored);            // anchored
  expect(ids.indexOf(old1)).toBeLessThan(ids.indexOf(old2)); // oldest first
  expect(ts.tierSweepCandidates('active', 1, 5_000).length).toBe(1);   // limit respected
  // The dormant tier is a separate scan — 'active' must not return the archived/dormant rows.
  ts.setTideState(old2, 'dormant', 2_500);
  expect(ts.tierSweepCandidates('active', 10, 5_000).map(c => c.id)).not.toContain(old2);
  expect(ts.tierSweepCandidates('dormant', 10, 5_000).map(c => c.id)).toContain(old2);
  ts.close();
});

test('bumpRetrieval — a recall surfaces a sunk row back to active (surface rail)', () => {
  const cfg = { ...DEFAULT_TIDE_CONFIG, enabled: true };
  const ts = new ObservationsStore(join(workDir, 'tide-surface.db'), { tideConfig: cfg });
  const id = ts.insert({ ...tideBase });
  ts.setTideState(id, 'dormant', 1_700_000_050);
  expect(ts.sunkAmong([id]).has(id)).toBe(true);
  ts.bumpRetrieval([id], 'search', 1_700_000_100);  // recall → buoyancy ~1 → surface
  expect(ts.sunkAmong([id]).has(id)).toBe(false);
  expect(ts.listByTideState('active', 10).map(r => r.id)).toContain(id);
  ts.close();
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
  expect(rows).toHaveLength(10);
  expect(rows.map(r => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(rows.map(r => r.name)).toEqual([
    'add_branch',
    'add_work_tokens',
    'add_stored_tokens',
    'add_retrieval_tracking',
    'add_retrieval_provenance',
    'add_dreaming_scaffold',
    'add_last_surfaced_source',
    'add_tide_lifecycle',
    'add_merge_events',
    'add_qm_runs',
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

// ── v7: last_surfaced_source + recency + collapse + archived exclusion ──

const mkObs = (store: ObservationsStore, title: string, type = 'discovery') =>
  store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: type as any, title, narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: null,
  });

test('ObservationsStore — last_surfaced_source defaults null and bumpRetrieval stamps it', () => {
  const id = mkObs(store, 't');
  expect(store.findById(id)!.last_surfaced_source).toBeNull();
  store.bumpRetrieval([id], 'drill');
  expect(store.findById(id)!.last_surfaced_source).toBe('drill');
  store.bumpRetrieval([id], 'auto');
  expect(store.findById(id)!.last_surfaced_source).toBe('auto');  // latest wins
});

test('ObservationsStore — bumpRetrieval accepts an explicit epoch for deterministic ordering', () => {
  const id = mkObs(store, 't');
  store.bumpRetrieval([id], 'search', 1_234);
  expect(store.findById(id)!.last_surfaced_at).toBe(1_234);
});

test('ObservationsStore — getRecentlySurfaced returns most-recent-first with source', () => {
  const a = mkObs(store, 'alpha');
  const b = mkObs(store, 'beta');
  const c = mkObs(store, 'gamma');
  store.bumpRetrieval([a], 'search', 1_000);
  store.bumpRetrieval([b], 'auto', 2_000);
  store.bumpRetrieval([c], 'drill', 3_000);

  const recent = store.getRecentlySurfaced(10);
  expect(recent.map(r => r.id)).toEqual([c, b, a]);
  expect(recent.map(r => r.source)).toEqual(['drill', 'auto', 'search']);
  expect(recent[0]!.last_surfaced_at).toBe(3_000);

  expect(store.getRecentlySurfaced(2).map(r => r.id)).toEqual([c, b]); // limit
});

test('ObservationsStore — getRecentlySurfaced skips never-surfaced and archived rows', () => {
  const a = mkObs(store, 'surfaced');
  mkObs(store, 'never-surfaced');               // no bump → excluded
  const victim = mkObs(store, 'to-be-archived');
  store.bumpRetrieval([a], 'auto', 1_000);
  store.bumpRetrieval([victim], 'auto', 9_000);
  store.mergeDuplicateGroup(a, [victim], 1000); // victim archived into a

  const ids = store.getRecentlySurfaced(10).map(r => r.id);
  expect(ids).toContain(a);
  expect(ids).not.toContain(victim);            // archived excluded
});

test('ObservationsStore — mergeDuplicateGroup sums member counts into survivor and archives members', () => {
  const survivor = mkObs(store, 'canonical');
  const m1 = mkObs(store, 'dup one');
  const m2 = mkObs(store, 'dup two');
  store.bumpRetrieval([survivor], 'auto', 100);  store.bumpRetrieval([survivor], 'auto', 110); store.bumpRetrieval([survivor], 'auto', 120);
  store.bumpRetrieval([m1], 'auto', 200);        store.bumpRetrieval([m1], 'auto', 210);       store.bumpRetrieval([m1], 'auto', 220);
  store.bumpRetrieval([m2], 'search', 300);      store.bumpRetrieval([m2], 'search', 310);     store.bumpRetrieval([m2], 'drill', 320);

  store.mergeDuplicateGroup(survivor, [m1, m2], 1000);

  const s = store.findById(survivor)!;
  expect(s.from_auto).toBe(6);     // 3 + 3
  expect(s.from_search).toBe(2);   // 0 + 2
  expect(s.from_drill).toBe(1);    // 0 + 1
  expect(s.archived).toBe(false);
  expect(s.theme_member_ids).toEqual([m1, m2]);
  expect(s.last_surfaced_at).toBe(320); // max across the group

  expect(store.findById(m1)!.archived).toBe(true);
  expect(store.findById(m1)!.archived_into_theme_id).toBe(survivor);
  expect(store.findById(m2)!.archived).toBe(true);
});

test('ObservationsStore — getRecallStats collapses near-duplicate titles, summing counts + variants', () => {
  const titles = [
    'update-status skill command verified and available',
    'update-status skill command available in erp-platform',
    'update-status skill command verified in erp-platform',
    'update-status skill command is available',
    'update-status skill registered and callable',
  ];
  for (const t of titles) {
    const id = mkObs(store, t);
    store.bumpRetrieval([id], 'auto'); store.bumpRetrieval([id], 'auto'); store.bumpRetrieval([id], 'auto');
  }

  const stats = store.getRecallStats(5);
  // surfaced_count counts distinct rows (collapse is display-only).
  expect(stats.surfaced_count).toBe(5);
  // At the 0.5 default, 4 phrasings collapse, the 5th stands alone → 2 entries.
  expect(stats.top_surfaced).toHaveLength(2);
  expect(stats.top_surfaced[0]!.variants).toBe(4);
  expect(stats.top_surfaced[0]!.from_auto).toBe(12);   // 4 × 3
  expect(stats.top_surfaced[1]!.variants).toBe(1);
  expect(stats.top_surfaced[1]!.from_auto).toBe(3);
});

test('ObservationsStore — getRecallStats excludes archived rows from counts and top lists', () => {
  const kept = mkObs(store, 'kept alpha distinct');
  const victim = mkObs(store, 'victim beta distinct');
  for (let i = 0; i < 5; i++) store.bumpRetrieval([kept], 'auto');
  for (let i = 0; i < 9; i++) store.bumpRetrieval([victim], 'auto');
  store.mergeDuplicateGroup(kept, [victim], 1000);   // kept → 5 + 9 = 14, victim archived

  const stats = store.getRecallStats(5);
  expect(stats.surfaced_count).toBe(1);                       // victim excluded
  expect(stats.top_surfaced.map(r => r.title)).toEqual(['kept alpha distinct']);
  expect(stats.top_surfaced[0]!.from_auto).toBe(14);
});

test('ObservationsStore — archivedAmong returns only the archived subset', () => {
  const a = mkObs(store, 'a'); const b = mkObs(store, 'b'); const c = mkObs(store, 'c');
  store.mergeDuplicateGroup(a, [b], 1000);   // b archived into a
  const set = store.archivedAmong([a, b, c]);
  expect(set.has(b)).toBe(true);
  expect(set.has(a)).toBe(false);
  expect(set.has(c)).toBe(false);
  expect(store.archivedAmong([]).size).toBe(0);
});

test('ObservationsStore — getRecallStats includes recent_surfaced', () => {
  const a = mkObs(store, 'recent one');
  store.bumpRetrieval([a], 'auto', 5_000);
  const stats = store.getRecallStats(5);
  expect(stats.recent_surfaced.map(r => r.id)).toEqual([a]);
  expect(stats.recent_surfaced[0]!.source).toBe('auto');
});

// ── queryRecall: server-side sort / filter / page / collapse for `top` ──

function seedSurfaced(store: ObservationsStore, title: string, type: string,
  auto: number, search: number, drill: number, ts: number) {
  const id = mkObs(store, title, type);
  for (let i = 0; i < auto; i++)   store.bumpRetrieval([id], 'auto', ts);
  for (let i = 0; i < search; i++) store.bumpRetrieval([id], 'search', ts);
  for (let i = 0; i < drill; i++)  store.bumpRetrieval([id], 'drill', ts);
  return id;
}

test('queryRecall — view=surfaced sort=total ranks by total bumps, raw (no collapse)', () => {
  seedSurfaced(store, 'alpha', 'feature', 10, 0, 0, 100);
  seedSurfaced(store, 'beta', 'bugfix', 2, 3, 0, 200);   // total 5
  seedSurfaced(store, 'gamma', 'change', 1, 0, 0, 300);
  const page = store.queryRecall({ view: 'surfaced', sort: 'total', limit: 50, offset: 0, collapse: false });
  expect(page.rows.map(r => r.title)).toEqual(['alpha', 'beta', 'gamma']);
  expect(page.rows[0]!.total).toBe(10);
  expect(page.total).toBe(3);
});

test('queryRecall — view=recalled only includes drilled rows, sort by drill', () => {
  seedSurfaced(store, 'no-drill', 'feature', 9, 0, 0, 100);
  seedSurfaced(store, 'drilled', 'bugfix', 0, 0, 4, 200);
  const page = store.queryRecall({ view: 'recalled', sort: 'drill', limit: 50, offset: 0, collapse: false });
  expect(page.rows.map(r => r.title)).toEqual(['drilled']);
  expect(page.rows[0]!.from_drill).toBe(4);
});

test('queryRecall — view=recent sort=recency orders by last_surfaced_at desc', () => {
  seedSurfaced(store, 'old', 'feature', 1, 0, 0, 100);
  seedSurfaced(store, 'new', 'feature', 1, 0, 0, 900);
  seedSurfaced(store, 'mid', 'feature', 1, 0, 0, 500);
  const page = store.queryRecall({ view: 'recent', sort: 'recency', limit: 50, offset: 0, collapse: false });
  expect(page.rows.map(r => r.title)).toEqual(['new', 'mid', 'old']);
});

test('queryRecall — type filter and case-insensitive title substring (q)', () => {
  seedSurfaced(store, 'Calendar team filter', 'feature', 5, 0, 0, 100);
  seedSurfaced(store, 'calendar bug squashed', 'bugfix', 5, 0, 0, 200);
  seedSurfaced(store, 'unrelated thing', 'feature', 5, 0, 0, 300);

  const byType = store.queryRecall({ view: 'surfaced', sort: 'total', type: 'bugfix', limit: 50, offset: 0, collapse: false });
  expect(byType.rows.map(r => r.title)).toEqual(['calendar bug squashed']);

  const byQ = store.queryRecall({ view: 'surfaced', sort: 'total', q: 'CALENDAR', limit: 50, offset: 0, collapse: false });
  expect(byQ.rows.map(r => r.title).sort()).toEqual(['Calendar team filter', 'calendar bug squashed']);
  expect(byQ.total).toBe(2);
});

test('queryRecall — limit/offset paginate while total reflects the full match count', () => {
  for (let i = 0; i < 5; i++) seedSurfaced(store, `row${i}`, 'feature', 10 - i, 0, 0, 100 + i);
  const page = store.queryRecall({ view: 'surfaced', sort: 'total', limit: 2, offset: 2, collapse: false });
  expect(page.rows.map(r => r.title)).toEqual(['row2', 'row3']);
  expect(page.total).toBe(5);
});

test('queryRecall — collapse=true folds near-duplicate titles and sums counts', () => {
  seedSurfaced(store, 'update-status skill command verified and available', 'discovery', 3, 0, 0, 100);
  seedSurfaced(store, 'update-status skill command available in erp-platform', 'discovery', 3, 0, 0, 110);
  seedSurfaced(store, 'update-status skill command is available', 'discovery', 3, 0, 0, 120);
  seedSurfaced(store, 'totally different observation here', 'feature', 1, 0, 0, 130);

  const collapsed = store.queryRecall({ view: 'surfaced', sort: 'total', limit: 50, offset: 0, collapse: true });
  const top = collapsed.rows[0]!;
  expect(top.variants).toBe(3);
  expect(top.total).toBe(9);                 // 3 × 3 summed
  expect(collapsed.rows).toHaveLength(2);    // 3 dupes → 1, plus the unrelated
  expect(collapsed.total).toBe(4);           // page.total = pre-collapse match count, NOT group count

  const raw = store.queryRecall({ view: 'surfaced', sort: 'total', limit: 50, offset: 0, collapse: false });
  expect(raw.rows).toHaveLength(4);          // raw shows every row
});

test('queryRecall — collapse ties break deterministically by id (descending)', () => {
  const lo = seedSurfaced(store, 'apple distinct alpha', 'feature', 2, 0, 0, 500);
  const hi = seedSurfaced(store, 'zebra distinct beta', 'feature', 2, 0, 0, 500);  // same total + ts
  const a = store.queryRecall({ view: 'surfaced', sort: 'total', limit: 50, offset: 0, collapse: true });
  const b = store.queryRecall({ view: 'surfaced', sort: 'total', limit: 50, offset: 0, collapse: true });
  expect(a.rows.map(r => r.id)).toEqual(b.rows.map(r => r.id));   // deterministic
  expect(a.rows[0]!.id).toBe(Math.max(lo, hi));                   // higher id first on full tie
});

test('mergeDuplicateGroup — preserves NULL last_surfaced_at when nothing was ever surfaced', () => {
  const s = mkObs(store, 'never surfaced survivor');
  const m = mkObs(store, 'never surfaced member');
  store.mergeDuplicateGroup(s, [m], 1000);
  expect(store.findById(s)!.last_surfaced_at).toBeNull();   // not coerced to epoch 0
});

test('queryRecall — excludes archived rows', () => {
  const keep = seedSurfaced(store, 'kept', 'feature', 5, 0, 0, 100);
  const drop = seedSurfaced(store, 'dropped', 'feature', 5, 0, 0, 200);
  store.mergeDuplicateGroup(keep, [drop], 1000);
  const page = store.queryRecall({ view: 'surfaced', sort: 'total', limit: 50, offset: 0, collapse: false });
  expect(page.rows.map(r => r.title)).toEqual(['kept']);
  expect(page.total).toBe(1);
});

// ── dedup: find near-duplicate groups + reverse a merge ──

test('findDuplicateGroups — groups surfaced near-dupes, survivor is the highest-count row', () => {
  const a = seedSurfaced(store, 'update-status skill command verified and available', 'discovery', 5, 0, 0, 100);
  const b = seedSurfaced(store, 'update-status skill command is available', 'discovery', 3, 0, 0, 110);
  const c = seedSurfaced(store, 'update-status skill command available now', 'discovery', 2, 0, 0, 120);
  seedSurfaced(store, 'totally unrelated observation', 'feature', 9, 0, 0, 130);  // own group → excluded
  mkObs(store, 'never surfaced dup of update-status skill command', 'discovery'); // total 0 → excluded

  const groups = store.findDuplicateGroups(0.5);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.survivor.id).toBe(a);                 // count 5 leads
  expect(groups[0]!.members.map(m => m.id).sort((x, y) => x - y)).toEqual([b, c].sort((x, y) => x - y));
});

test('mergeDuplicateGroup + unmergeDuplicateGroup round-trips counts and archive flags', () => {
  const s = seedSurfaced(store, 'survivor row', 'feature', 5, 0, 0, 100);
  const m = seedSurfaced(store, 'member row', 'feature', 3, 0, 0, 110);

  store.mergeDuplicateGroup(s, [m], 1000);
  expect(store.findById(s)!.from_auto).toBe(8);
  expect(store.findById(m)!.archived).toBe(true);
  expect(store.findById(s)!.theme_member_ids).toEqual([m]);

  store.unmergeDuplicateGroup(s);
  expect(store.findById(s)!.from_auto).toBe(5);           // restored
  expect(store.findById(m)!.archived).toBe(false);        // un-archived
  expect(store.findById(m)!.archived_into_theme_id).toBeNull();
  expect(store.findById(s)!.theme_member_ids).toBeNull();
});

// Review fix: merge advances the survivor's last_surfaced_at to the group max,
// but undo must RESTORE the survivor's pre-merge value — otherwise merge+undo
// permanently inflates recency (which feeds Tide buoyancy).
test('unmergeDuplicateGroup — restores the survivor last_surfaced_at to its pre-merge value', () => {
  const s = seedSurfaced(store, 'survivor row', 'feature', 1, 0, 0, 100);   // survivor last_surfaced_at = 100
  const m = seedSurfaced(store, 'member row', 'feature', 1, 0, 0, 999);     // member  last_surfaced_at = 999

  store.mergeDuplicateGroup(s, [m], 1000);
  expect(store.findById(s)!.last_surfaced_at).toBe(999);   // advanced to group max

  store.unmergeDuplicateGroup(s);
  expect(store.findById(s)!.last_surfaced_at).toBe(100);   // restored to pre-merge
});

test('unmergeDuplicateGroup — restores NULL last_surfaced_at when survivor was never surfaced', () => {
  const s = mkObs(store, 'never surfaced survivor');                        // last_surfaced_at = NULL
  const m = seedSurfaced(store, 'surfaced member', 'feature', 1, 0, 0, 777);
  // member and survivor must share the partition (default p1 / branch null) — both do via mkObs/seedSurfaced.
  store.mergeDuplicateGroup(s, [m], 1000);
  expect(store.findById(s)!.last_surfaced_at).toBe(777);   // advanced from NULL to member's value

  store.unmergeDuplicateGroup(s);
  expect(store.findById(s)!.last_surfaced_at).toBeNull();  // restored to NULL, not coerced to 777 or 0
});

test('mergedSurvivorIds — lists rows that have folded-in members (for --undo all)', () => {
  const s = seedSurfaced(store, 'survivor', 'feature', 5, 0, 0, 100);
  const m = seedSurfaced(store, 'member', 'feature', 3, 0, 0, 110);
  expect(store.mergedSurvivorIds()).toEqual([]);
  store.mergeDuplicateGroup(s, [m], 1000);
  expect(store.mergedSurvivorIds()).toEqual([s]);
  store.unmergeDuplicateGroup(s);
  expect(store.mergedSurvivorIds()).toEqual([]);
});

test('unmergeDuplicateGroup — no-op when the row has no merged members', () => {
  const s = seedSurfaced(store, 'lonely', 'feature', 4, 0, 0, 100);
  expect(() => store.unmergeDuplicateGroup(s)).not.toThrow();
  expect(store.findById(s)!.from_auto).toBe(4);
});

// S2 regression: a SECOND merge into the same survivor must not clobber the
// first merge's reversal record. The pre-ledger code wrote theme_member_ids on
// the survivor; the second write overwrote the first, so --undo could only
// recover m2 — m1 stayed archived and its counts stayed summed in forever.
test('mergeDuplicateGroup — nested merges into one survivor are both reversible (ledger)', () => {
  const surv = seedSurfaced(store, 'hot survivor', 'feature', 5, 0, 0, 100);
  const m1 = seedSurfaced(store, 'first dup', 'feature', 3, 0, 0, 110);
  const m2 = seedSurfaced(store, 'second dup', 'feature', 4, 0, 0, 120);

  store.mergeDuplicateGroup(surv, [m1], 1000);   // first merge
  store.mergeDuplicateGroup(surv, [m2], 2000);   // SECOND merge into the SAME survivor

  // Survivor accumulated BOTH members' counts.
  expect(store.findById(surv)!.from_auto).toBe(12);   // 5 + 3 + 4
  expect(store.findById(m1)!.archived).toBe(true);
  expect(store.findById(m2)!.archived).toBe(true);

  // Undo all: both members must come back, survivor restored to its original.
  for (const id of store.mergedSurvivorIds()) store.unmergeDuplicateGroup(id);

  expect(store.findById(m1)!.archived).toBe(false);   // pre-ledger code LOST this
  expect(store.findById(m2)!.archived).toBe(false);
  expect(store.findById(surv)!.from_auto).toBe(5);     // back to original
});

// --- S1: dedup must be scoped by (project_id, branch) ----------------------
// Insert a surfaced row in an explicit (project, branch) via a raw counter
// UPDATE, because mkObs/seedSurfaced are pinned to project_id 'p1' / branch null.
function seedSurfacedScoped(
  title: string, project_id: string, branch: string | null, search: number,
): number {
  const id = store.insert({
    session_id: 's1', project_id, prompt_number: 1, type: 'discovery',
    title, narrative: '', facts: [], concepts: [], files_read: [], files_modified: [],
    created_at_epoch: 100, branch, work_tokens: null,
  });
  const db = new Database(join(workDir, 'observations.db'));
  db.query('UPDATE observations SET from_search = ? WHERE id = ?').run(search, id);
  db.close();
  return id;
}

test('findDuplicateGroups — never groups near-dupes across different projects', () => {
  const a = seedSurfacedScoped('update-status skill command verified and available', 'projA', null, 5);
  const b = seedSurfacedScoped('update-status skill command verified and available', 'projB', null, 4);

  const groups = store.findDuplicateGroups(0.5);
  // No group may contain ids from both projects.
  for (const g of groups) {
    const ids = [g.survivor.id, ...g.members.map(m => m.id)];
    expect(ids.includes(a) && ids.includes(b)).toBe(false);
  }
});

test('findDuplicateGroups — never groups near-dupes across different branches', () => {
  const a = seedSurfacedScoped('shared title same words here', 'p1', 'main', 5);
  const b = seedSurfacedScoped('shared title same words here', 'p1', 'feature-x', 4);

  const groups = store.findDuplicateGroups(0.5);
  for (const g of groups) {
    const ids = [g.survivor.id, ...g.members.map(m => m.id)];
    expect(ids.includes(a) && ids.includes(b)).toBe(false);
  }
});

test('findDuplicateGroups — still groups near-dupes within the same project+branch (positive control)', () => {
  const a = seedSurfacedScoped('update-status skill command verified and available', 'p1', null, 5);
  const b = seedSurfacedScoped('update-status skill command is available', 'p1', null, 3);

  const groups = store.findDuplicateGroups(0.5);
  const g = groups.find(x => [x.survivor.id, ...x.members.map(m => m.id)].includes(a));
  expect(g).toBeDefined();
  expect(g!.survivor.id).toBe(a);                       // higher count survives
  expect(g!.members.map(m => m.id)).toEqual([b]);
});

// --- S3: negation/identifier merge guard ------------------------------------
// Same-project, high-Jaccard pair with OPPOSITE polarity ("missing") must never
// fold — Jaccard alone would group them and corrupt the survivor.
test('findDuplicateGroups — never folds an opposite-polarity (negation) pair', () => {
  const a = seedSurfacedScoped('Inspected users table', 'p1', null, 5);
  const b = seedSurfacedScoped('users table missing', 'p1', null, 3);

  for (const g of store.findDuplicateGroups(0.5)) {
    const ids = [g.survivor.id, ...g.members.map(m => m.id)];
    expect(ids.includes(a) && ids.includes(b)).toBe(false);
  }
});

test('mergeDuplicateGroup — skips a member from a different project (no counter corruption)', () => {
  const survivor = seedSurfacedScoped('canonical title', 'p1', null, 10);
  const alien = seedSurfacedScoped('canonical title', 'p2', null, 7);

  store.mergeDuplicateGroup(survivor, [alien], 1000);

  expect(store.findById(survivor)!.from_search).toBe(10);   // not summed with alien
  expect(store.findById(survivor)!.theme_member_ids).toBeNull();
  expect(store.findById(alien)!.archived).toBe(false);      // alien untouched
});

test('mergeDuplicateGroup — skips a member on a different branch (no counter corruption)', () => {
  const survivor = seedSurfacedScoped('canonical title', 'p1', 'main', 10);
  const alien = seedSurfacedScoped('canonical title', 'p1', 'other', 7);

  store.mergeDuplicateGroup(survivor, [alien], 1000);

  expect(store.findById(survivor)!.from_search).toBe(10);
  expect(store.findById(alien)!.archived).toBe(false);
});

test('mergeDuplicateGroup — still folds same-project+branch members (positive control)', () => {
  const survivor = seedSurfacedScoped('canonical title', 'p1', 'main', 10);
  const member = seedSurfacedScoped('dup title', 'p1', 'main', 7);

  store.mergeDuplicateGroup(survivor, [member], 1000);

  expect(store.findById(survivor)!.from_search).toBe(17);   // 10 + 7
  expect(store.findById(survivor)!.theme_member_ids).toEqual([member]);
  expect(store.findById(member)!.archived).toBe(true);
});

// ── v10: qm_runs audit table + bounded dedup window + anchor/protection ──

test('ObservationsStore — migration v10 adds qm_runs audit table', () => {
  const db = new Database(join(workDir, 'observations.db'));
  const tbl = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='qm_runs'").all();
  expect(tbl.length).toBe(1);

  const cols = db.query('PRAGMA table_info(qm_runs)').all() as Array<{ name: string; dflt_value: unknown }>;
  const byName = new Map(cols.map(c => [c.name, c]));
  for (const c of ['id', 'job', 'started_at_epoch', 'finished_at_epoch',
                   'rows_scanned', 'merges', 'aborted_for_ingest']) {
    expect(byName.has(c)).toBe(true);
  }
  expect(Number(byName.get('rows_scanned')!.dflt_value)).toBe(0);
  expect(Number(byName.get('merges')!.dflt_value)).toBe(0);
  expect(Number(byName.get('aborted_for_ingest')!.dflt_value)).toBe(0);

  // v10 recorded as applied
  expect(getAppliedVersions(db).some(v => v.version === 10)).toBe(true);
  db.close();
});

// dedupCandidateWindow scopes the candidate SELECT to a recency-bounded window:
// a near-dup pair OUTSIDE the window must NOT group; a near-dup pair INSIDE must.
test('dedupCandidateWindow — only considers rows inside the recent window', () => {
  const windowLimit = 4;
  const db = new Database(join(workDir, 'observations.db'));

  // INSIDE the window: a fresh near-dup pair (most-recently surfaced).
  const inA = seedSurfaced(store, 'update-status skill command verified and available', 'discovery', 1, 0, 0, 100);
  const inB = seedSurfaced(store, 'update-status skill command is available', 'discovery', 1, 0, 0, 100);
  // Push their recency to the top of the window.
  db.query('UPDATE observations SET last_surfaced_at = ? WHERE id = ?').run(9_000, inA);
  db.query('UPDATE observations SET last_surfaced_at = ? WHERE id = ?').run(9_001, inB);

  // Filler surfaced rows that occupy window slots but don't form a dup group,
  // newer than the OUTSIDE pair so they're inside the LIMIT before it.
  for (let i = 0; i < windowLimit; i++) {
    const f = seedSurfaced(store, `distinct filler observation number ${i} alpha beta`, 'feature', 1, 0, 0, 100);
    db.query('UPDATE observations SET last_surfaced_at = ? WHERE id = ?').run(5_000 + i, f);
  }

  // OUTSIDE the window: an OLD near-dup pair (least-recently surfaced) — beyond
  // the windowLimit, so the bounded SELECT never pulls them in.
  const outA = seedSurfaced(store, 'quartermaster sweep ran to completion successfully', 'discovery', 1, 0, 0, 100);
  const outB = seedSurfaced(store, 'quartermaster sweep ran to completion ok', 'discovery', 1, 0, 0, 100);
  db.query('UPDATE observations SET last_surfaced_at = ? WHERE id = ?').run(1_000, outA);
  db.query('UPDATE observations SET last_surfaced_at = ? WHERE id = ?').run(1_001, outB);
  db.close();

  const groups = store.dedupCandidateWindow(0.5, windowLimit);

  // The INSIDE pair groups together (both are in the freshest window).
  const inGroup = groups.find(g => [g.survivor.id, ...g.members.map(m => m.id)].includes(inA));
  expect(inGroup).toBeDefined();
  expect([inGroup!.survivor.id, ...inGroup!.members.map(m => m.id)].sort((x, y) => x - y))
    .toEqual([inA, inB].sort((x, y) => x - y));

  // The OUTSIDE pair never appears — neither row was pulled into the window.
  for (const g of groups) {
    const ids = [g.survivor.id, ...g.members.map(m => m.id)];
    expect(ids.includes(outA)).toBe(false);
    expect(ids.includes(outB)).toBe(false);
  }
});

test('dedupCandidateWindow — inherits the (project, branch) scope + negation guards', () => {
  // Cross-project near-dup pair (both fresh, inside the window) must NOT group.
  const a = seedSurfacedScoped('shared exact title words here now', 'projA', null, 5);
  const b = seedSurfacedScoped('shared exact title words here now', 'projB', null, 4);
  // Negation pair in the same project — must NOT fold (shared mergeBlocked guard).
  const neg1 = seedSurfacedScoped('Inspected users table thoroughly', 'p1', null, 5);
  const neg2 = seedSurfacedScoped('users table missing thoroughly', 'p1', null, 3);

  const groups = store.dedupCandidateWindow(0.5, 100);
  for (const g of groups) {
    const ids = [g.survivor.id, ...g.members.map(m => m.id)];
    expect(ids.includes(a) && ids.includes(b)).toBe(false);      // cross-project
    expect(ids.includes(neg1) && ids.includes(neg2)).toBe(false); // negation
  }
});

test('markAnchored + isProtected — anchoring pins a row; drilled rows are protected', () => {
  const plain = mkObs(store, 'plain row');
  const anchored = mkObs(store, 'to be anchored');
  const drilled = mkObs(store, 'drilled row');

  // Unprotected at the start.
  expect(store.isProtected(plain)).toBe(false);
  expect(store.isProtected(anchored)).toBe(false);
  expect(store.isProtected(drilled)).toBe(false);

  // markAnchored sets is_anchored = 1 → protected.
  store.markAnchored(anchored);
  expect(store.findById(anchored)!.is_anchored).toBe(true);
  expect(store.isProtected(anchored)).toBe(true);

  // from_drill > 0 → protected.
  store.bumpRetrieval([drilled], 'drill', 1_000);
  expect(store.isProtected(drilled)).toBe(true);

  // A surfaced-but-not-drilled, not-anchored row is NOT protected.
  store.bumpRetrieval([plain], 'auto', 1_000);
  expect(store.isProtected(plain)).toBe(false);

  // Missing row → false.
  expect(store.isProtected(999_999)).toBe(false);
});

test('recordQmRun + latestQmRuns — records audit rows, newest first', () => {
  store.recordQmRun({
    job: 'dedup', startedAt: 1_000, finishedAt: 1_050,
    rowsScanned: 40, merges: 3, abortedForIngest: false,
  });
  store.recordQmRun({
    job: 'dedup', startedAt: 2_000, finishedAt: null,
    rowsScanned: 12, merges: 0, abortedForIngest: true,
  });

  const latest = store.latestQmRuns(1);
  expect(latest).toHaveLength(1);
  const r = latest[0]!;
  expect(r.job).toBe('dedup');
  expect(r.startedAt).toBe(2_000);
  expect(r.finishedAt).toBeNull();
  expect(r.rowsScanned).toBe(12);
  expect(r.merges).toBe(0);
  expect(r.abortedForIngest).toBe(true);   // stored 1 → boolean true

  // Both rows present, newest (id desc) first; booleans round-trip.
  const both = store.latestQmRuns(10);
  expect(both.map(x => x.startedAt)).toEqual([2_000, 1_000]);
  expect(both[1]!.finishedAt).toBe(1_050);
  expect(both[1]!.abortedForIngest).toBe(false);
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
