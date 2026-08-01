import { test, expect, describe } from 'bun:test';
import { isIdle, type IdleSignals } from '../../../src/worker/idle.ts';

// The semantic pass is a whole-corpus O(n²) scan (measured: ~50s on 124k rows). It must never
// run while the machine is in use — not because it would corrupt anything (every guard the
// hourly sweep applies still applies) but because it competes for CPU with the session the
// user is actually in. "When I'm dreaming for real" is the design brief.

const base: IdleSignals = {
  ingestActive: false,
  queuePending: 0,
  secondsSinceLastActivity: 3600,
  activeSessions: 0,
};
const cfg = { minIdleSeconds: 1800 };

describe('isIdle', () => {
  test('idle when nothing is running and activity is old', () => {
    expect(isIdle(base, cfg)).toBe(true);
  });

  test('NOT idle while a summarizer batch is in flight', () => {
    expect(isIdle({ ...base, ingestActive: true }, cfg)).toBe(false);
  });

  test('NOT idle with queued observations', () => {
    expect(isIdle({ ...base, queuePending: 1 }, cfg)).toBe(false);
  });

  // The hard floor. A session that has been quiet for a few minutes is a user thinking, not a
  // user gone — starting a 50-second scan under them is exactly the thing to avoid.
  test('NOT idle when activity is more recent than the floor', () => {
    expect(isIdle({ ...base, secondsSinceLastActivity: 1799 }, cfg)).toBe(false);
    expect(isIdle({ ...base, secondsSinceLastActivity: 1800 }, cfg)).toBe(true);
  });

  // A live co-session is another AI working on this machine, mid-task. Its own prompts may not
  // touch this worker's activity clock at all, so the count is checked separately.
  test('NOT idle while a co-session is live', () => {
    expect(isIdle({ ...base, activeSessions: 1 }, cfg)).toBe(false);
  });

  // Never-active corpus (fresh install): no activity timestamp yet must read as idle, not as
  // "active 0 seconds ago", or the pass could never run on a new machine.
  test('treats an unknown activity time as idle', () => {
    expect(isIdle({ ...base, secondsSinceLastActivity: Number.POSITIVE_INFINITY }, cfg)).toBe(true);
  });

  test('a zero floor still respects the live signals', () => {
    const c = { minIdleSeconds: 0 };
    expect(isIdle({ ...base, secondsSinceLastActivity: 0 }, c)).toBe(true);
    expect(isIdle({ ...base, secondsSinceLastActivity: 0, ingestActive: true }, c)).toBe(false);
  });
});
