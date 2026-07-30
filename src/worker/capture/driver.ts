// Capture driver — one tick over all enabled sources. For each finished session
// not yet ingested (and newer than the backfill cutoff), extract its events and
// enqueue them; the existing obs-tick summarizes them into observations stamped
// with the source's origin_agent. Per-session failures are isolated + logged;
// the tick never throws.

import type { RawObservationEvent } from '../../shared/types.ts';
import type { CaptureSource, SessionRef } from './types.ts';
import type { CaptureState } from './state.ts';

export interface CaptureDriverDeps {
  sources: CaptureSource[];
  state: CaptureState;
  enqueue: (event: RawObservationEvent) => void;
  now?: () => number;
  log?: (msg: string) => void;
  /** Ignore the per-source cutoff (for an explicit history backfill). Default false. */
  ignoreCutoff?: boolean;
}

export function runCaptureTick(deps: CaptureDriverDeps): { ingested: number; events: number } {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const nowEpoch = Math.floor(now() / 1000);
  let ingested = 0;
  let events = 0;

  for (const src of deps.sources) {
    if (!src.available() || !src.enabled()) continue;
    const cutoff = deps.state.ensureCutoff(src.id, nowEpoch);

    let refs: SessionRef[];
    try { refs = src.discover(); } catch (e) { log(`[capture:${src.id}] discover failed: ${(e as Error).message}`); continue; }

    for (const ref of refs) {
      if (!deps.ignoreCutoff && ref.mtimeEpoch <= cutoff) continue;           // backfill guard
      if (deps.state.wasIngested(src.id, ref.sessionId, ref.marker)) continue; // dedup (marker unchanged)

      let evs: RawObservationEvent[];
      try { evs = src.extract(ref); } catch (e) { log(`[capture:${src.id}] extract failed ${ref.sessionId}: ${(e as Error).message}`); continue; }

      // ONLY THE NEW TAIL. `marker` is mtime:size, so a live session's marker changes on every append,
      // and extract() has no cursor — it returns the whole file each time. Re-enqueuing all of it made a
      // session growing to N turns cost 1+2+…+N = N(N+1)/2 summarizer calls instead of N, and every one
      // of those is a real LLM call. Measured on a light OSS install: codex at 8 950 observations
      // (97.8% of the corpus) with 30 564 more queued and 12.1 M tokens distilled.
      //
      // Session logs are append-only, so event k is stable across extracts and slicing is sound. A
      // SHORTER result means the file was rewritten or rotated: re-ingest the whole thing rather than
      // silently skipping its contents — the same rule the digest accumulators use when a file turns up
      // smaller than their cached offset.
      const already = deps.state.ingestedCount(src.id, ref.sessionId);
      const fresh = evs.length >= already ? evs.slice(already) : evs;

      // Record even an empty extract so we don't re-open the same unchanged file every tick.
      for (const ev of fresh) deps.enqueue(ev);
      deps.state.markIngested(src.id, ref.sessionId, ref.marker, nowEpoch, evs.length);
      if (fresh.length > 0) {
        ingested++;
        events += fresh.length;
        log(`[capture:${src.id}] ingested ${ref.sessionId} → ${fresh.length} new event(s)`);
      }
    }
  }

  return { ingested, events };
}
