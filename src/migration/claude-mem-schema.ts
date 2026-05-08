import { homedir } from 'os';
import { join } from 'path';

export const CLAUDE_MEM_DEFAULT_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');

export const CLAUDE_MEM_TABLES = [
  'sdk_sessions',
  'observations',
  'session_summaries',
  'user_prompts',
  'pending_messages',
  'schema_versions',
] as const;

export type ClaudeMemTable = typeof CLAUDE_MEM_TABLES[number];

/**
 * Row shape of the `observations` table. JSON columns (facts/concepts/files_*) are stored as
 * TEXT in SQLite — callers must `JSON.parse` them. `created_at_epoch` is in MILLISECONDS.
 */
export interface ClaudeMemObservationRow {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;            // bugfix | change | decision | discovery | feature | refactor
  title: string | null;
  subtitle: string | null;
  facts: string | null;            // JSON-encoded string[]
  narrative: string | null;
  concepts: string | null;         // JSON-encoded string[]
  files_read: string | null;       // JSON-encoded string[]
  files_modified: string | null;   // JSON-encoded string[]
  prompt_number: number | null;
  discovery_tokens: number | null;
  created_at: string;
  created_at_epoch: number;        // MILLISECONDS
}

export interface ClaudeMemSessionSummaryRow {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
  prompt_number: number | null;
  discovery_tokens: number | null;
  created_at: string;
  created_at_epoch: number;        // MILLISECONDS
}

export interface ClaudeMemSdkSessionRow {
  id: number;
  content_session_id: string;
  memory_session_id: string | null;
  project: string;
  user_prompt: string | null;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: 'active' | 'completed' | 'failed';
}

export interface ClaudeMemRowCounts {
  sdk_sessions: number;
  observations: number;
  session_summaries: number;
  user_prompts: number;
  pending_messages: number;
}
