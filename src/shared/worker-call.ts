// src/shared/worker-call.ts — the ONE way a client talks to the worker over HTTP: a cheap liveness preflight,
// a deadline taken from the worker's own ceiling for the route, and an error that says which kind of dead.
//
// Measured on Windows (2026-09-17): against a listener that accepts and never replies, a plain fetch hung
// 300.57 s; with AbortSignal.timeout(3000) it failed at 3014 ms. The preflight is what keeps a 30-minute
// reindex ceiling from becoming a 30-minute hang when nobody is home: /health must answer (any status — a
// degraded worker still serves) within 3 s, and the verdict is cached ~5 s so a burst of calls pays once.
import { clientCeilingMs, IN_FLIGHT_ON_TIMEOUT, inFlightHint } from './worker-deadlines.ts';
import { workerAuthHeaders } from './worker-auth.ts';

// 'unconfirmed': the worker was still running a non-idempotent write when it stopped answering. Never reported as a
// failure, because a retry would do the work twice.
export type WorkerCallKind = 'unreachable' | 'timeout' | 'unconfirmed' | 'http';

export class WorkerCallError extends Error {
  constructor(public readonly kind: WorkerCallKind, public readonly path: string, message: string, public readonly status?: number, public readonly body?: string) {
    super(message);
    this.name = 'WorkerCallError';
  }
}

export interface WorkerCallOpts {
  /** Deadline for the call itself; default clientCeilingMs(path). */
  ceilingMs?: number;
  /** Skip the /health preflight (the caller has just probed). */
  preflight?: boolean;
  preflightTimeoutMs?: number;
}

const PREFLIGHT_TIMEOUT_MS = 3_000;
const PREFLIGHT_CACHE_MS = 5_000;
const healthCache = new Map<string, { at: number; reason: string | null }>();

export function resetHealthCache(): void { healthCache.clear(); }

export const isTimeout = (e: unknown): boolean => /TimeoutError|AbortError/.test(e instanceof Error ? e.name : String(e));
export const isRefused = (e: unknown): boolean => /ECONNREFUSED|refused|Unable to connect|failed to connect|fetch failed/i.test(e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Which kind of dead a failed /health fetch means: refused is "nothing listening"; accepted but never answered is
 *  the signature of an orphaned socket holder (a subprocess of a dead worker keeping the port). */
export function healthFailureReason(e: unknown): string {
  if (isTimeout(e)) return 'listener exists but does not answer — possible orphaned socket holder';
  if (isRefused(e)) return 'nothing listening';
  return (e instanceof Error ? e.message : String(e)).slice(0, 160);
}

/** Why the worker is unreachable, or null when it answers /health (any status). Cached per base ~5 s. */
async function preflight(base: string, timeoutMs: number): Promise<string | null> {
  const c = healthCache.get(base);
  if (c && Date.now() - c.at < PREFLIGHT_CACHE_MS) return c.reason;
  let reason: string | null = null;
  try {
    await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    reason = isTimeout(e) ? `listener on ${base} exists but does not answer — usually an orphaned socket holder (a subprocess of a dead worker kept the port); run \`captain-memo doctor\``
      : isRefused(e) ? `nothing listening on ${base}`
      : (e instanceof Error ? e.message : String(e)).slice(0, 160);
  }
  healthCache.set(base, { at: Date.now(), reason });
  return reason;
}

/** Fetch a worker route with the preflight and the route's deadline. Resolves with the Response (any status —
 *  the caller decides what a non-2xx means); rejects with a WorkerCallError of kind 'unreachable' (preflight),
 *  'timeout' (a read that never came back) or 'unconfirmed' (a non-idempotent write the worker may still be
 *  finishing — never reported as failed). */
export async function callWorker(base: string, path: string, init: RequestInit = {}, opts: WorkerCallOpts = {}): Promise<Response> {
  const ceilingMs = opts.ceilingMs ?? clientCeilingMs(path);
  const pathname = new URL(path, 'http://x').pathname;
  if (opts.preflight !== false && pathname !== '/health') {
    const why = await preflight(base, opts.preflightTimeoutMs ?? PREFLIGHT_TIMEOUT_MS);
    if (why) throw new WorkerCallError('unreachable', path, `captain-memo worker is not reachable: ${why}`);
  }
  try {
    const headers = new Headers(init.headers);
    for (const [k, v] of Object.entries(workerAuthHeaders())) headers.set(k, v);
    return await fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(ceilingMs) });
  } catch (e) {
    if (isTimeout(e)) {
      if (IN_FLIGHT_ON_TIMEOUT.has(pathname)) {
        throw new WorkerCallError('unconfirmed', path, `worker ${pathname} did not answer within ${ceilingMs} ms: UNCONFIRMED, not failed. It was not cancelled and may still be running. ${inFlightHint(pathname)}`);
      }
      throw new WorkerCallError('timeout', path, `worker ${pathname} timed out after ${ceilingMs} ms — a listener that never answers is usually an orphaned socket holder; run \`captain-memo doctor\``);
    }
    if (isRefused(e)) { healthCache.set(base, { at: Date.now(), reason: `nothing listening on ${base}` }); throw new WorkerCallError('unreachable', path, `captain-memo worker is not reachable: nothing listening on ${base}`); }
    throw e;
  }
}
