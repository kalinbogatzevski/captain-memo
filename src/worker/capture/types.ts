// Cross-AI observation capture — shared source contract.
//
// A CaptureSource finds FINISHED local sessions of one non-Claude tool (codex,
// agy, …) and turns each transcript into RawObservationEvent[]. The worker-side
// driver enqueues those events; the existing summarizer→embed→store pipeline
// (origin_agent-agnostic) does the rest. Claude Code already feeds this pipeline
// via its plugin hooks — this is the equivalent capture path for tools that have
// no hook system, reading the transcripts they persist to disk.

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
  /** Finished (quiescent), on-disk sessions. */
  discover(): SessionRef[];
  /** Parse a session transcript into events (origin_agent already stamped). */
  extract(ref: SessionRef): RawObservationEvent[];
}
