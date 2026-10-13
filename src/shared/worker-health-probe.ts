// src/shared/worker-health-probe.ts — confirm the worker is REALLY unreachable
// before a destructive reclaim.
//
// An app endpoint (/inject/context, /stats) can fail because the worker is merely
// BUSY (mid embed/summarize — a slow Voyage roundtrip blocks the request) or SLOW
// to start, while /health answers instantly whenever the process is alive and its
// event loop is turning. So a single failed app probe must NOT trigger a kill:
// re-probe /health a couple of times and only reclaim if it stays unreachable.
// (Field 2026-06-02: a single Voyage-induced /inject/context timeout was
// force-killing a healthy worker on every prompt → a restart-thrash cascade.)
import { workerAuthHeaders } from './worker-auth.ts';

/** True iff the worker answers GET /health with {"healthy":true} within timeoutMs. */
export async function probeHealthOnce(port: number, timeoutMs = 3000): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    if (!r.ok) return false;
    const body = (await r.json().catch(() => null)) as { healthy?: boolean } | null;
    return body?.healthy === true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** How long the engine may report itself unresponsive before a live process counts as wedged (ms).
 *  /health is derived from the writer thread's heartbeat and answers 503 once that is >5 s old
 *  (worker/health-heartbeat.ts), so a worker that is merely busy answers 503 too. Measured on this
 *  captain's worker journal 2026-10-08..13: 186 writer stalls, 26 >=5 s, 7 >=20 s, 2 >=60 s, longest
 *  63.5 s — all of them recovered by themselves. 120 s clears every one with 2x margin; a writer
 *  stuck longer than that is a real wedge and is reclaimed as before. */
export const WORKER_WEDGED_AFTER_MS = 120_000;

/** True while a live worker answers GET /health, even with a 503: the process is up and says "not
 *  now" (a stalled writer, the startup indexing burst). Only a process that does not answer, is not
 *  a worker (no numeric `instance`), or has reported its engine unresponsive for >= `wedgedAfterMs`
 *  reads false. This is the question a destructive reclaim should ask; probeHealthOnce asks the
 *  stricter "is it serving right now", which a busy worker fails every few minutes — and each
 *  restart re-opens the indexing burst, so that answer feeds itself (field 2026-10-13: the
 *  UserPromptSubmit self-heal restarted a live worker at 10:45:03 and again at 10:53:29). */
export async function probeWorkerAlive(
  port: number,
  timeoutMs = 3000,
  wedgedAfterMs = WORKER_WEDGED_AFTER_MS,
): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    const body = (await r.json().catch(() => null)) as { healthy?: boolean; degraded?: string; instance?: unknown } | null;
    if (r.ok) return body?.healthy === true;
    if (typeof body?.instance !== 'number') return false;   // an older worker, or not ours: cannot call it alive
    const stalledMs = Number(/unresponsive (\d+)ms/.exec(body.degraded ?? '')?.[1]);
    return !(Number.isFinite(stalledMs) && stalledMs >= wedgedAfterMs);
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** WHICH worker process is answering — `instance` from /health, else `worker.started_at_epoch` from /stats —
 *  or null when neither can be read (unreachable, or an old worker mid-embed so /stats is slow).
 *
 *  `/health` deliberately answers `{healthy:true}` from any live process and carries no identity, so
 *  it cannot distinguish a restarted worker from the OUTGOING one that is still listening. A restart
 *  needs that distinction: on win32 the relauncher is detached and returns immediately, so the old
 *  process is still up when the first poll fires. Comparing this stamp is what makes "it came back"
 *  mean a NEW process rather than merely a reachable one. */
export async function readWorkerInstance(port: number, timeoutMs = 3000): Promise<number | null> {
  // /health FIRST: the worker answers it on its main thread from a constant, so the identity is readable even
  // while the writer is buried in the startup indexing burst and /stats answers 503 — for a large corpus that
  // burst outlasts the restart window, and every successful restart came back "NOT confirmed" (field
  // 2026-09-19, 34k chunks). The body is read whatever the status: a 503 with `instance` is a live process
  // saying "not ready yet", which is exactly the evidence a restart is polling for.
  const health = (await readJson(port, '/health', timeoutMs, false)) as { instance?: unknown } | null;
  if (typeof health?.instance === 'number' && Number.isFinite(health.instance)) return health.instance;
  // A worker predating that field (the OUTGOING one across an upgrade) identifies itself only through the
  // writer's boot stamp on /stats. Same unit (seconds), so the two compare.
  const stats = (await readJson(port, '/stats', timeoutMs, true)) as { worker?: { started_at_epoch?: unknown } } | null;
  const v = stats?.worker?.started_at_epoch;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** GET a JSON body from the worker, or null when unreachable / not JSON / (with `okOnly`) not 2xx. */
async function readJson(port: number, path: string, timeoutMs: number, okOnly: boolean): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: workerAuthHeaders(), signal: ctl.signal });
    if (okOnly && !r.ok) return null;
    return await r.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** True if ANY of up to `attempts` spaced probes succeeds (worker alive); false
 *  only if ALL fail (a genuine, persistent outage worth reclaiming). `sleep` is
 *  injectable so the retry logic is unit-testable without real waits. */
export async function probeHealthyWithRetries(
  probeOnce: () => Promise<boolean>,
  attempts = 3,
  gapMs = 2000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await probeOnce()) return true;
    if (i < attempts - 1) await sleep(gapMs);
  }
  return false;
}
