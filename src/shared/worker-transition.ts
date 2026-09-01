// src/shared/worker-transition.ts — the "this worker is down ON PURPOSE" breadcrumb.
//
// An unreachable worker used to be indistinguishable from a dead one, so a hook that found
// nothing listening on :PORT force-reclaimed it — hard-killing a worker that was eight seconds
// into its own boot, and on win32 racing the updater's own detached WMI relauncher for the
// port. The same blindness reached the user as "⚓ worker unreachable — memory is paused this
// session", which reads as a break: sessions got closed and reopened by hand over a restart
// that would have finished by itself. (Field report, Windows federation captain, 2026-09-01.)
//
// So whoever takes the worker away says so first. Two phases:
//   • 'updating' — written by whoever is about to replace the worker: on this line that is the
//     SessionStart opt-in auto-updater (hooks/session-start.ts), before it restarts the service.
//     It carries from/to so the banner can name the versions. No lock the self-heal paths consult
//     covers the relaunch window, so this breadcrumb is the only signal a concurrent session has.
//   • 'booting'  — written by the INCOMING worker before it opens the port, cleared once it is
//     listening. Covers a slow cold start as well as every restart path, including ones nothing
//     else knows about.
//
// A fresh breadcrumb means "wait, do not kill" to every self-heal path, and gives the SessionStart
// banner something honest to say instead of "unreachable".
//
// THE TTL MEASURES THE OUTAGE, NOT THE LAST WRITE. Overwriting a breadcrumb that is still fresh
// keeps its original ts (and its versions), because a supervisor restarting a worker that dies on
// boot re-enters this code every RestartSec — and the worker unit sets Restart=always with
// StartLimitIntervalSec=0, i.e. every 5s forever. Restamping there would hold the shield open for
// as long as the crash loop ran: self-heal disabled and the banner promising a recovery that can
// never come, in the one situation where the user genuinely has to intervene. Anchored to the
// FIRST write, a boot loop ages out in TRANSITION_TTL_MS and normal recovery resumes.
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { DATA_DIR } from './paths.ts';

export const TRANSITION_PATH = join(DATA_DIR, '.worker-transition');

/** How long a breadcrumb is honoured, measured from the START of the down-window (see above). Sized
 *  above the real windows it covers — the win32 relaunch waits up to 20s for the port to free then
 *  retries Start-ScheduledTask for up to 30s, and a cold boot is seconds — so a legitimate handover
 *  is never cut short, while a worker that is simply not coming back stops being shielded. */
export const TRANSITION_TTL_MS = 120_000;

export interface WorkerTransition {
  phase: 'booting' | 'updating';
  /** Versions, when known. The 'updating' writer knows both; a 'booting' write inherits them from a
   *  fresh 'updating' breadcrumb it replaces, so the banner keeps naming versions across the handover. */
  from?: string;
  to?: string;
  /** Epoch ms the down-window started. */
  ts: number;
}

/** Drop the breadcrumb; true if it landed. Synchronous on purpose — the 'updating' caller may be
 *  killed moments later, so an async write would never reach disk. Written tmp+rename so a hook
 *  reading concurrently can never see a half-written file (a torn read parses as "no breadcrumb",
 *  which is exactly the reclaim this exists to prevent). Best-effort: never throws. */
export function markTransition(
  t: Omit<WorkerTransition, 'ts'>,
  path: string = TRANSITION_PATH,
  now: number = Date.now(),
): boolean {
  try {
    const live = readTransition(path, now);
    const entry: WorkerTransition = {
      ...t,
      // Inherit the versions a fresh 'updating' breadcrumb was carrying, so the incoming worker's
      // 'booting' write doesn't blank the banner mid-outage.
      ...(t.from === undefined && live?.from !== undefined ? { from: live.from } : {}),
      ...(t.to === undefined && live?.to !== undefined ? { to: live.to } : {}),
      ts: live?.ts ?? now,
    };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;   // a missing breadcrumb only costs us the old (wrong) behaviour
  }
}

/** The live breadcrumb, or null when there is none / it is unreadable / it is outside the TTL.
 *  The window is checked in BOTH directions: a breadcrumb dated ahead of the clock (a backwards
 *  NTP correction, a VM restored from a snapshot) would otherwise never age out and would shield
 *  a dead worker permanently. */
export function readTransition(
  path: string = TRANSITION_PATH,
  now: number = Date.now(),
): WorkerTransition | null {
  try {
    const t = JSON.parse(readFileSync(path, 'utf-8')) as WorkerTransition;
    if (t.phase !== 'booting' && t.phase !== 'updating') return null;
    if (!Number.isFinite(t.ts) || Math.abs(now - t.ts) > TRANSITION_TTL_MS) return null;
    return t;
  } catch {
    return null;
  }
}

/** Remove the breadcrumb — the worker is serving again, or the replacement never happened.
 *  Idempotent. */
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

/** Record that THIS session was told memory is unavailable; true if the flag landed. The caller
 *  promises the user a recovery notice, so it needs to know when it cannot keep that promise.
 *  Also prunes day-old flags so a session that never reaches a Stop hook can't litter DATA_DIR. */
export function markSessionDegraded(sessionId: string, dataDir: string = DATA_DIR): boolean {
  if (!sessionId) return false;
  const now = Date.now();
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(degradedPath(sessionId, dataDir), new Date(now).toISOString(), 'utf-8');
    for (const f of readdirSync(dataDir)) {
      if (!f.startsWith(DEGRADED_PREFIX)) continue;
      const p = join(dataDir, f);
      try { if (now - statSync(p).mtimeMs > DEGRADED_MAX_AGE_MS) unlinkSync(p); } catch { /* raced */ }
    }
    return true;
  } catch {
    return false;
  }
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
