import { test, expect } from 'bun:test';
import { newChunkId, parseDocId } from '../../src/shared/id.ts';

test('newChunkId — produces channel-prefixed id', () => {
  const id = newChunkId('memory', 'feedback_test');
  expect(id).toMatch(/^memory:feedback_test:[A-Za-z0-9_-]{8}$/);
});

test('newChunkId — same source produces different ids on multiple calls', () => {
  const a = newChunkId('memory', 'x');
  const b = newChunkId('memory', 'x');
  expect(a).not.toBe(b);
});

test('parseDocId — extracts channel and source', () => {
  const parsed = parseDocId('memory:feedback_test:abc12345');
  expect(parsed).toEqual({ channel: 'memory', source: 'feedback_test', shortId: 'abc12345' });
});

test('parseDocId — returns null on malformed input', () => {
  expect(parseDocId('not-a-doc-id')).toBeNull();
});
