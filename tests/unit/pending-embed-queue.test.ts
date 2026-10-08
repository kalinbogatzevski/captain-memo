import { Database } from 'bun:sqlite';
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PendingEmbedQueue, classifyEmbedError, type EmbedErrorClass } from '../../src/worker/pending-embed-queue.ts';

let workDir: string;
let q: PendingEmbedQueue;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-pe-'));
  q = new PendingEmbedQueue(join(workDir, 'pending.db'));
});

afterEach(() => {
  q.close();
  rmSync(workDir, { recursive: true, force: true });
});

test('PendingEmbedQueue — enqueue + listDue returns due rows', () => {
  q.enqueue({ chunk_id: 'memory:foo:abc', source_path: '/a/foo.md', sha: 'sha1', channel: 'memory' });
  q.enqueue({ chunk_id: 'memory:bar:xyz', source_path: '/a/bar.md', sha: 'sha2', channel: 'memory' });
  const due = q.listDue(10);
  expect(due).toHaveLength(2);
  expect(due[0]!.chunk_id).toBe('memory:foo:abc');
});

test('PendingEmbedQueue — markRetried bumps next_retry_at into the future', () => {
  q.enqueue({ chunk_id: 'c1', source_path: '/p', sha: 's', channel: 'memory' });
  const due = q.listDue(10);
  q.markRetried(due.map(r => r.id)); // per-row exponential backoff → next_retry in the future
  // No rows due now
  expect(q.listDue(10)).toHaveLength(0);
});

test('PendingEmbedQueue — markEmbedded removes the row', () => {
  q.enqueue({ chunk_id: 'c1', source_path: '/p', sha: 's', channel: 'memory' });
  const due = q.listDue(10);
  q.markEmbedded(due.map(r => r.id));
  expect(q.listDue(10)).toHaveLength(0);
  expect(q.totalCount()).toBe(0);
});

test('PendingEmbedQueue — enqueue is idempotent on (chunk_id)', () => {
  q.enqueue({ chunk_id: 'c1', source_path: '/p', sha: 's1', channel: 'memory' });
  q.enqueue({ chunk_id: 'c1', source_path: '/p', sha: 's2', channel: 'memory' });
  expect(q.totalCount()).toBe(1);
  // Latest sha wins
  const due = q.listDue(10);
  expect(due[0]!.sha).toBe('s2');
});

// ---- why a chunk failed, not just that it did -----------------------------------------
// Reported from a real install: the cockpit showed "19 failed" and the operator had to open
// worker.log and get an AI to interpret it. The cause was a Voyage free-tier rate limit —
// HTTP 429, "you have not yet added your payment method … 3 RPM" — which is a configuration
// state the operator can fix, not a defect. The queue retried correctly the whole time; it
// simply never recorded WHY, so a self-explaining state rendered as an opaque failure count.

test('a failure records its reason and class, not just a retry count', () => {
  const db = new PendingEmbedQueue(':memory:');
  db.enqueue({ chunk_id: 'c1', source_path: '/p', sha: 'a', channel: 'observation' });
  const due = db.listDue(10);
  expect(due).toHaveLength(1);

  db.markRetried(due.map(r => r.id), 'Embedder HTTP 429: {"detail":"You have not yet added your payment method"}');
  const st = db.failureState();
  expect(st.pending).toBe(1);
  expect(st.last_error).toContain('429');
  expect(st.error_class).toBe('rate_limited');   // actionable, not just "failed"
});

test('failure classes are distinguished, because the remedies differ', () => {
  const cases: [string, EmbedErrorClass][] = [
    ['Embedder HTTP 429: rate limit', 'rate_limited'],
    ['Embedder HTTP 401: invalid api key', 'auth'],
    ['Embedder HTTP 500: upstream boom', 'unreachable'],
    ['fetch failed: ECONNREFUSED', 'unreachable'],
    ['something else entirely', 'other'],
  ];
  for (const [msg, want] of cases) {
    expect(classifyEmbedError(msg)).toBe(want);
  }
});

test('a queue with nothing failing reports no error at all', () => {
  // An empty state must not render as a scary blank or a stale message.
  const db = new PendingEmbedQueue(':memory:');
  const st = db.failureState();
  expect(st.pending).toBe(0);
  expect(st.last_error).toBeNull();
  expect(st.error_class).toBeNull();
});

