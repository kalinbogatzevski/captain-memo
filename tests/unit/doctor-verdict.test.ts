import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { schemaDrift, migrationVerdict, workerVerdict, embedderVerdict, captureSourceVerdict } from '../../src/cli/commands/doctor.ts';

// ---------------------------------------------------------------------------
// schemaDrift — does the live DB actually HAVE what the migrations promise?
//
// doctor judged migration health by counting rows in schema_versions. That
// count is a claim, not evidence: a migration that aborted partway was still
// recorded as applied, so doctor reported "20/20 applied ✓" while the column it
// was supposed to add did not exist and every query touching it threw.
// ---------------------------------------------------------------------------

function canonical(): Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT, from_auto INTEGER)');
  db.exec('CREATE TABLE pending_embed (id INTEGER PRIMARY KEY, last_error TEXT)');
  return db;
}

test('schemaDrift is empty when the live DB matches the canonical schema', () => {
  expect(schemaDrift(canonical(), canonical())).toEqual([]);
});

test('schemaDrift names a column the live DB is missing', () => {
  const live = new Database(':memory:');
  live.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT, from_auto INTEGER)');
  live.exec('CREATE TABLE pending_embed (id INTEGER PRIMARY KEY)');   // last_error never got added
  expect(schemaDrift(live, canonical())).toEqual(['pending_embed.last_error']);
});

test('schemaDrift names a table the live DB is missing entirely', () => {
  const live = new Database(':memory:');
  live.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT, from_auto INTEGER)');
  expect(schemaDrift(live, canonical())).toEqual(['pending_embed (table missing)']);
});

test('schemaDrift ignores extra tables and columns the live DB has on top', () => {
  const live = canonical();
  live.exec('CREATE TABLE something_local (id INTEGER PRIMARY KEY)');
  live.exec('ALTER TABLE observations ADD COLUMN experimental TEXT');
  expect(schemaDrift(live, canonical())).toEqual([]);
});

// ---------------------------------------------------------------------------
// migrationVerdict — the migration report has to reach the PASS/WARN/FAIL list.
// It was printed as loose text OUTSIDE `checks`, so a captain with pending
// migrations (or drift) still ended on "All systems go" and exit 0.
// ---------------------------------------------------------------------------

test('migrationVerdict PASSes when every migration is applied and nothing has drifted', () => {
  const c = migrationVerdict([{ label: 'observations.db', applied: 20, total: 20, drift: [] }]);
  expect(c.status).toBe('PASS');
});

test('migrationVerdict FAILs on schema drift and names the missing column', () => {
  const c = migrationVerdict([{ label: 'queue.db', applied: 3, total: 3, drift: ['pending_embed.last_error'] }]);
  expect(c.status).toBe('FAIL');
  expect(c.detail).toContain('pending_embed.last_error');
  expect(c.remedy).toBeTruthy();
});

test('migrationVerdict WARNs when migrations are merely pending', () => {
  const c = migrationVerdict([{ label: 'observations.db', applied: 18, total: 20, drift: [] }]);
  expect(c.status).toBe('WARN');
  expect(c.detail).toContain('2');
  expect(c.remedy).toBeTruthy();
});

// ---------------------------------------------------------------------------
// workerVerdict — /health green + /stats 500 is a BROKEN worker, not a nag.
// Shipping a column without a migration put every existing captain here: the
// cockpit said "captain unreachable", doctor said one remedy-less WARN and
// exited 0, and two operators had to notice before anyone looked.
// ---------------------------------------------------------------------------

test('workerVerdict FAILs with a remedy when /health is green but /stats errors', () => {
  const c = workerVerdict({ healthy: true, statsOk: false, statsError: 'no such column: last_error' });
  expect(c.status).toBe('FAIL');
  expect(c.detail).toContain('no such column: last_error');
  expect(c.remedy).toBeTruthy();
});

test('workerVerdict PASSes when both probes answer', () => {
  const c = workerVerdict({ healthy: true, statsOk: true, chunks: 42, observations: 7, project: 'p' });
  expect(c.status).toBe('PASS');
});

// ---------------------------------------------------------------------------
// embedderVerdict — a hosted endpoint was PASSed on sight, never probed. The
// default install IS a hosted endpoint, so the one backend everybody runs was
// the one doctor never checked; a 429-throttled queue reported "all good".
// ---------------------------------------------------------------------------

test('embedderVerdict WARNs and names the cause when the hosted queue is rate-limited', () => {
  const c = embedderVerdict('https://api.voyageai.com/v1/embeddings',
    { embed_pending: 19, embed_error: '429 Too Many Requests', embed_error_class: 'rate_limited' });
  expect(c.status).toBe('WARN');
  expect(c.detail).toContain('19');
  expect(c.remedy).toBeTruthy();
});

test('embedderVerdict FAILs on an auth error — retrying never fixes a bad key', () => {
  const c = embedderVerdict('https://api.voyageai.com/v1/embeddings',
    { embed_pending: 4, embed_error: '401 unauthorized', embed_error_class: 'auth' });
  expect(c.status).toBe('FAIL');
  expect(c.remedy).toBeTruthy();
});

