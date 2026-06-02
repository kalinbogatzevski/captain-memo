// tests/unit/summarizer-backoff.test.ts — the policy that makes the obs-batch
// summarizer DELAY its queries when the Anthropic API is overloaded/down, instead
// of hammering it every 5s (field 2026-06-02: bursts of HTTP 529 overloaded_error).
import { test, expect } from 'bun:test';
import { classifySummarizeFailure, computeBackoffMs } from '../../src/worker/summarizer-backoff.ts';

// ---- classifySummarizeFailure ----------------------------------------------

test('HTTP 529 / 503 / 500 / 502 / 504 → overloaded (back off, never dead-letter)', () => {
  for (const s of [500, 502, 503, 504, 529]) {
    expect(classifySummarizeFailure(`claude-oauth: HTTP ${s}: ...`, s)).toBe('overloaded');
  }
});

test('429 (rate limit) and 408 (request timeout) → overloaded', () => {
  expect(classifySummarizeFailure('HTTP 429', 429)).toBe('overloaded');
  expect(classifySummarizeFailure('HTTP 408', 408)).toBe('overloaded');
});

test('401 / 403 / 400 / 404 → permanent (dead-letter; never succeeds on retry)', () => {
  for (const s of [400, 401, 403, 404]) {
    expect(classifySummarizeFailure(`HTTP ${s}`, s)).toBe('permanent');
  }
});

test('status is authoritative — a 529 body containing "400" is NOT misread as permanent', () => {
  // Regression: classifying on the message body would false-positive on digits in
  // the JSON error body. The status (529) must win.
  expect(classifySummarizeFailure('HTTP 529: {"error":{"code":400,"x":401}}', 529)).toBe('overloaded');
});

test('statusless network/timeout errors → overloaded', () => {
  expect(classifySummarizeFailure('worker /x failed: Unable to connect. Is the computer...')).toBe('overloaded');
  expect(classifySummarizeFailure('request timed out')).toBe('overloaded');
  expect(classifySummarizeFailure('fetch failed: ECONNREFUSED')).toBe('overloaded');
});

test('statusless auth/token errors → permanent', () => {
  expect(classifySummarizeFailure('claude-oauth: no OAuth token found ...')).toBe('permanent');
});

test('schema/JSON parse failures (no status) → retryable (per-item, bounded retries)', () => {
  expect(classifySummarizeFailure('Summarizer: failed to parse JSON: Unexpected end of input')).toBe('retryable');
  expect(classifySummarizeFailure('Summarizer: response failed schema validation: ...')).toBe('retryable');
});

// ---- computeBackoffMs -------------------------------------------------------

test('first failure backs off ~base (full jitter band [base/2, base])', () => {
  const lo = computeBackoffMs(1, 0, { jitter: () => 0 });
  const hi = computeBackoffMs(1, 0, { jitter: () => 1 });
  expect(lo).toBe(7_500);   // 15000/2
  expect(hi).toBe(15_000);  // 15000
});

test('backoff grows exponentially with the streak', () => {
  expect(computeBackoffMs(2, 0, { jitter: () => 1 })).toBe(30_000);
  expect(computeBackoffMs(3, 0, { jitter: () => 1 })).toBe(60_000);
});

test('backoff is capped (a long outage never waits more than the cap)', () => {
  expect(computeBackoffMs(20, 0, { jitter: () => 1 })).toBe(600_000); // cap
});

test('a longer server Retry-After wins over the computed backoff', () => {
  // streak 1 would be ≤15s; a 2-minute Retry-After must dominate.
  expect(computeBackoffMs(1, 120_000, { jitter: () => 1 })).toBe(120_000);
});
