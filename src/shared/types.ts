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
