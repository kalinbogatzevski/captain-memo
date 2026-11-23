import { DEFAULT_WORKER_PORT } from '../shared/paths.ts';
import { callWorker, healthFailureReason, WorkerCallError } from '../shared/worker-call.ts';
import { inFlightHint } from '../shared/worker-deadlines.ts';

const BASE = `http://localhost:${process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT}`;
export { WorkerCallError };

// Every call goes through callWorker: a 3 s /health preflight (cached 5 s) and a deadline from the worker's own
// ceiling for the route (shared/worker-deadlines.ts). A listener that never answers used to hang the CLI for
// 300 s; now it fails in 3 s with the reason, and a timed-out /remember or /reindex is reported UNCONFIRMED.

export async function workerGet(path: string): Promise<unknown> {
  const res = await callWorker(BASE, path);
  if (!res.ok) throw new WorkerCallError('http', path, `${path} → ${res.status}: ${await res.text()}`, res.status);
  return res.json();
}

export async function workerPost(path: string, body: unknown): Promise<unknown> {
  const res = await callWorker(BASE, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new WorkerCallError('http', path, `${path} → ${res.status}: ${await res.text()}`, res.status);
  const j = await res.json() as { status?: unknown } | null;
  // 202 write_in_flight (threaded-main forwardToWriter): main stopped waiting, the writer did not. One 'unconfirmed'
  // verdict for every caller, instead of each reading a body with no counts as a finished result ("Reindex complete"
  // with undefined counts, or `upgrade` going on to VACUUM a worker that is still re-embedding).
  if (res.status === 202 && j?.status === 'write_in_flight') {
    throw new WorkerCallError('unconfirmed', path, `worker ${path} did not confirm within its deadline: UNCONFIRMED, not failed. It was not cancelled and may still be running. ${inFlightHint(path)}`, 202);
  }
  return j;
}

/** Like workerGet but returns null instead of throwing when the endpoint is
 *  absent/unreachable. Lets optional panels degrade silently. */
export async function workerGetOptional(path: string, timeoutMs?: number): Promise<unknown | null> {
  try {
    const res = await callWorker(BASE, path, {}, timeoutMs ? { ceilingMs: timeoutMs } : {});
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** The reason a worker gave in its JSON error body (`detail`, else `error`), for a one-line message; the whole
 *  message when there is none. workerGet/workerPost errors read `<path> → <status>: <body>`. */
export function workerErrorReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const at = msg.indexOf('{');
  if (at >= 0) {
    try {
      const j = JSON.parse(msg.slice(at)) as { detail?: unknown; error?: unknown };
      const r = j.detail ?? j.error;
      if (typeof r === 'string' && r) return r;
    } catch { /* not JSON: fall through to the message */ }
  }
  return msg;
}

export async function workerHealthy(): Promise<boolean> {
  return (await workerHealth()).healthy;
}

/** Health with the reason when it is not (healthFailureReason: which kind of dead). Bounded at 3 s; never throws. */
export async function workerHealth(): Promise<{ healthy: boolean; reason?: string }> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return { healthy: false, reason: `worker answered ${res.status}` };
    const result = await res.json() as { healthy?: boolean };
    return result.healthy === true ? { healthy: true } : { healthy: false, reason: 'worker reports unhealthy' };
  } catch (e) {
    return { healthy: false, reason: healthFailureReason(e) };
  }
}
