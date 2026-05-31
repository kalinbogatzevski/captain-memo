import { test, expect } from 'bun:test';
import { workerFailureMessage } from '../../src/hooks/shared.ts';

// `workerFetch` never throws — it returns a structured {ok,status,timedOut,errorMessage}.
// Before v0.2.13 three handlers discarded that result entirely, so a worker outage
// (down / 500 / timeout) silently froze observation capture with NOTHING in hook.log —
// the same disease as the v0.2.3 dispatch regression, but undebuggable. workerFailureMessage
// turns a non-OK result into a log line; these tests pin its shape (and that an OK result
// stays silent, so we never spam the log on the happy path).

test('workerFailureMessage: ok result → null (no log noise on success)', () => {
  expect(
    workerFailureMessage('/x', { ok: true, status: 200, body: {}, timedOut: false, errorMessage: null }),
  ).toBeNull();
});

test('workerFailureMessage: timeout → mentions the path and "timed out"', () => {
  const m = workerFailureMessage('/stats', {
    ok: false, status: 0, body: null, timedOut: true, errorMessage: 'The operation was aborted',
  });
  expect(m).toContain('/stats');
  expect(m).toContain('timed out');
});

test('workerFailureMessage: HTTP/network error → mentions the path and the detail', () => {
  const m = workerFailureMessage('/observation/enqueue', {
    ok: false, status: 500, body: null, timedOut: false, errorMessage: '500: kaboom',
  });
  expect(m).toContain('/observation/enqueue');
  expect(m).toContain('500');
});

test('workerFailureMessage: non-ok with no errorMessage falls back to status', () => {
  const m = workerFailureMessage('/inject/context', {
    ok: false, status: 503, body: null, timedOut: false, errorMessage: null,
  });
  expect(m).toContain('503');
});
