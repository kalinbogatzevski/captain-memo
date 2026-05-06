import type { ChunkInput, ObservationType } from '../../shared/types.ts';

export interface Observation {
  id: number;
  session_id: string;
  project_id: string;
  type: ObservationType;
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  created_at_epoch: number;
  prompt_number: number;
}

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
  };

  const chunks: ChunkInput[] = [];
  let position = 0;

  if (obs.narrative.trim()) {
    chunks.push({
      text: obs.narrative,
      position: position++,
      metadata: { ...baseMetadata, field_type: 'narrative' },
    });
  }

  for (let i = 0; i < obs.facts.length; i++) {
    const fact = obs.facts[i]!;
    if (!fact.trim()) continue;
    chunks.push({
      text: fact,
      position: position++,
      metadata: { ...baseMetadata, field_type: 'fact', fact_index: i },
    });
  }

  return chunks;
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
