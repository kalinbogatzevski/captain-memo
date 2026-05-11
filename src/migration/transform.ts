import { sha256Hex } from '../shared/sha.ts';
import type { ChannelType } from '../shared/types.ts';
import type {
  ClaudeMemObservationRow,
  ClaudeMemSessionSummaryRow,
} from './claude-mem-schema.ts';

/**
 * Output of a single migration transform — one logical document
 * that the runner will pass to MetaStore.upsertDocument + replaceChunksForDocument.
 */
export interface MigrationChunk {
  text: string;
  position: number;
  metadata: Record<string, unknown>;
}

export interface MigrationDocument {
  source_path: string;       // claude-mem://observation/<id> or claude-mem://summary/<id>
  channel: ChannelType;      // always 'observation' for claude-mem rows
  project_id: string;
  mtime_epoch: number;       // seconds
  metadata: Record<string, unknown>;
  chunks: MigrationChunk[];
}

export function millisecondsToSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function safeParseJsonArray(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string')
      : [];
  } catch {
    return [];
  }
}

export function transformObservation(
  row: ClaudeMemObservationRow,
  projectId: string,
): MigrationDocument {
  const facts = safeParseJsonArray(row.facts);
  const concepts = safeParseJsonArray(row.concepts);
  const filesRead = safeParseJsonArray(row.files_read);
  const filesModified = safeParseJsonArray(row.files_modified);
  const mtime = millisecondsToSeconds(row.created_at_epoch);

  const baseMetadata: Record<string, unknown> = {
    doc_type: 'observation',
    observation_id: row.id,
    session_id: row.memory_session_id,
    project_id: projectId,
    source_project: row.project,
    type: row.type,
    title: row.title ?? '',
    concepts,
    files_read: filesRead,
    files_modified: filesModified,
    created_at_epoch: mtime,
    prompt_number: row.prompt_number ?? 0,
    // Tokens originally spent producing this observation (claude-mem's own
    // accounting). Used downstream to compute "savings" stats — work cost vs
    // recall cost. Defaulting to 0 if absent (older claude-mem rows).
    discovery_tokens: row.discovery_tokens ?? 0,
    // work_tokens mirrors captain-memo's native field for the savings badge.
    // Migrated rows inherit claude-mem's discovery_tokens as their work cost.
    work_tokens: row.discovery_tokens ? Number(row.discovery_tokens) : null,
    migrated_from: 'claude-mem',
  };

  const chunks: MigrationChunk[] = [];
  let position = 0;

  const narrative = (row.narrative ?? '').trim();
  if (narrative) {
    chunks.push({
      text: narrative,
      position: position++,
      metadata: { ...baseMetadata, field_type: 'narrative' },
    });
  }

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i]!.trim();
    if (!fact) continue;
    chunks.push({
      text: fact,
      position: position++,
      metadata: { ...baseMetadata, field_type: 'fact', fact_index: i },
    });
  }

  return {
    source_path: `claude-mem://observation/${row.id}`,
    channel: 'observation',
    project_id: projectId,
    mtime_epoch: mtime,
    metadata: { kind: 'observation', source_id: row.id, ...baseMetadata },
    chunks,
  };
}

const SUMMARY_FIELDS = [
  'request', 'investigated', 'learned',
  'completed', 'next_steps', 'notes',
] as const;

export function transformSessionSummary(
  row: ClaudeMemSessionSummaryRow,
  projectId: string,
): MigrationDocument {
  const mtime = millisecondsToSeconds(row.created_at_epoch);

  const baseMetadata: Record<string, unknown> = {
    doc_type: 'session_summary',
    summary_id: row.id,
    session_id: row.memory_session_id,
    project_id: projectId,
    source_project: row.project,
    created_at_epoch: mtime,
    prompt_number: row.prompt_number ?? 0,
    discovery_tokens: row.discovery_tokens ?? 0,
    migrated_from: 'claude-mem',
  };

  const chunks: MigrationChunk[] = [];
  let position = 0;
  for (const field of SUMMARY_FIELDS) {
    const text = (row[field] ?? '').trim();
    if (!text) continue;
    chunks.push({
      text,
      position: position++,
      metadata: { ...baseMetadata, field_type: field },
    });
  }

  return {
    source_path: `claude-mem://summary/${row.id}`,
    channel: 'observation',
    project_id: projectId,
    mtime_epoch: mtime,
    metadata: { kind: 'session_summary', source_id: row.id, ...baseMetadata },
    chunks,
  };
}

/** Stable SHA over the full document (for idempotence checks in the runner). */
export function migrationDocumentSha(doc: MigrationDocument): string {
  const concat = doc.chunks.map(c => `${c.position}:${c.text}`).join('');
  return sha256Hex(`${doc.source_path}${concat}`);
}
