import type { ChunkInput, Observation } from '../../shared/types.ts';

export interface SessionSummary {
  id: number;
  session_id: string;
  project_id: string;
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string;
  created_at_epoch: number;
  prompt_number: number;
}

export function chunkObservation(obs: Observation): ChunkInput[] {
  const baseMetadata: Record<string, unknown> = {
    doc_type: 'observation',
    observation_id: obs.id,
    session_id: obs.session_id,
    project_id: obs.project_id,
    type: obs.type,
    title: obs.title,
    concepts: obs.concepts,
    files_read: obs.files_read,
    files_modified: obs.files_modified,
    created_at_epoch: obs.created_at_epoch,
    prompt_number: obs.prompt_number,
    work_tokens: obs.work_tokens ?? null,
  };

  // Single chunk per observation: title + narrative + facts bundled together.
  // Pre-0.1.8 the chunker emitted one chunk per fact, which paid ~4 KB of
  // vector storage per ~93 chars of text (44:1 overhead). FTS5 still indexes
  // every fact word for keyword recall; semantic recall now hits at the
  // observation level rather than the per-fact level.
  const facts = obs.facts.map(f => f.trim()).filter(Boolean);
  const parts: string[] = [];
  // Structural header gives the embedder a stable typed prefix — voyage's
  // training data is heavy on tagged documents, and `[bugfix] foo` ranks
  // distinct from `[feature] foo` in semantic space even when the body is
  // similar.
  const typeTag = obs.type ? `[${obs.type}] ` : '';
  if (obs.title.trim()) parts.push(typeTag + obs.title.trim());
  if (obs.narrative.trim()) parts.push(obs.narrative.trim());
  if (facts.length > 0) parts.push(facts.map(f => `• ${f}`).join('\n'));
  const text = parts.join('\n\n');
  if (!text) return [];

  return [{
    text,
    position: 0,
    metadata: { ...baseMetadata, field_type: 'observation', fact_count: facts.length },
  }];
}

const SUMMARY_FIELDS = ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'] as const;

export function chunkSummary(summary: SessionSummary): ChunkInput[] {
  const baseMetadata: Record<string, unknown> = {
    doc_type: 'session_summary',
    summary_id: summary.id,
    session_id: summary.session_id,
    project_id: summary.project_id,
    created_at_epoch: summary.created_at_epoch,
    prompt_number: summary.prompt_number,
  };

  const chunks: ChunkInput[] = [];
  let position = 0;

  for (const field of SUMMARY_FIELDS) {
    const text = summary[field];
    if (!text || !text.trim()) continue;
    chunks.push({
      text,
      position: position++,
      metadata: { ...baseMetadata, field_type: field },
    });
  }

  return chunks;
}
