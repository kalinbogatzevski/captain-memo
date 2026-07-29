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
