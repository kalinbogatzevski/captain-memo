// src/shared/worker-deadlines.ts — the worker's per-route ceilings, which worker routes keep running after the thread
// proxy stops waiting for them, and what a caller whose call to one came back unconfirmed should check. Imported by
// threaded-main (the ceilings it enforces, the 202 it answers) and by the clients (cli/client.ts, mcp-server.ts: the
// deadline they give each call, the verdict they raise), so both sides budget from the same numbers.

/** Thread-RPC deadline for an ordinary read or write. */
export const REQUEST_DEADLINE_MS = Number(process.env.CAPTAIN_MEMO_ENGINE_REQUEST_MS ?? 10_000);
// Known-long write ops (a full reindex re-embeds the whole corpus — minutes, not seconds) get a
// much longer thread-RPC ceiling. With the 10s default, main 503s the CLI with `thread_rpc_timeout`
// on a write the writer is STILL running (the timeout abandons main's wait; it does NOT cancel the
// writer) — reporting failure on an eventual success, and a restart mid-run leaves it partial.
export const LONG_WRITE_DEADLINE_MS = Number(process.env.CAPTAIN_MEMO_REINDEX_MS ?? 30 * 60_000);
// /consolidate joins /reindex here because a forced pass is a whole-corpus scan (~50s measured)
// plus, for themes, a model call per cluster.
// /capture/backfill reads every session file of every active capture source (the running tick first, then its own all-history
// tick, one session at a time with a yield between them): minutes on a big history, never the 10 s default. It took the default,
// so main 503'd `thread_rpc_timeout` while the writer carried on ingesting. The 30 min ceiling is /reindex's, not a measured
// backfill time (not measured: no copy of a real history to run it on).
export const LONG_WRITE_PATHS = new Set(['/reindex', '/consolidate', '/capture/backfill']);
// /remember does an LLM frontmatter `generate`, a semantic dedup search AND a chunk-embed pass before
// it returns — none of which fit the 10s default on a real corpus, and it was never given a ceiling
// of its own. MEASURED on this captain (149k chunks, external Voyage embedder), wall-clock at the
// endpoint: create 1.8s @2KB · 2.1s @10KB · 2.9s @30KB, but an UPDATE to an EXISTING memory took
// 14.0s @10KB — it re-searches, rewrites and re-ingests. So creates always fit and updates do not,
// which is exactly the reported shape: /remember 503ing three times running on a large-body update
// while small writes to the same worker succeeded instantly and /health stayed green (2026-08-08).
// The timeout only abandons MAIN's wait — the writer runs on and completes the write, so the caller
// was told "failed" about a write that had in fact landed. 60s is ~4x the measured worst case and
// still short enough that a genuinely wedged write surfaces rather than hanging the CLI.
// ponytail: one flat ceiling for the path; split per-op only if a slower corpus makes 60s tight.
export const REMEMBER_DEADLINE_MS = Number(process.env.CAPTAIN_MEMO_REMEMBER_MS ?? 60_000);
/** Paths that share /remember's ceiling: one model call plus a write, not a corpus scan. */
export const REMEMBER_PATHS = new Set(['/remember', '/promote/slice']);

// Paths whose work SURVIVES main abandoning its wait — the writer runs on and finishes them. A timeout on one of
// these is "unconfirmed", not "failed", and forwardToWriter answers 202 rather than 503.
// WRITES ONLY, deliberately: a timed-out READ is safe to retry, so collapsing it into "probably worked" would lose
// information rather than add it. Every entry here is a write that is NOT idempotent — which is precisely why telling
// the caller it failed is expensive.
// Add a path here together with its callers' handling of the 202: cli/client.ts's workerPost throws
// WorkerCallError('unconfirmed') on it, and a caller that reads the body itself (consolidate) needs its own arm. A
// path listed without them prints "complete" with undefined counts, and `upgrade` would VACUUM the worker mid-reindex.
// Each path carries its OWN hint: what shows that path's effect and how to look. One "verify with search_memory" for
// all of them sent a caller searching memory for a reindex or a consolidation pass.
const IN_FLIGHT_HINTS: Record<string, string> = {
  '/remember': 'Do NOT retry: a retry is how you get two copies. In a few seconds, look for it with search_memory.',
  // Only the CLI's shadow slices call this (promote --shadow); their verdicts land in the shadow ledger.
  '/promote/slice': 'Do NOT start another slice until this one lands: a second would judge the same rows again. Its verdicts show in `captain-memo promote --report` (the judged total rises when they are recorded).',
  // POST /reindex reports nothing until it ends and never touches the boot indexing state, so there is no progress to read.
  '/reindex': 'Do NOT start another reindex: a second is refused (409 reindex_running) while this one runs. A manual reindex has no progress readout, so give it minutes, not seconds, then check `captain-memo stats`.',
  // A pass records its run row when it FINISHES (consolidate.ts polls the same field).
  '/consolidate': 'Do NOT run it again yet: its passes may already have started. A newer semantic or theme run in the Housekeeping panel of `captain-memo stats` shows each pass once it finishes.',
  // The tick gate (worker/capture/driver.ts) runs one tick at a time and wasIngested skips what a tick already recorded, so a
  // second backfill duplicates nothing: it waits behind this one and re-reads every session file for no gain. The ingested
  // counts of `capture status` are the only thing that moves while it runs.
  '/capture/backfill': 'Do NOT start another backfill: a second one waits behind this one and re-reads every session file for nothing. The ingested session counts in `captain-memo capture status` rise while it runs.',
};
export const IN_FLIGHT_ON_TIMEOUT = new Set(Object.keys(IN_FLIGHT_HINTS));

/** What a caller whose call to `path` came back unconfirmed should check, and how (the query string is ignored). */
export function inFlightHint(path: string): string {
  return IN_FLIGHT_HINTS[new URL(path, 'http://x').pathname] ?? 'Do NOT retry: it was not cancelled and may still be running.';
}

/** A client's ceiling for a plain read: the worker's 10 s thread RPC plus room for a cold reader. Above this a read
 *  is not slow, it is not coming. */
export const CLIENT_READ_CEILING_MS = 25_000;
/** What a client adds over the worker's own ceiling for a route the worker bounds itself. */
export const CLIENT_MARGIN_MS = 5_000;

/** The client-side deadline for a worker route, derived from the worker's ceiling for it (the query string is ignored). */
export function clientCeilingMs(path: string): number {
  const p = new URL(path, 'http://x').pathname;
  if (LONG_WRITE_PATHS.has(p)) return LONG_WRITE_DEADLINE_MS + CLIENT_MARGIN_MS;
  if (REMEMBER_PATHS.has(p)) return REMEMBER_DEADLINE_MS + CLIENT_MARGIN_MS;
  return CLIENT_READ_CEILING_MS;
}
