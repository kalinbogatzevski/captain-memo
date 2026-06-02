// src/worker/summarizer-backoff.ts — pure helpers for the obs-batch summarizer's
// "the API is overloaded/down, delay our queries" behaviour. Kept side-effect-free
// so the policy is unit-testable without a worker, a clock, or the network.
//
// Three failure kinds drive three different responses in processBatch:
//   permanent  — auth / bad-request / model-not-found (4xx≠408/429). Never succeeds
//                on retry → dead-letter immediately (don't loop, don't back off).
//   overloaded — API is overloaded / down / unreachable (408, 429, 5xx, network,
//                timeout). A TRANSIENT condition → requeue WITHOUT counting a retry
//                (so a long outage can't dead-letter observations) AND back off the
//                whole obs-batch loop so we stop hammering a struggling API.
//   retryable  — a per-item problem (e.g. a 2xx whose body failed our JSON/schema
//                parse). Retry a bounded number of times, then dead-letter so one
//                bad item can't wedge the queue head forever.

export type SummarizeFailureKind = 'permanent' | 'overloaded' | 'retryable';

/**
 * Classify a summarize() failure. `status` (the HTTP status the transport attached
 * to the error) is authoritative when present; the message is only consulted for
 * statusless errors (network/timeout, subprocess, schema-parse).
 */
export function classifySummarizeFailure(message: string, status?: number): SummarizeFailureKind {
  if (typeof status === 'number' && Number.isFinite(status)) {
    if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return 'overloaded';
    if (status >= 400 && status < 500) return 'permanent'; // 401/403/400/404/422…
    return 'retryable';
  }
  const m = message.toLowerCase();
  // Statusless API-health failures: the request never reached a server cleanly.
  if (/timed out|timeout|unable to connect|econnrefused|etimedout|enotfound|econnreset|fetch failed|socket hang|network|aborted/.test(m)) {
    return 'overloaded';
  }
  // Statusless permanent: auth / missing token / missing subprocess.
  if (/no oauth token|invalid api key|invalid x-api-key|authentication|unauthorized|executable not found|enoent|command not found/.test(m)) {
    return 'permanent';
  }
  // Everything else (notably "failed to parse JSON" / "failed schema validation").
  return 'retryable';
}

export interface BackoffOpts {
  /** First backoff step (the exponential base). Default 15 s. */
  baseMs?: number;
  /** Upper bound on a single backoff. Default 10 min. */
  capMs?: number;
  /** Injectable [0,1) source for full-jitter (tests pass a constant). Default Math.random. */
  jitter?: () => number;
}

/**
 * Exponential backoff with FULL jitter for the obs-batch summarizer cooldown.
 * `streak` is the count of consecutive overloaded cycles (1 on the first failure).
 * Returns the cooldown in ms; honors a server `Retry-After` (retryAfterMs) when it
 * is longer. Full jitter (random in [exp/2, exp]) avoids multiple workers/sessions
 * retrying in lockstep against an already-struggling API.
 */
export function computeBackoffMs(streak: number, retryAfterMs = 0, opts: BackoffOpts = {}): number {
  const baseMs = opts.baseMs ?? 15_000;
  const capMs = opts.capMs ?? 600_000;
  const jitter = opts.jitter ?? Math.random;
  const n = Math.max(1, Math.floor(streak));
  const exp = Math.min(baseMs * 2 ** (n - 1), capMs);
  const jittered = exp / 2 + jitter() * (exp / 2); // [exp/2, exp]
  return Math.max(Math.round(jittered), Math.round(Math.max(0, retryAfterMs)));
}
