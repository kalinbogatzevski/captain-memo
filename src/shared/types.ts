export type ChannelType = 'memory' | 'skill' | 'observation' | 'remote';

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export type ObservationType =
  | 'bugfix' | 'feature' | 'refactor'
  | 'discovery' | 'decision' | 'change';

export type DocType =
  | 'memory_file' | 'skill_section' | 'skill_summary'
  | 'observation' | 'session_summary' | 'mem_md_stub';

export interface Document {
  id: number;
  source_path: string;
  channel: ChannelType;
  project_id: string;
  sha: string;
  mtime_epoch: number;
  last_indexed_epoch: number;
  metadata: Record<string, unknown>;
}

export interface Chunk {
  id: number;
  document_id: number;
  chunk_id: string;          // Stable, exposed externally
  text: string;
  sha: string;
  position: number;
  metadata: Record<string, unknown>;
}

export interface ChunkInput {
  text: string;
  position: number;
  metadata: Record<string, unknown>;
}

export interface Hit {
  doc_id: string;
  source_path: string;
  title: string;
  snippet: string;
  score: number;             // 0-1, RRF-fused
  channel: ChannelType;
  metadata: Record<string, unknown>;
}

export interface SearchOptions {
  query: string;
  top_k?: number;
  channels?: ChannelType[];
  type?: string;
  files?: string[];
  since?: string;
  project?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Plan-2 additions: observation pipeline + injection envelope.
// ─────────────────────────────────────────────────────────────────────

/**
 * Raw event captured by the PostToolUse hook. Lossless echo of what Claude
 * Code passed to the hook; the worker is responsible for any redaction.
 */
export interface RawObservationEvent {
  session_id: string;
  project_id: string;
  prompt_number: number;       // 1-based index within the session
  tool_name: string;
  tool_input_summary: string;  // ≤ 2000 chars; truncate at hook before send
  tool_result_summary: string; // ≤ 2000 chars
  files_read: string[];
  files_modified: string[];
  ts_epoch: number;            // hook capture time, seconds
  /** Git branch at capture cwd, or null when not in a git repo. */
  branch?: string | null;
  /** Origin of the observation: "post-tool-use" (default), "pre-compact", etc. */
  source?: string;
}

/**
 * Final-form Observation produced by the Haiku summarizer from a window
 * of RawObservationEvent rows. Stored in `observations` table and chunked
 * via chunkObservation() for vector indexing.
 */
export interface Observation {
  id: number;                  // SQLite rowid; populated post-insert
  session_id: string;
  project_id: string;
  prompt_number: number;
  type: ObservationType;
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  created_at_epoch: number;
  /** Git branch active when the observation was captured, or null. */
  branch: string | null;
  /** Total tokens the summarizer spent producing this observation (input + output).
   *  Null for pre-v0.1.6 captures and migrated observations without a token record. */
  work_tokens: number | null;
  /** Token count of the observation's rendered chunk text — the cost paid in
   *  the corpus to store it. Populated at index time; null until then and for
   *  observations indexed before v0.1.9. */
  stored_tokens: number | null;
}

/** Status enum for the observation_queue rows. */
export type ObservationQueueStatus = 'pending' | 'processing' | 'done' | 'failed';

/** A single hit as it appears inside the <memory-context> envelope. */
export interface EnvelopeHit {
  doc_id: string;
  channel: ChannelType;
  source_path: string;
  title: string;
  snippet: string;
  score: number;
  metadata: Record<string, unknown>;
}

/** Payload returned by /inject/context. */
export interface EnvelopePayload {
  envelope: string;            // The literal <memory-context>…</memory-context> block
  hit_count: number;
  budget_tokens: number;
  used_tokens: number;
  channels_searched: ChannelType[];
  degradation_flags: string[]; // e.g. "embedder=voyage-4-nano:keyword-fallback=true"
  elapsed_ms: number;
}
