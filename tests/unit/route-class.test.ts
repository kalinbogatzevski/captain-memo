import { test, expect } from 'bun:test';
import { classifyRoute } from '../../src/worker/route-class.ts';

test('reads route to the pool', () => {
  for (const [m, p] of [
    ['POST', '/search/all'], ['POST', '/search/memory'], ['POST', '/search/skill'],
    ['POST', '/search/observations'], ['POST', '/get_full'], ['GET', '/observation/full'],
    ['POST', '/inject/context'], ['GET', '/observations/recent'], ['GET', '/recall/list'],
  ] as const) {
    expect(classifyRoute(m, p)).toBe('read');
  }
});

test('writes and writer-stateful reads route to the writer', () => {
  for (const [m, p] of [
    ['POST', '/reindex'], ['POST', '/observation/enqueue'], ['POST', '/observation/flush'],
    ['GET', '/stats'], ['GET', '/pending_embed/retry'], ['POST', '/shutdown'],
    ['GET', '/test/block'],
  ] as const) {
    expect(classifyRoute(m, p)).toBe('write');
  }
});

test('/health is control (answered by main)', () => {
  expect(classifyRoute('GET', '/health')).toBe('control');
});

test('unknown paths route to the writer (safe default)', () => {
  expect(classifyRoute('POST', '/whatever')).toBe('write');
  expect(classifyRoute('GET', '/nope')).toBe('write');
});
