import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { schemaDrift, migrationVerdict, workerVerdict, embedderVerdict } from '../../src/cli/commands/doctor.ts';

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
