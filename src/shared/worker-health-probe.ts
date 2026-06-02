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
