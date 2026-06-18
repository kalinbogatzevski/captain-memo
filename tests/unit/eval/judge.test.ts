// tests/unit/eval/judge.test.ts
import { test, expect } from 'bun:test';
import { makeJudge, gradeFromReply } from '../../../src/eval/judge.ts';

test('gradeFromReply parses and clamps 0..3', () => {
  expect(gradeFromReply('3')).toBe(3);
  expect(gradeFromReply('Grade: 2')).toBe(2);
  expect(gradeFromReply('9')).toBe(3);
  expect(gradeFromReply('nope')).toBe(0);
});

test('judge caches: identical (query, doc) calls the LLM once', async () => {
  let calls = 0;
  const judge = makeJudge({ call: async () => { calls++; return '2'; }, cache: new Map() });
  expect(await judge('q', 'doc text')).toBe(2);
  expect(await judge('q', 'doc text')).toBe(2);
  expect(calls).toBe(1);
});

test('judge distinguishes different docs', async () => {
  let calls = 0;
  const judge = makeJudge({ call: async () => { calls++; return '1'; }, cache: new Map() });
  await judge('q', 'doc A');
  await judge('q', 'doc B');
  expect(calls).toBe(2);
});
