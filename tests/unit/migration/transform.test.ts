import { test, expect } from 'bun:test';
import {
  transformObservation,
  transformSessionSummary,
  millisecondsToSeconds,
  type MigrationDocument,
} from '../../../src/migration/transform.ts';

test('millisecondsToSeconds — divides and floors', () => {
  expect(millisecondsToSeconds(1770566467173)).toBe(1770566467);
  expect(millisecondsToSeconds(0)).toBe(0);
});

test('transformObservation — emits 1 narrative chunk + N fact chunks', () => {
  const doc: MigrationDocument = transformObservation({
    id: 42,
    memory_session_id: 'sess-abc',
    project: '123net_erp',
    text: null,
    type: 'discovery',
    title: 'Found a bug in cashbox',
    subtitle: null,
    facts: JSON.stringify(['Fact one.', 'Fact two.', '']),
    narrative: 'A short narrative.',
    concepts: JSON.stringify(['cashbox', 'rounding']),
    files_read: JSON.stringify(['cashbox.php']),
    files_modified: JSON.stringify([]),
    prompt_number: 5,
    discovery_tokens: 0,
    created_at: '2026-05-07T07:01:07Z',
    created_at_epoch: 1770566467173,
  }, 'erp-platform');

  expect(doc.channel).toBe('observation');
  expect(doc.project_id).toBe('erp-platform');
  expect(doc.source_path).toBe('claude-mem://observation/42');
  expect(doc.metadata.source_id).toBe(42);
  expect(doc.mtime_epoch).toBe(1770566467); // ms → s

  // 1 narrative + 2 non-empty facts (empty fact dropped)
  expect(doc.chunks).toHaveLength(3);
  expect(doc.chunks[0]!.metadata.field_type).toBe('narrative');
  expect(doc.chunks[1]!.metadata.field_type).toBe('fact');
  expect(doc.chunks[1]!.metadata.fact_index).toBe(0);
  expect(doc.chunks[2]!.metadata.fact_index).toBe(1);

  // base metadata propagated to chunks
  expect(doc.chunks[0]!.metadata.observation_id).toBe(42);
  expect(doc.chunks[0]!.metadata.session_id).toBe('sess-abc');
  expect(doc.chunks[0]!.metadata.type).toBe('discovery');
});

test('transformObservation — empty narrative skipped', () => {
  const doc = transformObservation({
    id: 1, memory_session_id: 's', project: 'p', text: null, type: 'bugfix',
    title: 't', subtitle: null, facts: JSON.stringify(['only-fact']),
    narrative: '', concepts: null, files_read: null, files_modified: null,
    prompt_number: 0, discovery_tokens: 0, created_at: '', created_at_epoch: 1000,
  }, 'erp-platform');
  expect(doc.chunks).toHaveLength(1);
  expect(doc.chunks[0]!.metadata.field_type).toBe('fact');
});

test('transformObservation — invalid JSON in facts handled gracefully', () => {
  const doc = transformObservation({
    id: 7, memory_session_id: 's', project: 'p', text: null, type: 'feature',
    title: 't', subtitle: null, facts: 'not-valid-json',
    narrative: 'hello', concepts: null, files_read: null, files_modified: null,
    prompt_number: 0, discovery_tokens: 0, created_at: '', created_at_epoch: 1000,
  }, 'erp-platform');
  expect(doc.chunks).toHaveLength(1); // narrative only — no facts
});

test('transformSessionSummary — emits one chunk per non-empty field', () => {
  const doc = transformSessionSummary({
    id: 100, memory_session_id: 'sess-xyz', project: '123net_erp',
    request: 'Find the bug.',
    investigated: 'Read X.',
    learned: '',
    completed: 'Fixed Y.',
    next_steps: 'Deploy.',
    files_read: null, files_edited: null,
    notes: '',
    prompt_number: 12, discovery_tokens: 0,
    created_at: '', created_at_epoch: 1770566467000,
  }, 'erp-platform');

  expect(doc.channel).toBe('observation');
  expect(doc.source_path).toBe('claude-mem://summary/100');
  expect(doc.chunks).toHaveLength(4); // request, investigated, completed, next_steps
  const fieldTypes = doc.chunks.map(c => c.metadata.field_type);
  expect(fieldTypes).toEqual(['request', 'investigated', 'completed', 'next_steps']);
});

test('transformSessionSummary — all-empty produces zero chunks (skip case)', () => {
  const doc = transformSessionSummary({
    id: 1, memory_session_id: 's', project: 'p',
    request: '', investigated: null, learned: '', completed: null,
    next_steps: '', notes: '',
    files_read: null, files_edited: null,
    prompt_number: 0, discovery_tokens: 0,
    created_at: '', created_at_epoch: 1000,
  }, 'erp-platform');
  expect(doc.chunks).toHaveLength(0);
});
