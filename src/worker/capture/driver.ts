// Capture driver — one tick over all enabled sources. For each finished session
// not yet ingested (and newer than the backfill cutoff), extract its events and
// enqueue them; the existing obs-tick summarizes them into observations stamped
// with the source's origin_agent. Per-session failures are isolated + logged;
// the tick never throws.

import type { RawObservationEvent } from '../../shared/types.ts';
import { redactSecrets } from '../../shared/redact-secrets.ts';
import type { CaptureSource, SessionRef } from './types.ts';
import type { CaptureState } from './state.ts';

// The two fields a source fills with transcript text (the prompt; the assistant text and tool lines): the only ones that can
// hold a pasted key or a command line with a token in it. tool_name, source, origin_agent, session/project ids and branch are
// constants or ids the source sets itself; files_* are paths a parser lifted out of the log, and rewriting one would break the
// file-based lookups for no gain (a path is not a credential shape).
const TEXT_FIELDS = ['tool_input_summary', 'tool_result_summary'] as const;

// Measured 2026-10-22 on this shared box at nice 19 (load ~3), redactSecrets over BOTH text fields of an event:
//   this host's own codex+gemini+agy sessions (982 events, avg 730 chars/field): 62 µs/field, 122 ms for all of them (0.2% of a
//     60 s tick); the biggest real session (116 events) held the thread 12.9 ms.
//   synthetic events at the 2 000-char cap, through runCaptureTick: 1 000 events 0.41 s (0.7% of a tick), 10 000 events 3.2 s (5%);
//     built so every line holds a gate word (key/token/password…): 0.97 s and 9.2 s (1.6% / 15%), under the 25% writer-thread cap.
// The steady state is a handful of new turns per tick; the big cases are a first ingest or `capture backfill`, once. Yielding every
// REDACT_YIELD_EVERY events (in runCaptureTick, before anything is enqueued) caps the unbroken stretch at 65-110 ms for those
// worst-case events (~6 ms for real ones), instead of the 3-9 s that one 10 000-event session would hold the thread.
const REDACT_YIELD_EVERY = 50;

/** `ev` with its text fields redacted (credential-shaped values → [REDACTED…], everything around them kept). The SAME object
 *  when nothing matched, a copy otherwise: gemini-source keeps and hashes the events it returned, so none is edited in place.
 *  Deterministic (redactSecrets has no state), so a session re-extracted later redacts to the same bytes. Shared by the capture
 *  driver below and POST /observation/enqueue (index.ts), the ingress of every hook. */
export function redactEvent(ev: RawObservationEvent): RawObservationEvent {
  let event = ev;
  for (const field of TEXT_FIELDS) {
    const value = ev[field];
    if (typeof value !== 'string') continue;
    const r = redactSecrets(value);
    if (r.count === 0) continue;
    if (event === ev) event = { ...ev };
    event[field] = r.text;
  }
  return event;
}

/** Redaction markers in an event's text: what the driver reports. It counts the ones the sources' clip() already put there
 *  too (the driver's own pass then finds nothing left), and a transcript that quotes a marker is counted as well. */
function markers(ev: RawObservationEvent): number {
  let n = 0;
  for (const field of TEXT_FIELDS) {
    const value = ev[field];
    if (typeof value === 'string') n += value.split('[REDACTED').length - 1;
  }
  return n;
}

export interface CaptureDriverDeps {
  sources: CaptureSource[];
  state: CaptureState;
  enqueue: (event: RawObservationEvent) => void;
  now?: () => number;
  log?: (msg: string) => void;
  /** Ignore the per-source cutoff (for an explicit history backfill). Default false. */
  ignoreCutoff?: boolean;
  /** Awaited after each session so a long tick cannot monopolise the engine thread. A source
   *  without extractFrom re-reads a live session's whole file, which measured 2,486 ms across a
   *  real install's sessions — long enough that a synchronous tick starved request handling. */
  yieldToLoop?: () => Promise<void>;
}

