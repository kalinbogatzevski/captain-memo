// src/shared/worker-transition.ts — the "this worker is down ON PURPOSE" breadcrumb.
//
// An unreachable worker used to be indistinguishable from a dead one, so a hook that found
// nothing listening on :PORT force-reclaimed it — hard-killing a worker that was eight seconds
// into its own boot and, on win32, racing the updater's OWN detached WMI relauncher for the
// port. The same blindness reached the user as "⚓ worker unreachable — memory is paused this
// session", which reads as a break: sessions got closed and reopened by hand over a restart
// that would have finished by itself. (Field report, Windows federation captain, 2026-09-01.)
//
// So the worker now says which it is. Two phases, written at the only two moments a healthy
// captain is legitimately not answering:
//   • 'updating' — written SYNCHRONOUSLY by the OUTGOING worker just before it arms the relaunch
//     and exits. It carries from/to so the banner can name the versions. This is the window the
//     update lock does NOT cover: withUpdateLock is released after ff+install, before the restart.
//   • 'booting'  — written by the INCOMING worker before it opens the port, cleared once it is
//     listening. Covers a slow cold start (win32 wscript→bun ≈10s) as well as every restart path,
//     including ones nothing else knows about.
//
// A fresh breadcrumb means "wait, do not kill" to every self-heal path, and gives the SessionStart
// banner something honest to say instead of "unreachable".
//
// ponytail: a TTL, not a liveness check — a crashed holder pauses self-heal for at most
// TRANSITION_TTL_MS (then normal recovery resumes on its own). Upgrade path if that ever bites:
// stamp the relauncher/worker PID in the file and treat a dead PID as immediately stale.
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { DATA_DIR } from './paths.ts';

export const TRANSITION_PATH = join(DATA_DIR, '.worker-transition');

/** A breadcrumb older than this is treated as a crashed holder and ignored, so a genuinely dead
 *  worker is never shielded from recovery for longer than this. Sized well above the real windows
 *  it covers (win32 relaunch: port-free wait 20s + Start-ScheduledTask retry loop 30s; cold boot
 *  ≈10s), and well below the 5-minute watchdog cadence. */
export const TRANSITION_TTL_MS = 120_000;

export interface WorkerTransition {
  phase: 'booting' | 'updating';
  /** Versions, when known (the 'updating' path knows both; 'booting' knows neither). */
  from?: string;
  to?: string;
  /** Epoch ms the breadcrumb was written. */
  ts: number;
}

/** Drop the breadcrumb. Synchronous on purpose — the 'updating' caller exits immediately after,
 *  so an async write would never land. Best-effort: never throws, never blocks a restart. */
export function markTransition(
  t: Omit<WorkerTransition, 'ts'>,
  path: string = TRANSITION_PATH,
  now: number = Date.now(),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...t, ts: now }), 'utf-8');
  } catch { /* a missing breadcrumb only costs us the old (wrong) behaviour */ }
}

/** The live breadcrumb, or null when there is none / it is unreadable / it has gone stale. */
export function readTransition(
  path: string = TRANSITION_PATH,
  now: number = Date.now(),
): WorkerTransition | null {
  try {
    const t = JSON.parse(readFileSync(path, 'utf-8')) as WorkerTransition;
    if (t.phase !== 'booting' && t.phase !== 'updating') return null;
    if (!Number.isFinite(t.ts) || now - t.ts > TRANSITION_TTL_MS) return null;
    return t;
  } catch {
    return null;
  }
}

/** Remove the breadcrumb — the worker is serving again. Idempotent. */
export function clearTransition(path: string = TRANSITION_PATH): void {
  try { unlinkSync(path); } catch { /* already gone */ }
}

// ── "this session was told memory was down" flag ───────────────────────────────────────────────
// SessionStart's banner is a ONE-SHOT statement: nothing ever revises it, so a session that opened
// during a restart keeps reading "memory is paused" long after the worker came back — the other
// half of why the session gets closed and reopened. SessionStart raises this flag when it reports
// degraded/transitioning; the Stop hook lowers it the first time the worker answers again and says
// so. Per session, so one session's notice can't be eaten by another's.

const DEGRADED_PREFIX = '.degraded-';
/** Flags older than this are litter from a session that never stopped — pruned, never announced. */
const DEGRADED_MAX_AGE_MS = 24 * 60 * 60_000;

function degradedPath(sessionId: string, dataDir: string): string {
  return join(dataDir, `${DEGRADED_PREFIX}${sessionId.replace(/[^a-zA-Z0-9_-]/g, '')}`);
}

/** Record that THIS session was told memory is unavailable. Also prunes day-old flags so a session
 *  that never reaches a Stop hook can't litter DATA_DIR indefinitely. Best-effort. */
export function markSessionDegraded(sessionId: string, dataDir: string = DATA_DIR): void {
  if (!sessionId) return;
  const now = Date.now();
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(degradedPath(sessionId, dataDir), new Date(now).toISOString(), 'utf-8');
    for (const f of readdirSync(dataDir)) {
      if (!f.startsWith(DEGRADED_PREFIX)) continue;
      const p = join(dataDir, f);
      try { if (now - statSync(p).mtimeMs > DEGRADED_MAX_AGE_MS) unlinkSync(p); } catch { /* raced */ }
    }
  } catch { /* the flag is a courtesy, never a requirement */ }
}

/** True (once) if this session was told memory was down — clears the flag as it reports. */
export function consumeSessionDegraded(sessionId: string, dataDir: string = DATA_DIR): boolean {
  if (!sessionId) return false;
  try {
    const p = degradedPath(sessionId, dataDir);
    statSync(p);            // throws when absent ⇒ nothing to announce
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}
