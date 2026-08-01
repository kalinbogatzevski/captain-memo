// src/worker/idle.ts — pure "is this machine actually idle?" predicate.
//
// The semantic consolidation pass is a whole-corpus O(n²) scan (measured ~50s on a 124k-row
// corpus: 18s to load vectors, 33s for 15.1M in-partition dot products). Nothing about it is
// unsafe — every guard the hourly sweep applies still applies — but it competes for CPU with
// whatever the user is doing, so it waits for a genuinely quiet machine.
//
// Deliberately signal-based rather than clock-based. A fixed nightly window fires happily while
// you are working late; "no ingest, no queue, no live co-session, and nothing has happened for
// N minutes" self-regulates — a busy week simply defers the pass, and it costs nothing to skip.

export interface IdleSignals {
  /** A summarizer batch is in flight (worker's processBatchPromise). */
  ingestActive: boolean;
  /** Observations waiting to be summarized. */
  queuePending: number;
  /** Seconds since the most recent observation was created or surfaced.
   *  Infinity when the corpus has never recorded activity (fresh install). */
  secondsSinceLastActivity: number;
  /** Live co-sessions this captain is running on sibling AIs. */
  activeSessions: number;
}

export interface IdleConfig {
  /** Hard floor: nothing may start until the machine has been quiet this long. */
  minIdleSeconds: number;
}

/**
 * True only when every signal agrees the machine is unused.
 *
 * The floor is the important one. The other three catch work that is running RIGHT NOW; the
 * floor catches the user who is reading, thinking, or halfway through a sentence — the case
 * where every instantaneous signal reads clear and starting a long scan is still wrong.
 */
export function isIdle(s: IdleSignals, cfg: IdleConfig): boolean {
  if (s.ingestActive) return false;
  if (s.queuePending > 0) return false;
  if (s.activeSessions > 0) return false;
  return s.secondsSinceLastActivity >= cfg.minIdleSeconds;
}