export async function runCaptureTick(
  deps: CaptureDriverDeps,
): Promise<{ ingested: number; events: number; recent: Record<string, number> }> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const yieldToLoop = deps.yieldToLoop ?? (async () => {});
  const nowEpoch = Math.floor(now() / 1000);
  let ingested = 0;
  let events = 0;
  // Per-source count of sessions NEWER than that source's cutoff — i.e. work capture was
  // actually supposed to pick up. Zero means the tool is not in use on this host, however
  // long its session directory has existed; doctor needs that distinction to avoid warning
  // forever about one abandoned rollout from months ago.
  const recent: Record<string, number> = {};

  for (const src of deps.sources) {
    if (!src.available() || !src.enabled()) continue;
    const cutoff = deps.state.ensureCutoff(src.cutoffKey ?? src.id, nowEpoch);

    let refs: SessionRef[];
    try { refs = src.discover(); } catch (e) { log(`[capture:${src.id}] discover failed: ${(e as Error).message}`); continue; }

    recent[src.id] = refs.filter((r) => r.mtimeEpoch > cutoff).length;

    for (const ref of refs) {
      if (!deps.ignoreCutoff && ref.mtimeEpoch <= cutoff) continue;           // backfill guard
      // A native lifecycle hook has already claimed this exact vendor session.
      // Keep the rollout reader armed globally as the compatibility fallback,
      // but never parse/summarize a proven-native session a second time.
      if (deps.state.hasNativeSession(src.id, ref.sessionId)) continue;
      if (deps.state.wasIngested(src.id, ref.sessionId, ref.marker)) continue; // dedup (marker unchanged)

      const cursor = deps.state.ingestedCursor(src.id, ref.sessionId);
      let evs: RawObservationEvent[];
      let from: number | null = null; // full-extract index of evs[0]; null = evs is the whole extract
      let resume: string | null = null;
      try {
        if (src.extractFrom) ({ events: evs, from, resume } = src.extractFrom(ref, cursor?.resume ?? null));
        else evs = src.extract(ref);
      } catch (e) { log(`[capture:${src.id}] extract failed ${ref.sessionId}: ${(e as Error).message}`); continue; }

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
      let already = cursor?.eventsIngested ?? 0;
      // A parser upgrade can reveal more turns in a prefix that an older parser
      // recorded as one aggregate event. For append-only sources, reconstruct
      // the event count at the PREVIOUS byte marker before slicing the current
      // extract. Otherwise the upgrade would replay almost the whole session.
      // Skipped when the source resumed from its own resume point (from !== null): that point carries the
      // parser version, so eventsIngested is already in this parser's numbering.
      if (from === null && cursor && cursor.marker !== ref.marker && src.eventCountAtMarker) {
        // A turn between the two whole-file parses, so a large rollout holds the worker for one of them at a time
        // (~3 s each on a 64 MB codex session). Safe before markIngested: nothing has been enqueued yet, so the
        // worst a shutdown here costs is the re-parse the comment below describes. Reached once per session
        // after an upgrade or parser-version bump; after that extractFrom parses only from the last turn on.
        await yieldToLoop();
        const reconstructed = src.eventCountAtMarker(ref, cursor.marker);
        if (reconstructed !== null) already = reconstructed;
      }
      const base = from ?? 0;
      const total = base + evs.length;
      const fresh = total >= already ? evs.slice(Math.max(0, already - base)) : evs;

      // Credential-shaped text out BEFORE anything is queued: the queue row, the summarizer prompt (a provider call) and the
      // observation all derive from this event, and a source never redacts. Every source's events pass here, so one that is
      // added later is covered without touching this. Like the yield above it runs before the first enqueue, so a shutdown
      // in the gap costs only a re-parse; it yields every REDACT_YIELD_EVERY events so a very long session cannot hold the
      // thread for the seconds the numbers above give for 10 000 events.
      // If redaction itself throws, the session is skipped (logged, retried next tick), never queued as it was written.
      const safe: RawObservationEvent[] = [];
      let redacted = 0;
      try {
        for (const ev of fresh) {
          const r = redactEvent(ev);
          safe.push(r);
          redacted += markers(r);
          if (safe.length % REDACT_YIELD_EVERY === 0) await yieldToLoop();
        }
      } catch (e) { log(`[capture:${src.id}] redact failed ${ref.sessionId}: ${(e as Error).message}`); continue; }
      // POST /capture/backfill does not wait for the interval tick (index.ts capturePromise), so after a yield above the other
      // tick may already have queued and recorded this very state of the session: do not queue it a second time.
      if (fresh.length >= REDACT_YIELD_EVERY && deps.state.wasIngested(src.id, ref.sessionId, ref.marker)) continue;

      // Record even an empty extract so we don't re-open the same unchanged file every tick.
      for (const ev of safe) deps.enqueue(ev);
      deps.state.markIngested(src.id, ref.sessionId, ref.marker, nowEpoch, total, resume);
      if (fresh.length > 0) {
        ingested++;
        events += fresh.length;
        // The count only, never the value; nothing is said when nothing was redacted.
        log(`[capture:${src.id}] ingested ${ref.sessionId} → ${fresh.length} new event(s)${redacted > 0 ? `, ${redacted} credential-shaped value(s) redacted` : ''}`);
      }
      // AFTER markIngested, never between the first enqueue and the record: a shutdown in that gap leaves events queued but
      // not accounted for, and the next boot queues them again. The yields above (eventCountAtMarker, redaction) all sit
      // BEFORE the first enqueue, where a shutdown costs only a re-parse.
      await yieldToLoop();
    }
  }

  return { ingested, events, recent };
}

/** One capture tick at a time. The interval skips while a tick runs (not queued: a tick can outlive its interval on a big
 *  backlog); POST /capture/backfill waits for the running one, then holds the gate while it runs, so the next interval skips
 *  too. Before, a backfill started its own tick on top of a running one and both extracted and queued the same session. */
export function createTickGate(): {
  interval: <T>(run: () => Promise<T>) => Promise<T> | null;
  backfill: <T>(run: () => Promise<T>) => Promise<T>;
  /** The tick or backfill in flight, for shutdown to drain. */
  pending: () => Promise<unknown> | null;
} {
  let current: Promise<unknown> | null = null;
  const hold = <T>(p: Promise<T>): Promise<T> => {
    // Released only by the holder itself: an older tick finishing must not free the gate a newer backfill now holds.
    const release = () => { if (current === mine) current = null; };
    const mine: Promise<unknown> = p.then(release, release);
    current = mine;
    return p;
  };
  return {
    interval: (run) => (current ? null : hold(run())),
    backfill: (run) => hold((current ?? Promise.resolve()).then(run)),
    pending: () => current,
  };
}
