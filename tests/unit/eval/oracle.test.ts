import { test, expect } from 'bun:test';
import { matchesEntity, freshestDoc, staleEntityDocs } from '../../../src/eval/oracle.ts';

const docs = [
  { doc_id: 'old', created_at_epoch: 100, text: 'TalQ v0.6.0 released' },
  { doc_id: 'new', created_at_epoch: 300, text: 'talq v0.51.12 on master' },
  { doc_id: 'mid', created_at_epoch: 200, text: 'TalQ v0.23.0' },
  { doc_id: 'other', created_at_epoch: 999, text: 'unrelated note' },
];

test('matchesEntity is case-insensitive substring', () => {
  expect(matchesEntity(docs[0]!, 'talq')).toBe(true);
  expect(matchesEntity(docs[3]!, 'talq')).toBe(false);
});
test('freshestDoc picks max created_at among entity matches (ignores newer non-matches)', () => {
  expect(freshestDoc(docs, 'talq')?.doc_id).toBe('new');
});
test('staleEntityDocs = all entity matches except the freshest', () => {
  expect(staleEntityDocs(docs, 'talq')).toEqual(new Set(['old', 'mid']));
});
test('freshestDoc undefined when no entity match', () => {
  expect(freshestDoc(docs, 'zzz')).toBeUndefined();
});
