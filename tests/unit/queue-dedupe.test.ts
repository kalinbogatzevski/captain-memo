import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ObservationQueue } from '../../src/worker/observation-queue.ts';
import type { RawObservationEvent } from '../../src/shared/types.ts';

// The capture bug re-enqueued a growing session's whole history every tick, so an affected install has
// tens of thousands of pending rows that are re-summarisations of turns it already holds. Each one is a
// real LLM call, so draining them costs money for nothing.
//
// Identity is (session_id, prompt_number) — "1-based index within the session", stable across
// re-extracts of an append-only log. NOT the whole payload: codex-source seeds its clock from now()
// when a session carries no timestamps, so ts_epoch can differ between extracts of the same turn.
function q() {
  const dir = mkdtempSync(join(tmpdir(), 'cm-q-'));
  return { queue: new ObservationQueue(join(dir, 'queue.db')), dir };
}
const ev = (session: string, prompt: number, ts = 0): RawObservationEvent => ({
  session_id: session, project_id: 'p', prompt_number: prompt, tool_name: 't',
  tool_input_summary: '', tool_result_summary: '', files_read: [], files_modified: [],
  ts_epoch: ts, origin_agent: 'codex',
});

test('dry run reports what it WOULD delete and changes nothing', () => {
  const { queue, dir } = q();
  queue.enqueue(ev('s1', 1)); queue.enqueue(ev('s1', 1)); queue.enqueue(ev('s1', 2));
  const before = queue.pendingCount();
  const r = queue.dedupePending({ apply: false });
  expect(r.duplicate_pending).toBe(1);
  expect(queue.pendingCount()).toBe(before);   // untouched
  queue.close();   // Windows cannot unlink an open file; POSIX can, which hid this
  rmSync(dir, { recursive: true, force: true });
});

test('keeps ONE pending row per (session, prompt) and drops the rest', () => {
  const { queue, dir } = q();
  for (let i = 0; i < 5; i++) queue.enqueue(ev('s1', 1, i));   // same turn, five re-extracts
  queue.enqueue(ev('s1', 2));
  queue.dedupePending({ apply: true });
  expect(queue.pendingCount()).toBe(2);        // turn 1 once, turn 2 once
  queue.close();   // Windows cannot unlink an open file; POSIX can, which hid this
  rmSync(dir, { recursive: true, force: true });
});

test('drops a pending row whose turn was ALREADY summarised (status done)', () => {
  const { queue, dir } = q();
  const id = queue.enqueue(ev('s1', 1));
  queue.takeBatch(10); queue.markDone([id]);   // turn 1 already processed
  queue.enqueue(ev('s1', 1));                  // the re-extracted copy
  queue.enqueue(ev('s1', 2));                  // genuinely new
  const r = queue.dedupePending({ apply: true });
  expect(r.duplicate_of_done).toBe(1);
  expect(queue.pendingCount()).toBe(1);        // only the new turn survives
  queue.close();   // Windows cannot unlink an open file; POSIX can, which hid this
  rmSync(dir, { recursive: true, force: true });
});

test('NEVER touches rows that are in flight', () => {
  const { queue, dir } = q();
  queue.enqueue(ev('s1', 1)); queue.enqueue(ev('s1', 1));
  queue.takeBatch(1);                           // one row is now 'processing'
  queue.dedupePending({ apply: true });
  // the in-flight row is untouched and its pending twin is left alone too — a row being summarised
  // right now must not have its only sibling deleted out from under the worker.
  expect(queue.pendingCount()).toBe(1);
  queue.close();   // Windows cannot unlink an open file; POSIX can, which hid this
  rmSync(dir, { recursive: true, force: true });
});

test('a queue with no duplicates is left entirely alone', () => {
  const { queue, dir } = q();
  queue.enqueue(ev('s1', 1)); queue.enqueue(ev('s1', 2)); queue.enqueue(ev('s2', 1));
  const r = queue.dedupePending({ apply: true });
  expect(r.duplicate_pending + r.duplicate_of_done).toBe(0);
  expect(queue.pendingCount()).toBe(3);
  queue.close();   // Windows cannot unlink an open file; POSIX can, which hid this
  rmSync(dir, { recursive: true, force: true });
});
