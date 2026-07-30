import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ObservationQueue } from '../../src/worker/observation-queue.ts';
import type { RawObservationEvent } from '../../src/shared/types.ts';

// observation_queue never deleted anything — markDone only flips status. One live install reached
// 235,899 done rows in a 610.9 MB queue.db, all of it work already finished and written to
// observations.db. It grows forever on every install.
//
// The one thing that reads done rows is dedupePending, which uses them to recognise "this turn was
// already summarised". So retention is a real trade, not free: prune too eagerly and the repair tool
// goes blind. The window is generous by default and configurable, and the repair still catches
// duplicate-of-pending regardless.
function q() {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ret-'));
  return { queue: new ObservationQueue(join(dir, 'queue.db')), dir, path: join(dir, 'queue.db') };
}
const ev = (s: string, p: number): RawObservationEvent => ({
  session_id: s, project_id: 'p', prompt_number: p, tool_name: 't',
  tool_input_summary: 'x'.repeat(500), tool_result_summary: 'y'.repeat(500),
  files_read: [], files_modified: [], ts_epoch: 0, origin_agent: 'codex',
});
const DAY = 86_400;

test('prunes done rows older than the window, keeps recent ones', () => {
  const { queue, dir } = q();
  const now = Math.floor(Date.now() / 1000);
  const old = queue.enqueue(ev('s1', 1));
  const recent = queue.enqueue(ev('s1', 2));
  queue.takeBatch(10);
  queue.markDone([old, recent]);
  queue._setProcessedAt(old, now - 30 * DAY);      // finished a month ago
  queue._setProcessedAt(recent, now - 1 * DAY);    // finished yesterday

  const removed = queue.pruneDone(now - 14 * DAY);
  expect(removed).toBe(1);
  expect(queue.doneCount()).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test('NEVER prunes pending, processing, or failed work', () => {
  const { queue, dir } = q();
  const now = Math.floor(Date.now() / 1000);
  queue.enqueue(ev('s1', 1));                       // pending
  const inflight = queue.enqueue(ev('s1', 2));
  queue.takeBatch(1);                               // one row now processing
  expect(queue.pruneDone(now + DAY)).toBe(0);       // window covers everything, yet nothing goes
  expect(queue.pendingCount()).toBeGreaterThan(0);
  expect(inflight).toBeGreaterThan(0);
  rmSync(dir, { recursive: true, force: true });
});

test('reclaims disk — a DELETE alone leaves the file just as large', () => {
  const { queue, dir, path } = q();
  const now = Math.floor(Date.now() / 1000);
  const ids: number[] = [];
  for (let i = 0; i < 2000; i++) ids.push(queue.enqueue(ev('s' + i, 1)));
  queue.takeBatch(5000); queue.markDone(ids);
  for (const id of ids) queue._setProcessedAt(id, now - 30 * DAY);
  const before = statSync(path).size;

  queue.pruneDone(now - 14 * DAY);
  queue.reclaim();
  const after = statSync(path).size;

  expect(queue.doneCount()).toBe(0);
  expect(after).toBeLessThan(before / 2);   // the file actually shrank, not just the row count
  rmSync(dir, { recursive: true, force: true });
});
