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
  branch: null,
  work_tokens: null,
};

test('chunkObservation — produces a single bundled chunk per observation (v0.1.8)', () => {
  const chunks = chunkObservation(observation);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.metadata.field_type).toBe('observation');
});

test('chunkObservation — bundled chunk contains type prefix, title, narrative, and all facts', () => {
  const [chunk] = chunkObservation(observation);
  const text = chunk!.text;
  expect(text).toContain('[bugfix] Fixed locked form-field display bug');
  expect(text).toContain(observation.narrative);
  for (const fact of observation.facts) {
    expect(text).toContain(fact);
  }
});

test('chunkObservation — facts are bulleted in the bundled text', () => {
  const [chunk] = chunkObservation(observation);
  expect(chunk!.text).toMatch(/• Root cause was hardcoded/);
  expect(chunk!.text).toMatch(/• Smart default approach/);
});

test('chunkObservation — fact_count metadata reflects the number of facts merged', () => {
  const [chunk] = chunkObservation(observation);
  expect(chunk!.metadata.fact_count).toBe(2);
});

test('chunkObservation — metadata propagates type, files, project, observation_id', () => {
  const [chunk] = chunkObservation(observation);
  expect(chunk!.metadata.observation_id).toBe(1234);
  expect(chunk!.metadata.session_id).toBe('sess-abc');
  expect(chunk!.metadata.type).toBe('bugfix');
  expect(chunk!.metadata.files_modified).toEqual(['core/modules/admin/forms/render.php']);
});

test('chunkObservation — observation with only a narrative still produces one chunk', () => {
  const narrativeOnly = { ...observation, facts: [], title: '' };
  const chunks = chunkObservation(narrativeOnly);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.text).toBe(observation.narrative);
});

test('chunkObservation — empty observation produces zero chunks', () => {
  const empty = { ...observation, title: '', narrative: '', facts: [] };
  expect(chunkObservation(empty)).toHaveLength(0);
});

test('chunkSummary — 1 chunk per non-empty field (legacy summary chunker)', () => {
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
  expect(chunks).toHaveLength(4);
  const fieldTypes = chunks.map(c => c.metadata.field_type as string);
  expect(fieldTypes).toEqual(['request', 'investigated', 'learned', 'completed']);
});
