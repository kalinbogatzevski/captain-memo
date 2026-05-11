import { describe, test, expect } from 'bun:test';
import { extractIdentifierTokens, applyBoosts } from '../../src/worker/rerank.ts';
import type { FusedItem, BoostedItem } from '../../src/worker/search.ts';

describe('extractIdentifierTokens', () => {
  test('catches snake_case + dotted tokens', () => {
    expect(extractIdentifierTokens('how does contract_bills.fee work'))
      .toEqual(['contract_bills.fee']);
  });
  test('catches camelCase', () => {
    expect(extractIdentifierTokens('debug useEffect crash'))
      .toEqual(['useEffect']);
  });
  test('catches path-shaped tokens', () => {
    expect(extractIdentifierTokens('check src/main.py'))
      .toEqual(['src/main.py']);
  });
  test('catches PascalCase via internal lower-to-upper transition', () => {
    expect(extractIdentifierTokens('inspect MyClass shape'))
      .toEqual(['MyClass']);
  });
  test('skips plain-English tokens', () => {
    expect(extractIdentifierTokens('billing payment contract user'))
      .toEqual([]);
  });
  test('skips all-uppercase tokens (yelled words, not identifiers)', () => {
    expect(extractIdentifierTokens('FOO BAR'))
      .toEqual([]);
  });
  test('returns multiple identifiers from one query', () => {
    expect(extractIdentifierTokens('useEffect in src/main.py and contract_bills.fee'))
      .toEqual(['useEffect', 'src/main.py', 'contract_bills.fee']);
  });
  test('empty query returns empty array', () => {
    expect(extractIdentifierTokens('')).toEqual([]);
  });
  test('preserves internal punctuation but trims trailing comma', () => {
    expect(extractIdentifierTokens('useEffect, useState'))
      .toEqual(['useEffect', 'useState']);
  });
});

describe('applyBoosts — identifier match', () => {
  const fakeChunks: Record<string, { content: string; branch: string | null }> = {
    'a': { content: 'this chunk mentions contract_bills.fee directly', branch: null },
    'b': { content: 'this chunk is about billing in general', branch: null },
    'c': { content: 'unrelated text about coffee', branch: null },
  };
  const getChunk = async (id: string) => fakeChunks[id]
    ? { id, content: fakeChunks[id].content, branch: fakeChunks[id].branch }
    : null;

  test('literal-match chunk gets +0.3 score per match, non-matching chunks unchanged', async () => {
    const fused: FusedItem[] = [
      { id: 'b', score: 0.80 },
      { id: 'a', score: 0.50 },
      { id: 'c', score: 0.30 },
    ];
    const reranked = await applyBoosts(fused, {
      query: 'find contract_bills.fee usage',
      currentBranch: null,
      getChunk,
      identifierBoost: true,
      branchBoost: true,
    });
    expect(reranked.map(r => r.id)).toEqual(['b', 'a', 'c']);
    expect(reranked.find(r => r.id === 'a')!.score).toBeCloseTo(0.65, 2);
    expect(reranked.find(r => r.id === 'b')!.score).toBeCloseTo(0.80, 2);
  });

  test('boost flips ranking when literal match overcomes a small semantic lead', async () => {
    const fused: FusedItem[] = [
      { id: 'b', score: 0.55 },   // small semantic lead, no identifier match
      { id: 'a', score: 0.50 },   // contains literal identifier
    ];
    const reranked = await applyBoosts(fused, {
      query: 'find contract_bills.fee usage',
      currentBranch: null,
      getChunk,
      identifierBoost: true,
      branchBoost: true,
    });
    // a's score: 0.50 × 1.3 = 0.65, beating b's 0.55 — rank flips.
    expect(reranked[0]!.id).toBe('a');
    expect(reranked[1]!.id).toBe('b');
  });

  test('boost cap prevents runaway amplification', async () => {
    const heavyMatch: FusedItem[] = [{ id: 'a', score: 0.5 }];
    const reranked = await applyBoosts(heavyMatch, {
      query: 'contract_bills.fee contract_bills.fee contract_bills.fee contract_bills.fee contract_bills.fee',
      currentBranch: null,
      getChunk,
      identifierBoost: true,
      branchBoost: true,
    });
    expect(reranked[0]!.score).toBeCloseTo(1.0, 2);
  });

  test('identifier boost disabled returns scores unchanged', async () => {
    const fused: FusedItem[] = [{ id: 'a', score: 0.5 }];
    const reranked = await applyBoosts(fused, {
      query: 'contract_bills.fee',
      currentBranch: null,
      getChunk,
      identifierBoost: false,
      branchBoost: true,
    });
    expect(reranked[0]!.score).toBeCloseTo(0.5, 2);
  });
});