test('embedderVerdict PASSes a hosted endpoint whose queue is draining clean', () => {
  const c = embedderVerdict('https://api.voyageai.com/v1/embeddings', { embed_pending: 0 });
  expect(c.status).toBe('PASS');
});

test('embedderVerdict cannot confirm a hosted endpoint when the worker did not answer', () => {
  const c = embedderVerdict('https://api.voyageai.com/v1/embeddings', null);
  expect(c.status).toBe('WARN');
  expect(c.detail).toContain('unverified');
});

// ---------------------------------------------------------------------------
// captureSourceVerdict — an active capture source (its session directory exists
// on this host, so the tool is installed and being used) that has ingested
// ZERO sessions means the corpus is quietly not growing. Today nothing reports
// this combination; it is the exact shape of a skipped-rollout bug and a
// mispointed transcripts dir alike.
//
// FINDING 2 (final whole-branch review): a brand-new `connect codex` + `doctor` on
// ANY fresh install lands in exactly this state, because the driver seeds a
// per-source cutoff on its first tick and deliberately skips every pre-existing
// session older than it (driver.ts). That is capture working AS DESIGNED, not a
// failure — so this used to FAIL doctor (and non-zero-exit it) on the branch's own
// onboarding path. CHANGED from FAIL to WARN, and the remedy now leads with
// `captain-memo capture backfill` — the actual fix for pre-existing sessions —
// instead of pointing straight at worker.log as if something were broken.
// ---------------------------------------------------------------------------

test('captureSourceVerdict: active source with zero ingested sessions WARNs (benign on a fresh install)', () => {
  const checks = captureSourceVerdict(['codex'], { codex: 0 }, { codex: 3 });

  expect(checks).toHaveLength(1);
  expect(checks[0]!.status).toBe('WARN');
  expect(checks[0]!.detail).toContain('codex');
  expect(checks[0]!.remedy).toBeDefined();
});

test('captureSourceVerdict: the zero-ingested remedy leads with `capture backfill`, not worker.log', () => {
  const checks = captureSourceVerdict(['codex'], { codex: 0 }, { codex: 3 });
  const remedy = checks[0]!.remedy!;

  expect(remedy.indexOf('captain-memo capture backfill')).toBeGreaterThanOrEqual(0);
  // "backfill" must come before "worker.log" — it's the first thing to try, not a footnote.
  expect(remedy.indexOf('captain-memo capture backfill')).toBeLessThan(remedy.indexOf('worker.log'));
});

test('captureSourceVerdict: the zero-ingested detail does not assert breakage', () => {
  const checks = captureSourceVerdict(['codex'], { codex: 0 }, { codex: 3 });
  // Must not claim capture IS broken — only that nothing has landed yet.
  expect(checks[0]!.detail).not.toMatch(/NOTHING has been ingested — capture is finding no transcripts/);
});

test('captureSourceVerdict: active source that has ingested sessions PASSes', () => {
  const checks = captureSourceVerdict(['codex'], { codex: 42 }, { codex: 0 });

  expect(checks).toHaveLength(1);
  expect(checks[0]!.status).toBe('PASS');
  expect(checks[0]!.detail).toContain('42');
});

test('captureSourceVerdict: no active sources yields no findings', () => {
  expect(captureSourceVerdict([], {}, {})).toHaveLength(0);
});

test('captureSourceVerdict: a source missing from the ingested map counts as zero and WARNs', () => {
  const checks = captureSourceVerdict(['agy'], {}, { agy: 2 });

  expect(checks).toHaveLength(1);
  expect(checks[0]!.status).toBe('WARN');
});

// Fix round 1: an older worker whose /stats predates this feature has NO `ingested` field at
// all — that is "unknown", not "zero". Treating it as zero FAILed every active source on sight,
// which is exactly what the live check hit against a not-yet-restarted worker. Field present but
// EMPTY (the test above) is real information (the worker enumerated it) and must still FAIL;
// field ABSENT is not, and must produce no findings at all.
test('captureSourceVerdict: ingested field entirely absent (older worker) yields no findings', () => {
  expect(captureSourceVerdict(['codex', 'agy'], undefined, { codex: 5 })).toHaveLength(0);
});

// The predicate fix: "the session directory exists" is NOT "the tool is in use".
// One abandoned rollout from months ago made a source permanently "active", so doctor
// nagged forever about a tool the machine does not run. The honest signal is whether
// there are sessions NEWER than the source's capture cutoff that produced nothing.
test('captureSourceVerdict: stale sessions older than the cutoff yield NO finding', () => {
  const checks = captureSourceVerdict(['codex'], { codex: 0 }, { codex: 0 });

  expect(checks).toHaveLength(0);
});

test('captureSourceVerdict: recent sessions with nothing ingested still WARNs', () => {
  const checks = captureSourceVerdict(['codex'], { codex: 0 }, { codex: 3 });

  expect(checks).toHaveLength(1);
  expect(checks[0]!.status).toBe('WARN');
  expect(checks[0]!.remedy).toContain('capture backfill');
});

test('captureSourceVerdict: an absent recent map yields no findings (never assert from no data)', () => {
  expect(captureSourceVerdict(['codex'], { codex: 0 }, undefined)).toHaveLength(0);
});
