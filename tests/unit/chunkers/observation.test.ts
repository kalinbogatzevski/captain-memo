import { test, expect } from 'bun:test';
import { chunkObservation, chunkSummary } from '../../../src/worker/chunkers/observation.ts';

const observation = {
  id: 1234,
  session_id: 'sess-abc',
  project_id: 'erp-platform',
  type: 'bugfix' as const,
  title: 'Fixed locked form-field display bug',
  narrative: 'The bug was caused by hardcoded fallback. Smart default fixed it.',
  facts: [
    'Root cause was hardcoded fallback in form renderer',
    'Smart default approach validated in GLAB#366',
  ],
  concepts: ['gotcha', 'pattern'],
  files_read: ['core/inc/forms.php'],
  files_modified: ['core/modules/admin/forms/render.php'],
  created_at_epoch: 1714838400,
  prompt_number: 12,
};

test('chunkObservation — produces 1 narrative chunk + 1 chunk per fact', () => {
  const chunks = chunkObservation(observation);
  expect(chunks).toHaveLength(3); // 1 narrative + 2 facts
});

test('chunkObservation — narrative chunk has narrative text + correct field_type', () => {
  const chunks = chunkObservation(observation);
  const narrative = chunks.find(c => c.metadata.field_type === 'narrative');
  expect(narrative).toBeDefined();
  expect(narrative!.text).toBe(observation.narrative);
});

test('chunkObservation — fact chunks each have one fact + index', () => {
  const chunks = chunkObservation(observation);
  const facts = chunks.filter(c => c.metadata.field_type === 'fact');
  expect(facts).toHaveLength(2);
  expect(facts[0]!.text).toBe(observation.facts[0]!);
  expect(facts[0]!.metadata.fact_index).toBe(0);
  expect(facts[1]!.metadata.fact_index).toBe(1);
});

test('chunkObservation — metadata propagates type, files, project', () => {
  const chunks = chunkObservation(observation);
  for (const chunk of chunks) {
    expect(chunk.metadata.observation_id).toBe(1234);
    expect(chunk.metadata.session_id).toBe('sess-abc');
    expect(chunk.metadata.type).toBe('bugfix');
    expect(chunk.metadata.files_modified).toEqual(['core/modules/admin/forms/render.php']);
  }
});

test('chunkSummary — 1 chunk per non-empty field', () => {
  const summary = {
    id: 99,
    session_id: 'sess-abc',
    project_id: 'erp-platform',
    request: 'Fix locked form fields',
    investigated: 'Traced the rendering path',
    learned: 'Hardcoded fallback is dangerous',
    completed: 'Patched the renderer',
    next_steps: '',
    notes: '',
    created_at_epoch: 1714838400,
    prompt_number: 12,
  };
  const chunks = chunkSummary(summary);
  expect(chunks).toHaveLength(4); // 4 non-empty fields
  const fieldTypes = chunks.map(c => c.metadata.field_type as string);
  expect(fieldTypes).toEqual(['request', 'investigated', 'learned', 'completed']);
});
