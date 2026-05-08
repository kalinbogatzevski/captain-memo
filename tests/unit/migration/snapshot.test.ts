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

test('snapshot — fixture observation #1 produces narrative + 2 fact chunks', () => {
  const db = new Database(fixturePath, { readonly: true });
  const row = db
    .query('SELECT * FROM observations WHERE id = 1')
    .get() as ClaudeMemObservationRow;
  db.close();
  const doc = transformObservation(row, 'erp-platform');
  expect(doc.chunks).toHaveLength(3);
  expect(doc.chunks[0]!.text).toBe('Looking at geomap.');
  expect(doc.metadata.source_id).toBe(1);
});

test('snapshot — fixture observation #4 (empty narrative + empty title) keeps fact', () => {
  const db = new Database(fixturePath, { readonly: true });
  const row = db
    .query('SELECT * FROM observations WHERE id = 4')
    .get() as ClaudeMemObservationRow;
  db.close();
  const doc = transformObservation(row, 'erp-platform');
  expect(doc.chunks).toHaveLength(1);
  expect(doc.chunks[0]!.metadata.field_type).toBe('fact');
});

test('snapshot — fixture summary #100 produces all 5 non-empty fields', () => {
  const db = new Database(fixturePath, { readonly: true });
  const row = db
    .query('SELECT * FROM session_summaries WHERE id = 100')
    .get() as ClaudeMemSessionSummaryRow;
  db.close();
  const doc = transformSessionSummary(row, 'erp-platform');
  // notes is '', learned has 'RTFM', request/investigated/completed/next_steps all set
  expect(doc.chunks).toHaveLength(5);
});
