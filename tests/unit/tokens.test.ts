import { test, expect } from 'bun:test';
import { countTokens } from '../../src/shared/tokens.ts';

test('countTokens — counts ASCII text', () => {
  expect(countTokens('hello world')).toBe(2);
});

test('countTokens — handles empty string', () => {
  expect(countTokens('')).toBe(0);
});

test('countTokens — counts multibyte (Bulgarian)', () => {
  // "Здравей" should produce multiple tokens
  expect(countTokens('Здравей')).toBeGreaterThan(1);
});

test('countTokens — long text scales roughly linearly', () => {
  const short = countTokens('hello world');
  const long = countTokens('hello world '.repeat(100));
  expect(long).toBeGreaterThan(short * 50);
});
