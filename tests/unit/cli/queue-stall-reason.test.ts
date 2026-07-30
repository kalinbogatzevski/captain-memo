import { test, expect } from 'bun:test';
import { queueTailFor } from '../../../src/cli/stats-render.ts';

// "2,949 observations stuck behind a dead summarizer must never look like idle" — the existing comment
// on queueTail. It got half the job done: the COUNT is shown, the CAUSE never was. A user seeing 30,000
// waiting has no way to tell "it is working through a backlog" from "nothing will ever process this".
// /stats has carried summarizer.last_error since it was added and nothing rendered it.
const q = (over: Record<string, unknown> = {}) =>
  ({ total: 100, queue_pending: 30000, queue_processing: 0, queue_failed: 0, ...over }) as never;

test('a backlog with a healthy summarizer reads as work in progress', () => {
  const s = queueTailFor(q(), { available: true, last_error: null, cooldown_ms: 0 });
  expect(s).toMatch(/30.000/);   // fmtCount separates with a thin space, not a comma
  expect(s).toContain('waiting');
  expect(s).not.toMatch(/stalled|never/i);
});

test('NO summarizer says so — the queue cannot drain at all', () => {
  const s = queueTailFor(q(), { available: false, last_error: null, cooldown_ms: 0 });
  expect(s).toMatch(/no summarizer/i);
  expect(s).toMatch(/stalled/i);
});

test('a summarizer in cooldown reports the wait, not silence', () => {
  const s = queueTailFor(q(), { available: true, last_error: '429 overloaded', cooldown_ms: 45_000 });
  expect(s).toMatch(/retry|cooldown/i);
  expect(s).toContain('429 overloaded');
});

test('an empty queue renders nothing regardless of summarizer state', () => {
  expect(queueTailFor(q({ queue_pending: 0 }), { available: false, last_error: null, cooldown_ms: 0 })).toBe('');
});
