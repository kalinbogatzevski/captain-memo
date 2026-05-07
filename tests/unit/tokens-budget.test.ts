import { test, expect } from 'bun:test';
import { countTokens, truncateToTokenBudget } from '../../src/shared/tokens.ts';

test('truncateToTokenBudget — short input returns unchanged', () => {
  const text = 'Hello, world.';
  const out = truncateToTokenBudget(text, 100);
  expect(out).toBe(text);
});

test('truncateToTokenBudget — long input is shorter and respects budget', () => {
  const text = 'lorem ipsum '.repeat(2000);
  const before = countTokens(text);
  const out = truncateToTokenBudget(text, 100);
  const after = countTokens(out);
  expect(after).toBeLessThanOrEqual(100);
  expect(after).toBeLessThan(before);
});

test('truncateToTokenBudget — appends truncation marker when truncated', () => {
  const text = 'foo bar baz '.repeat(2000);
  const out = truncateToTokenBudget(text, 50);
  expect(out.endsWith('… [truncated]')).toBe(true);
});

test('truncateToTokenBudget — budget=0 returns just the marker', () => {
  expect(truncateToTokenBudget('anything', 0)).toBe('… [truncated]');
});
