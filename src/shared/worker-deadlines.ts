// src/shared/worker-deadlines.ts — which worker routes keep running after the thread proxy stops waiting for them, and
// what a caller whose call to one came back unconfirmed should check. Imported by threaded-main (the 202 it answers)
// and by the CLI client (the verdict it raises on that 202), so both name the same paths and give the same advice.

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
};
export const IN_FLIGHT_ON_TIMEOUT = new Set(Object.keys(IN_FLIGHT_HINTS));

/** What a caller whose call to `path` came back unconfirmed should check, and how (the query string is ignored). */
export function inFlightHint(path: string): string {
  return IN_FLIGHT_HINTS[new URL(path, 'http://x').pathname] ?? 'Do NOT retry: it was not cancelled and may still be running.';
}
