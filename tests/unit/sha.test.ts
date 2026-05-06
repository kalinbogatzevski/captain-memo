import { test, expect } from 'bun:test';
import { sha256Hex } from '../../src/shared/sha.ts';

test('sha256Hex — produces stable hex digest', () => {
  expect(sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
});

test('sha256Hex — different inputs produce different digests', () => {
  expect(sha256Hex('hello')).not.toBe(sha256Hex('hello!'));
});

test('sha256Hex — handles empty string', () => {
  expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
