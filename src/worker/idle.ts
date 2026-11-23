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
  return blockingSignals(s).length === 0 && s.secondsSinceLastActivity >= cfg.minIdleSeconds;
}

/**
 * The live signals holding a pass back RIGHT NOW, for display. Deliberately excludes the idle
 * floor: that one is a countdown, not a blocker, and conflating them would either show a timer
 * that cannot reach zero or hide a real reason behind one.
 *
 * Shares its list with isIdle so the countdown can never disagree with the gate it describes.
 */
export function blockingSignals(s: IdleSignals): string[] {
  const out: string[] = [];
  if (s.ingestActive) out.push('summarizing');
  if (s.queuePending > 0) out.push('queue');
  if (s.activeSessions > 0) out.push('co-session');
  return out;
}

/**
 * Sleep/resume detector. Timers do not fire while a laptop sleeps, so the first look after a wake sees a wall-clock
 * gap far longer than the heartbeat; that moment counts as activity. Without it, idle age = now minus the last
 * observation, and a wake after a night's sleep reads as hours of quiet: every idle-gated pass started at once.
 *
 * `look` is called by the heartbeat AND by every gate before it reads, so a gate that fires first after a wake still
 * sees the gap. An event-loop stall longer than the threshold also counts; that only defers a pass.
 */
export function resumeWatch(heartbeatMs: number, now: () => number = Date.now): { look: () => number | null } {
  let lastLook = now();
  let resumedAtMs: number | null = null;
  return {
    /** Records this look; returns the wall-clock ms of the latest detected resume, or null. */
    look() {
      const t = now();
      if (t - lastLook > 3 * heartbeatMs) resumedAtMs = t;
      lastLook = t;
      return resumedAtMs;
    },
  };
}

/** Seconds of quiet: since the last observation, or since the last resume when that is more recent. */
export function quietSeconds(nowS: number, lastActivityEpoch: number | null, resumedAtMs: number | null): number {
  const last = Math.max(lastActivityEpoch ?? -Infinity, resumedAtMs == null ? -Infinity : Math.floor(resumedAtMs / 1000));
  return Number.isFinite(last) ? Math.max(0, nowS - last) : Infinity;
}
