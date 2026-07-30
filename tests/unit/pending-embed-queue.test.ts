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
