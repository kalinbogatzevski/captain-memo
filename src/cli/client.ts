import { DEFAULT_WORKER_PORT } from '../shared/paths.ts';
import { workerAuthHeaders } from '../shared/worker-auth.ts';
import { WorkerCallError } from '../shared/worker-call.ts';
import { inFlightHint } from '../shared/worker-deadlines.ts';

const BASE = `http://localhost:${process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT}`;
export { WorkerCallError };

export async function workerGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: workerAuthHeaders() });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function workerPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...workerAuthHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
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
    const res = await fetch(`${BASE}${path}`, { headers: workerAuthHeaders(), ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
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
  try {
    const result = await workerGet('/health') as { healthy: boolean };
    return result.healthy === true;
  } catch {
    return false;
  }
}