describe('applyBoosts — boost provenance metadata', () => {
  const fakeChunks: Record<string, { content: string; branch: string | null }> = {
    'a': { content: 'mentions contract_bills.fee directly', branch: 'feat/billing' },
    'b': { content: 'generic billing text', branch: 'main' },
    'c': { content: 'unrelated coffee', branch: null },
  };
  const getChunk = async (id: string) => fakeChunks[id]
    ? { id, content: fakeChunks[id].content, branch: fakeChunks[id].branch }
    : null;

  test('identifier-matched chunk carries boosts.identifier with the applied multiplier', async () => {
    const fused: FusedItem[] = [{ id: 'a', score: 0.5 }, { id: 'b', score: 0.4 }];
    const reranked: BoostedItem[] = await applyBoosts(fused, {
      query: 'contract_bills.fee usage',
      currentBranch: null,
      getChunk,
      identifierBoost: true,
      branchBoost: false,
    });
    const a = reranked.find(r => r.id === 'a')!;
    expect(a.boosts?.identifier).toBeCloseTo(1.3, 5);
    expect(a.boosts?.branch).toBeUndefined();

    const b = reranked.find(r => r.id === 'b')!;
    expect(b.boosts).toBeUndefined();
  });

  test('branch-matched chunk carries boosts.branch with the applied multiplier', async () => {
    const fused: FusedItem[] = [{ id: 'a', score: 0.5 }, { id: 'b', score: 0.4 }];
    const reranked: BoostedItem[] = await applyBoosts(fused, {
      query: 'billing',
      currentBranch: 'feat/billing',
      getChunk,
      identifierBoost: false,
      branchBoost: true,
    });
    const a = reranked.find(r => r.id === 'a')!;
    expect(a.boosts?.branch).toBeCloseTo(1.1, 5);
    expect(a.boosts?.identifier).toBeUndefined();

    const b = reranked.find(r => r.id === 'b')!;
    expect(b.boosts).toBeUndefined(); // b is on 'main', not 'feat/billing'
  });

  test('chunk with both boosts carries both provenance keys', async () => {
    const fused: FusedItem[] = [{ id: 'a', score: 0.5 }];
    const reranked: BoostedItem[] = await applyBoosts(fused, {
      query: 'contract_bills.fee',
      currentBranch: 'feat/billing',
      getChunk,
      identifierBoost: true,
      branchBoost: true,
    });
    const a = reranked[0]!;
    expect(a.boosts?.identifier).toBeCloseTo(1.3, 5);
    expect(a.boosts?.branch).toBeCloseTo(1.1, 5);
  });

  test('no boosts fired → boosts property is absent (not present with empty object)', async () => {
    const fused: FusedItem[] = [{ id: 'c', score: 0.5 }];
    const reranked: BoostedItem[] = await applyBoosts(fused, {
      query: 'contract_bills.fee',
      currentBranch: 'feat/billing',
      getChunk,
      identifierBoost: true,
      branchBoost: true,
    });
    // 'c' has no identifier match and branch is null
    const c = reranked[0]!;
    expect(c.boosts).toBeUndefined();
  });

  test('early-exit (no tokens, no branch) returns plain FusedItem array with no boosts', async () => {
    const fused: FusedItem[] = [{ id: 'a', score: 0.5 }];
    const reranked: BoostedItem[] = await applyBoosts(fused, {
      query: 'billing',           // plain word — no identifier tokens
      currentBranch: null,        // no branch boost
      getChunk,
      identifierBoost: true,
      branchBoost: true,
    });
    expect(reranked[0]!.boosts).toBeUndefined();
  });
});
