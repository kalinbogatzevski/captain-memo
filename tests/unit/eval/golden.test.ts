import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseGolden, seedFromRecallAudit } from '../../../src/eval/golden.ts';

test('parseGolden loads valid entries and rejects bad ones', () => {
  const jsonl = readFileSync(join(import.meta.dir, '../../fixtures/eval/golden.seed.jsonl'), 'utf8');
  const entries = parseGolden(jsonl);
  expect(entries.length).toBe(3);
  expect(entries[0]!.class).toBe('temporal');
  expect(entries[0]!.entity).toBe('talq');
  expect(() => parseGolden('{"id":"x","query":"q","class":"bogus"}')).toThrow();
});

test('seedFromRecallAudit frequency-ranks distinct queries', () => {
  const audit = [
    '{"ts":1,"query":"alpha","hits":[]}',
    '{"ts":2,"query":"beta","hits":[]}',
    '{"ts":3,"query":"alpha","hits":[]}',
  ].join('\n');
  const seeded = seedFromRecallAudit(audit, 10);
  expect(seeded[0]).toEqual({ query: 'alpha', count: 2 });
  expect(seeded[1]).toEqual({ query: 'beta', count: 1 });
});
