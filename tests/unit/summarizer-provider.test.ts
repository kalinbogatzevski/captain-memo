import { test, expect } from 'bun:test';
import { resolveSummarizerProvider, resolveSummarizerProviders } from '../../src/shared/summarizer-provider.ts';

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

// ---------------------------------------------------------------------------
// A comma used to be an ERROR here ("only ONE is supported"), which quietly fell back to
// claude-oauth — on a box with no Claude login that summarized nothing. It is now the
// FEATURE: an ordered preference the worker probes at boot, first one that can run wins.
// A single value keeps exactly its old meaning, so existing worker.envs are untouched.
// ---------------------------------------------------------------------------

test('a comma-separated value is an ORDERED CHAIN, not an error', () => {
  const r = resolveSummarizerProviders('codex,agy');
  expect(r.providers).toEqual(['codex', 'agy']);
  expect(r.warning).toBeUndefined();
});

test('a single value keeps its old meaning exactly', () => {
  expect(resolveSummarizerProviders('codex').providers).toEqual(['codex']);
  expect(resolveSummarizerProviders(undefined).providers).toEqual(['claude-oauth']);
  expect(resolveSummarizerProviders('').providers).toEqual(['claude-oauth']);
});

test('aliases resolve inside a chain, and duplicates collapse keeping first position', () => {
  const r = resolveSummarizerProviders('antigravity, openai , agy');
  expect(r.providers).toEqual(['agy', 'openai-compatible']);   // agy first; the later dup dropped
});

test('ONE bad entry costs that entry, not the whole chain', () => {
  // A typo in a three-provider list must not disable summarizing altogether.
  const r = resolveSummarizerProviders('codex,gpt4,agy');
  expect(r.providers).toEqual(['codex', 'agy']);
  expect(r.warning).toContain('gpt4');
  expect(r.warning).toContain('codex -> agy');
});

test('an unrecognized value warns with the valid list', () => {
  const r = resolveSummarizerProvider('gpt4');
  expect(r.provider).toBe('claude-oauth');
  expect(r.warning).toContain('gpt4');
  expect(r.warning).toContain('claude-oauth | codex | agy | anthropic | claude-code | openai-compatible');
  // and it must warn that the fallback needs Claude, so a no-Claude box isn't silently dead
  expect(r.warning).toContain('needs a Claude login');
});

test('the singular view still returns the HEAD of the chain', () => {
  expect(resolveSummarizerProvider('codex,agy').provider).toBe('codex');
});
