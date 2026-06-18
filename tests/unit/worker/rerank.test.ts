// tests/unit/worker/rerank.test.ts
import { test, expect } from 'bun:test';
import { extractRareTokenCandidates, applyBoosts } from '../../../src/worker/rerank.ts';
import type { RerankChunk } from '../../../src/worker/rerank.ts';

test('extractRareTokenCandidates keeps plain words >=4 chars, drops identifiers/stopwords/short', () => {
  const out = extractRareTokenCandidates('what is the latest talq getChunk status', ['getChunk']);
  expect(out).toContain('talq');              // genuine rare token
  expect(out).toContain('status');            // >=4, not a stopword
  expect(out).not.toContain('latest');        // stopword (temporal/low-signal)
  expect(out).not.toContain('getChunk');      // already an identifier token (in idTokens)
  expect(out).not.toContain('the');           // stopword/short
  expect(out).not.toContain('is');            // short
});

test('rare-token boost lifts a chunk containing the rare token', async () => {
  const chunks: Record<string, RerankChunk> = {
    a: { id: 'a', content: 'talq desktop release notes', branch: null },
    b: { id: 'b', content: 'unrelated content', branch: null },
  };
  const fused = [{ id: 'b', score: 0.9 }, { id: 'a', score: 0.8 }];
  const out = await applyBoosts(fused, {
    query: 'talq', currentBranch: null,
    getChunk: async (id) => chunks[id] ?? null,
    identifierBoost: false, branchBoost: false,
    rareTokenBoost: true, rareTokenWeight: 1.15,
  });
  // a (0.8 * 1.15 = 0.92) overtakes b (0.9, no rare token)
  expect(out[0]!.id).toBe('a');
  expect(out.find(x => x.id === 'a')!.boosts!.rareToken).toBeCloseTo(1.15, 6);
});

test('rare-token boost off → no change', async () => {
  const chunks: Record<string, RerankChunk> = { a: { id: 'a', content: 'talq', branch: null } };
  const fused = [{ id: 'a', score: 0.8 }];
  const out = await applyBoosts(fused, {
    query: 'talq', currentBranch: null,
    getChunk: async (id) => chunks[id] ?? null,
    identifierBoost: false, branchBoost: false,
    rareTokenBoost: false, rareTokenWeight: 1.15,
  });
  expect(out[0]!.score).toBeCloseTo(0.8, 6);
});
