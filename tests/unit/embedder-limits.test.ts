import { test, expect } from 'bun:test';
import {
  EMBEDDER_MAX_TOKENS,
  DEFAULT_EMBEDDER_MAX_TOKENS,
  embedderMaxTokens,
} from '../../src/shared/embedder-limits.ts';

test('embedderMaxTokens — voyage-4-lite returns 32K', () => {
  expect(embedderMaxTokens('voyage-4-lite')).toBe(32_000);
});

test('embedderMaxTokens — voyage-4-nano returns 512 (the small open-weights model)', () => {
  expect(embedderMaxTokens('voyage-4-nano')).toBe(512);
});

test('embedderMaxTokens — strips org prefix (voyageai/voyage-4-nano → 512)', () => {
  expect(embedderMaxTokens('voyageai/voyage-4-nano')).toBe(512);
});

test('embedderMaxTokens — strips multi-segment prefix, takes last component', () => {
  expect(embedderMaxTokens('namespace/voyageai/voyage-4-lite')).toBe(32_000);
});

test('embedderMaxTokens — unknown model falls back to conservative default', () => {
  expect(embedderMaxTokens('mystery-embedder-9000')).toBe(DEFAULT_EMBEDDER_MAX_TOKENS);
  expect(DEFAULT_EMBEDDER_MAX_TOKENS).toBe(512);
});

test('embedderMaxTokens — OpenAI embedding models all 8K', () => {
  expect(embedderMaxTokens('text-embedding-3-large')).toBe(8_192);
  expect(embedderMaxTokens('text-embedding-3-small')).toBe(8_192);
  expect(embedderMaxTokens('text-embedding-ada-002')).toBe(8_192);
});

test('embedder-limits — table covers every Voyage hosted model the install wizard recommends', () => {
  // If any of these go missing, install.ts is recommending a model the
  // worker would treat with the conservative 512-token default → 99% of
  // chunks would falsely reject. Keep this assertion in sync with install.ts.
  for (const model of ['voyage-4-lite', 'voyage-4-large', 'voyage-3-large', 'voyage-3.5']) {
    expect(EMBEDDER_MAX_TOKENS[model]).toBeGreaterThanOrEqual(8_000);
  }
});
