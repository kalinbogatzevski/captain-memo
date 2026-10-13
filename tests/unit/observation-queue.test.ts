import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ObservationQueue } from '../../src/worker/observation-queue.ts';
import type { RawObservationEvent } from '../../src/shared/types.ts';

let workDir: string;
let queue: ObservationQueue;

const ev = (overrides: Partial<RawObservationEvent> = {}): RawObservationEvent => ({
  session_id: 'ses-1',
  project_id: 'p1',
  prompt_number: 1,
  tool_name: 'Read',
  tool_input_summary: 'file_path=/foo',
  tool_result_summary: 'returned 42 lines',
  files_read: ['/foo'],
  files_modified: [],
  ts_epoch: Math.floor(Date.now() / 1000),
  ...overrides,
});

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-q-'));
  queue = new ObservationQueue(join(workDir, 'queue.db'));
});

afterEach(() => {
  queue.close();
  rmSync(workDir, { recursive: true, force: true });
});

test('ObservationQueue — enqueue + take returns FIFO batch', () => {
  queue.enqueue(ev({ prompt_number: 1 }));
  queue.enqueue(ev({ prompt_number: 2 }));
  queue.enqueue(ev({ prompt_number: 3 }));
  const batch = queue.takeBatch(10);
  expect(batch).toHaveLength(3);
  expect(batch.map(b => b.payload.prompt_number)).toEqual([1, 2, 3]);
});

test('ObservationQueue — takeBatch marks rows processing', () => {
  queue.enqueue(ev());
  const batch = queue.takeBatch(10);
  expect(batch[0]!.status).toBe('processing');
  // A second take with no new pending rows yields empty
  expect(queue.takeBatch(10)).toHaveLength(0);
});

test('ObservationQueue — markDone removes processing rows', () => {
  queue.enqueue(ev());
  const [row] = queue.takeBatch(10);
  queue.markDone([row!.id]);
  expect(queue.pendingCount()).toBe(0);
  expect(queue.processingCount()).toBe(0);
});

test('ObservationQueue — markFailed increments retries and reverts to pending', () => {
  queue.enqueue(ev());
  const [row] = queue.takeBatch(10);
  queue.markFailed([row!.id]);
  const reread = queue.takeBatch(10);
  expect(reread).toHaveLength(1);
  expect(reread[0]!.retries).toBe(1);
});

test('ObservationQueue — markFailed at maxRetries marks failed permanently', () => {
  queue.enqueue(ev());
  for (let i = 0; i < 4; i++) {
    const batch = queue.takeBatch(10);
    if (batch.length === 0) break;
    queue.markFailed(batch.map(b => b.id), 3);
  }
  expect(queue.takeBatch(10)).toHaveLength(0);
  expect(queue.failedCount()).toBe(1);
});

test('ObservationQueue — pendingForSession lists rows by session_id', () => {
  queue.enqueue(ev({ session_id: 'a' }));
  queue.enqueue(ev({ session_id: 'b' }));
  queue.enqueue(ev({ session_id: 'a' }));
  expect(queue.pendingForSession('a')).toHaveLength(2);
  expect(queue.pendingForSession('b')).toHaveLength(1);
});

// markPermanent was right to stop retrying an auth failure, but "stop" was the whole story: nothing
// ever tried again, so a captain whose credentials lapsed for an afternoon lost every observation
// queued in that window, silently and forever. One workstation: 37 rows dead-lettered against a stale
// OAuth token, all of which summarise fine now.
test('retryFailed revives dead letters, and dry-run touches nothing', () => {
  const ids = [queue.enqueue(ev({ prompt_number: 1 })), queue.enqueue(ev({ prompt_number: 2 }))];
  queue.takeBatch(10);
  queue.markPermanent(ids, 'claude-oauth: no OAuth token');
  expect(queue.failedCount()).toBe(2);
  expect(queue.pendingCount()).toBe(0);

  const dry = queue.retryFailed({ dryRun: true });
  expect(dry.revived).toBe(2);
  expect(queue.failedCount()).toBe(2);           // nothing moved
  expect(queue.pendingCount()).toBe(0);

  const live = queue.retryFailed({});
  expect(live.revived).toBe(2);
  expect(live.failedRemaining).toBe(0);
  expect(queue.failedCount()).toBe(0);
  expect(queue.pendingCount()).toBe(2);          // drainable again
});

test('retryFailed clears the error and the retry counter, and honours --limit', () => {
  const ids = [1, 2, 3].map(n => queue.enqueue(ev({ prompt_number: n })));
  queue.takeBatch(10);
  queue.markPermanent(ids, 'boom');

  // A bounded release: each row is a real model call, so a big pile must not all fire at once.
  const first = queue.retryFailed({ limit: 2 });
  expect(first.revived).toBe(2);
  expect(first.failedRemaining).toBe(1);
  expect(queue.pendingCount()).toBe(2);

  // Revived rows come back CLEAN. A carried-over retry count would dead-letter them early on their next
  // genuine failure; a stale last_error would misreport a row that is now merely pending. last_error is
  // not on ObservationQueueRow, so read it from the table directly rather than assert nothing.
  const rows = queue.takeBatch(2);
  expect(rows.length).toBe(2);
  for (const r of rows) expect(r.retries).toBe(0);
  const errs = (queue as unknown as { db: { query(s: string): { all(): Array<{ id: number; status: string; last_error: string | null }> } } }).db
    .query(`SELECT id, status, last_error FROM observation_queue ORDER BY id`).all();
  // The two RELEASED rows are clean; the one left behind by --limit keeps its error, which is what makes
  // `still dead-lettered` legible on the next run rather than a silent blank.
  expect(errs.filter(r => r.last_error === null).length).toBe(2);
  expect(errs.filter(r => r.status === 'failed' && r.last_error === 'boom').length).toBe(1);
});

test('retryFailed is a no-op when nothing is dead-lettered', () => {
  queue.enqueue(ev());
  const r = queue.retryFailed({});
  expect(r.revived).toBe(0);
  expect(queue.pendingCount()).toBe(1);          // pending rows are untouched
});
