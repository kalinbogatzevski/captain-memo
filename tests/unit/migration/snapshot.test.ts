import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  transformObservation,
  transformSessionSummary,
} from '../../../src/migration/transform.ts';
import type {
  ClaudeMemObservationRow,
  ClaudeMemSessionSummaryRow,
} from '../../../src/migration/claude-mem-schema.ts';

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/claude-mem-mini/claude-mem-fixture.db',
);

test('snapshot — fixture observation #1 produces a single bundled chunk (v0.1.8)', () => {
  const db = new Database(fixturePath, { readonly: true });
  const row = db
    .query('SELECT * FROM observations WHERE id = 1')
    .get() as ClaudeMemObservationRow;
  db.close();
  const doc = transformObservation(row, 'erp-platform');
  expect(doc.chunks).toHaveLength(1);
  expect(doc.chunks[0]!.metadata.field_type).toBe('observation');
  expect(doc.chunks[0]!.text).toContain('Looking at geomap.');
  expect(doc.metadata.source_id).toBe(1);
});

test('snapshot — fixture observation #4 (no narrative, no title) still bundles facts into 1 chunk', () => {
  const db = new Database(fixturePath, { readonly: true });
  const row = db
    .query('SELECT * FROM observations WHERE id = 4')
    .get() as ClaudeMemObservationRow;
  db.close();
  const doc = transformObservation(row, 'erp-platform');
  expect(doc.chunks).toHaveLength(1);
  // Fact-only content still lands in the bundled observation chunk
  expect(doc.chunks[0]!.metadata.field_type).toBe('observation');
});

test('snapshot — fixture summary #100 bundles non-empty fields into a single chunk', () => {
  const db = new Database(fixturePath, { readonly: true });
  const row = db
    .query('SELECT * FROM session_summaries WHERE id = 100')
    .get() as ClaudeMemSessionSummaryRow;
  db.close();
  const doc = transformSessionSummary(row, 'erp-platform');
  expect(doc.chunks).toHaveLength(1);
  expect(doc.chunks[0]!.metadata.field_type).toBe('session_summary');
  const text = doc.chunks[0]!.text;
  expect(text).toContain('[session_summary]');
  // 'RTFM' was the lone token in the learned field per the original fixture commentary
  expect(text).toContain('RTFM');
});
