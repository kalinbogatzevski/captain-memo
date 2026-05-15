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

test('transformObservation — emits 1 bundled chunk per observation (v0.1.8)', () => {
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

  expect(doc.chunks).toHaveLength(1);
  expect(doc.chunks[0]!.metadata.field_type).toBe('observation');

  // Bundled text contains type prefix, title, narrative, and all non-empty facts
  const text = doc.chunks[0]!.text;
  expect(text).toContain('[discovery] Found a bug in cashbox');
  expect(text).toContain('A short narrative.');
  expect(text).toContain('• Fact one.');
  expect(text).toContain('• Fact two.');
  // The empty fact is dropped — fact_count reflects 2, not 3
  expect(doc.chunks[0]!.metadata.fact_count).toBe(2);

  // base metadata propagated (migration-specific fields land here too)
  expect(doc.chunks[0]!.metadata.observation_id).toBe(42);
  expect(doc.chunks[0]!.metadata.session_id).toBe('sess-abc');
  expect(doc.chunks[0]!.metadata.type).toBe('discovery');
  expect(doc.chunks[0]!.metadata.migrated_from).toBe('claude-mem');
});

test('transformObservation — observation with only facts (no narrative) still produces 1 chunk', () => {
  const doc = transformObservation({
    id: 1, memory_session_id: 's', project: 'p', text: null, type: 'bugfix',
    title: 't', subtitle: null, facts: JSON.stringify(['only-fact']),
    narrative: '', concepts: null, files_read: null, files_modified: null,
    prompt_number: 0, discovery_tokens: 0, created_at: '', created_at_epoch: 1000,
  }, 'erp-platform');
  expect(doc.chunks).toHaveLength(1);
  expect(doc.chunks[0]!.text).toContain('[bugfix] t');
  expect(doc.chunks[0]!.text).toContain('• only-fact');
});

test('transformObservation — invalid JSON in facts handled gracefully', () => {
  const doc = transformObservation({
    id: 7, memory_session_id: 's', project: 'p', text: null, type: 'feature',
    title: 't', subtitle: null, facts: 'not-valid-json',
    narrative: 'hello', concepts: null, files_read: null, files_modified: null,
    prompt_number: 0, discovery_tokens: 0, created_at: '', created_at_epoch: 1000,
  }, 'erp-platform');
  expect(doc.chunks).toHaveLength(1);
  expect(doc.chunks[0]!.text).toContain('hello');
  expect(doc.chunks[0]!.metadata.fact_count).toBe(0);
});

test('transformSessionSummary — bundles all non-empty fields into a single chunk', () => {
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
  expect(doc.chunks).toHaveLength(1);
  expect(doc.chunks[0]!.metadata.field_type).toBe('session_summary');

  const text = doc.chunks[0]!.text;
  expect(text).toContain('[session_summary]');
  expect(text).toContain('Request:\nFind the bug.');
  expect(text).toContain('Investigated:\nRead X.');
  expect(text).toContain('Completed:\nFixed Y.');
  expect(text).toContain('Next steps:\nDeploy.');
  // Empty fields are dropped, not emitted as empty headers
  expect(text).not.toContain('Learned:');
  expect(text).not.toContain('Notes:');
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
