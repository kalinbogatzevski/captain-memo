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
  workDir = mkdtempSync(join(tmpdir(), 'aelita-q-'));
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
