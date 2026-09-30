// Cross-AI observation capture — shared source contract.
//
// A CaptureSource finds FINISHED local sessions of one non-Claude tool (codex,
// agy, …) and turns each transcript into RawObservationEvent[]. The worker-side
// driver enqueues those events; the existing summarizer→embed→store pipeline
// (origin_agent-agnostic) does the rest. Claude Code already feeds this pipeline
// via its plugin hooks — this is the compatibility path for tools without a
// useful native hook contract and for native-hook sessions that have not yet
// proved delivery, reading the transcripts they persist to disk.

import type { RawObservationEvent } from '../../shared/types.ts';

export interface SessionRef {
  /** Stable per-session id (the tool's own session/conversation uuid). */
  sessionId: string;
  /** Absolute path to the transcript on disk. */
  path: string;
  /** Change token (e.g. `${mtimeMs}:${size}`). A changed marker for an already-
   *  ingested session means it grew (resumed) and should be re-ingested. */
  marker: string;
  /** Session mtime in epoch seconds — used by the backfill cutoff guard. */
  mtimeEpoch: number;
}

export interface CaptureSource {
  readonly id: 'codex' | 'agy' | 'gemini' | 'kimi' | 'opencode';
  /** The tool's session dir exists on this host. */
  available(): boolean;
  /** On by default; disabled only by an explicit env opt-out. */
  enabled(): boolean;
  /** The resolved path this source watches (dir or db file). For boot diagnostics —
   *  surfaced in the worker log so a missing/misresolved path is visible, not silent. */
  describe(): string;
  /** Finished (quiescent), on-disk sessions. */
  discover(): SessionRef[];
  /** Parse a session transcript into events (origin_agent already stamped). */
  extract(ref: SessionRef): RawObservationEvent[];
  /** Optional append-only cursor repair. Return how many events the current
   *  transcript contained at a previously persisted marker, or null when the
   *  source cannot reconstruct that boundary. This keeps parser upgrades from
   *  replaying an already-processed prefix of a resumed session. */
  eventCountAtMarker?(ref: SessionRef, marker: string): number | null;
  /** Optional incremental extract for append-only transcripts. `resume` is the value this method
   *  returned last time for the session (null on first sight). */
  extractFrom?(ref: SessionRef, resume: string | null): IncrementalExtract;
}

export interface IncrementalExtract {
  /** extract(ref).slice(from ?? 0), i.e. exactly the full extract's events from index `from` on. */
  events: RawObservationEvent[];
  /** Full-extract index of events[0]; null when the whole file was parsed (events IS the full extract). */
  from: number | null;
  /** Opaque resume point to persist and pass back on the next growth; null = parse in full next time. */
  resume: string | null;
}