test('a database created BEFORE the error columns existed is migrated, not broken', () => {
  // CREATE TABLE IF NOT EXISTS does NOT add columns to a table that already exists. Adding
  // last_error/last_error_at_epoch to the schema therefore did nothing on every install that
  // already had the table — and failureState() then queried a column that was not there, so
  // /stats returned 500 and the cockpit reported the captain unreachable. Shipped, and it
  // took two operators reporting it to surface. New columns need a migration, every time.
  const dir = mkdtempSync(join(tmpdir(), 'cm-pe-mig-'));
  const path = join(dir, 'pending_embed.db');
  try {
    // Build the OLD table exactly as it shipped, then open the queue over it.
    const old = new Database(path);
    old.exec(`CREATE TABLE pending_embed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id TEXT NOT NULL UNIQUE,
      source_path TEXT NOT NULL,
      sha TEXT NOT NULL,
      channel TEXT NOT NULL,
      retries INTEGER NOT NULL DEFAULT 0,
      next_retry_at_epoch INTEGER NOT NULL,
      enqueued_at_epoch INTEGER NOT NULL
    );`);
    old.close();

    const q = new PendingEmbedQueue(path);
    q.enqueue({ chunk_id: 'c1', source_path: '/p', sha: 'a', channel: 'observation' });
    const due = q.listDue(10);
    q.markRetried(due.map(r => r.id), 'Embedder HTTP 429: rate limit');
    const st = q.failureState();            // this threw "no such column: last_error"
    expect(st.pending).toBe(1);
    expect(st.error_class).toBe('rate_limited');
    q.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #226(c): one permanently failing chunk held back its whole batch.
import { embedIsolating, isPerInputEmbedError, PARKED_RETRY_SEC } from '../../src/worker/pending-embed-queue.ts';

const refuse = (bad: number[]) => {
  const calls: number[][] = [];
  const embed = async (rows: number[]) => {
    calls.push(rows);
    if (rows.some(r => bad.includes(r))) throw new Error('Embedder HTTP 400: input rejected');
    return rows.map(r => [r]);
  };
  return { calls, embed };
};

test('embedIsolating — embeds everything but the one bad row, which fails alone', async () => {
  const { calls, embed } = refuse([13]);
  const rows = Array.from({ length: 25 }, (_, i) => i);
  const r = await embedIsolating(rows, embed);
  expect(r.embedded.map(e => e.row).sort((a, b) => a - b)).toEqual(rows.filter(i => i !== 13));
  expect(r.embedded.every(e => e.embedding[0] === e.row)).toBe(true);      // each row kept its own vector
  expect(r.failed.map(f => [f.row, f.alone])).toEqual([[13, true]]);
  expect(calls.length).toBeLessThanOrEqual(12);
});

test('embedIsolating — an outage is one call, never a split', async () => {
  for (const msg of ['Embedder HTTP 429: rate limited', 'Embedder HTTP 503: down', 'fetch failed', 'The operation was aborted',
    'Unable to connect. Is the computer able to access the url?']) {
    let calls = 0;
    const r = await embedIsolating([1, 2, 3, 4], async () => { calls++; throw new Error(msg); });
    expect(calls).toBe(1);
    expect(r.failed.map(f => f.alone)).toEqual([false, false, false, false]);
    expect(isPerInputEmbedError(new Error(msg))).toBe(false);
  }
});

test('embedIsolating — stops at the call budget; rows it did not reach are failed, not lost', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => i);
  const { calls, embed } = refuse(rows);                                    // every row is bad
  const r = await embedIsolating(rows, embed, undefined, 12);
  expect(calls.length).toBe(12);
  expect(r.embedded).toEqual([]);
  expect(r.failed.map(f => f.row).sort((a, b) => a - b)).toEqual(rows);
});

test('PendingEmbedQueue — park takes a row out of the retry loop for a day and counts it', () => {
  q.enqueue({ chunk_id: 'c1', source_path: '/p', sha: 's', channel: 'memory' });
  q.enqueue({ chunk_id: 'c2', source_path: '/p', sha: 's', channel: 'memory' });
  const [first] = q.listDue(10);
  q.park([first!.id], 'input rejected');
  expect(q.listDue(10).map(r => r.chunk_id)).toEqual(['c2']);
  expect(q.failureState()).toMatchObject({ pending: 2, parked: 1, last_error: 'input rejected' });
  const raw = new Database(join(workDir, 'pending.db'), { readonly: true });
  const row = raw.query('SELECT next_retry_at_epoch AS n, dead_at_epoch AS d FROM pending_embed WHERE chunk_id = ?').get('c1') as { n: number; d: number };
  raw.close();
  expect(row.n - row.d).toBe(PARKED_RETRY_SEC);
});

test('PendingEmbedQueue — an existing table without dead_at_epoch is migrated, not broken', () => {
  const path = join(workDir, 'old.db');
  const old = new Database(path);
  old.exec(`CREATE TABLE pending_embed (id INTEGER PRIMARY KEY AUTOINCREMENT, chunk_id TEXT NOT NULL UNIQUE,
    source_path TEXT NOT NULL, sha TEXT NOT NULL, channel TEXT NOT NULL, retries INTEGER NOT NULL DEFAULT 0,
    next_retry_at_epoch INTEGER NOT NULL, enqueued_at_epoch INTEGER NOT NULL, last_error TEXT, last_error_at_epoch INTEGER)`);
  old.close();
  const upgraded = new PendingEmbedQueue(path);
  expect(upgraded.failureState().parked).toBe(0);
  upgraded.close();
});

import { shouldParkAfterTimeouts, PENDING_EMBED_MAX_ATTEMPTS } from '../../src/worker/pending-embed-queue.ts';

test('a row that keeps hitting our own timeout is parked after the last allowed attempt, not before', () => {
  const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  expect(shouldParkAfterTimeouts(abort, PENDING_EMBED_MAX_ATTEMPTS - 2)).toBe(false);
  expect(shouldParkAfterTimeouts(abort, PENDING_EMBED_MAX_ATTEMPTS - 1)).toBe(true);
});

test('only a timeout parks that way: an outage (5xx) or a throttle never does', () => {
  expect(shouldParkAfterTimeouts(new Error('Embedder HTTP 503: down'), 500)).toBe(false);
  expect(shouldParkAfterTimeouts(new Error('Embedder HTTP 429: slow down'), 500)).toBe(false);
});
