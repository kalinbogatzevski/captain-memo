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
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: ctl.signal });
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
