import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PendingEmbedQueue } from '../../src/worker/pending-embed-queue.ts';

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
  q.markRetried(due.map(r => r.id), 60_000); // 60s
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
