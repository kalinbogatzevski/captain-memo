import { test, expect } from 'bun:test';
import { resolveSummarizerProvider } from '../../src/shared/summarizer-provider.ts';

test('recognizes every valid provider', () => {
  for (const p of ['claude-oauth', 'claude-code', 'openai-compatible', 'anthropic', 'codex', 'agy'] as const) {
    expect(resolveSummarizerProvider(p)).toEqual({ provider: p });
  }
});

test('accepts the documented aliases', () => {
  expect(resolveSummarizerProvider('openai').provider).toBe('openai-compatible');
  expect(resolveSummarizerProvider('antigravity').provider).toBe('agy');
});

test('is case- and whitespace-insensitive', () => {
  expect(resolveSummarizerProvider('  CODEX  ').provider).toBe('codex');
  expect(resolveSummarizerProvider('Agy').provider).toBe('agy');
});

test('undefined → default provider, no warning', () => {
  const r = resolveSummarizerProvider(undefined);
  expect(r.provider).toBe('claude-oauth');
  expect(r.warning).toBeUndefined();
});

test('a COMBINED value ("codex,agy") is the "tried to set both" case — warns and calls it out', () => {
  const r = resolveSummarizerProvider('codex,agy');
  expect(r.provider).toBe('claude-oauth');                 // safe default
  expect(r.warning).toContain('more than one provider');   // names the actual mistake
  expect(r.warning).toContain('only ONE is supported');
  expect(r.warning).toContain('claude-oauth | codex | agy'); // lists the valid values
});

test('an unrecognized value warns with the valid list', () => {
  const r = resolveSummarizerProvider('gpt4');
  expect(r.provider).toBe('claude-oauth');
  expect(r.warning).toContain('unrecognized value "gpt4"');
  expect(r.warning).toContain('claude-oauth | codex | agy | anthropic | claude-code | openai-compatible');
  // and it must warn that the fallback needs Claude, so a no-Claude box isn't silently dead
  expect(r.warning).toContain('needs a Claude login');
});
