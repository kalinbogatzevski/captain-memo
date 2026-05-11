import { describe, test, expect, afterEach } from 'bun:test';
import { HybridSearcher, type FusedItem } from '../../src/worker/search.ts';

describe('HybridSearcher with branch boost', () => {
  test('same-branch chunk outranks cross-branch chunk with equal rank', async () => {
    const chunks: Record<string, { text: string; branch: string | null }> = {
      'chunk-main':    { text: 'function getThing returns the thing', branch: 'main' },
      'chunk-feature': { text: 'function getThing returns the thing', branch: 'feature/widget' },
    };
    const vectorSearch = async () => [
      { id: 'chunk-main', distance: 0.1 },
      { id: 'chunk-feature', distance: 0.1 },
    ];
    const keywordSearch = async () => [
      { chunk_id: 'chunk-main' },
      { chunk_id: 'chunk-feature' },
    ];
    const getChunk = async (id: string) => chunks[id]
      ? { id, content: chunks[id].text, branch: chunks[id].branch }
      : null;

    const searcher = new HybridSearcher({ vectorSearch, keywordSearch, getChunk });
    const results = await searcher.search([0.1, 0.2], 'getThing usage', 5, {
      currentBranch: 'feature/widget',
    });
    expect(results[0]!.id).toBe('chunk-feature');
  });
});

describe('HybridSearcher with identifier boost', () => {
  test('chunk containing literal identifier outranks chunk that does not', async () => {
    const chunks: Record<string, { text: string; branch: string | null }> = {
      'chunk-billing-vague': {
        text: 'billing is a complex area with many edge cases',
        branch: null,
      },
      'chunk-billing-literal': {
        text: 'function calculateFee() reads contract_bills.fee from the DB',
        branch: null,
      },
    };
    const vectorSearch = async () => [
      { id: 'chunk-billing-vague', distance: 0.1 },
      { id: 'chunk-billing-literal', distance: 0.3 },
    ];
    const keywordSearch = async () => [
      { chunk_id: 'chunk-billing-vague' },
      { chunk_id: 'chunk-billing-literal' },
    ];
    const getChunk = async (id: string) => chunks[id]
      ? { id, content: chunks[id].text, branch: chunks[id].branch }
      : null;

    const searcher = new HybridSearcher({ vectorSearch, keywordSearch, getChunk });
    const results: FusedItem[] = await searcher.search([0.1, 0.2], 'find contract_bills.fee in the code', 5);
    expect(results[0]!.id).toBe('chunk-billing-literal');
  });
});

describe('HybridSearcher boost env-var disable gate', () => {
  // Restore env vars after the test regardless of pass/fail.
  const savedIdentifier = process.env.CAPTAIN_MEMO_IDENTIFIER_BOOST;
  const savedBranch = process.env.CAPTAIN_MEMO_BRANCH_BOOST;
  afterEach(() => {
    if (savedIdentifier === undefined) delete process.env.CAPTAIN_MEMO_IDENTIFIER_BOOST;
    else process.env.CAPTAIN_MEMO_IDENTIFIER_BOOST = savedIdentifier;
    if (savedBranch === undefined) delete process.env.CAPTAIN_MEMO_BRANCH_BOOST;
    else process.env.CAPTAIN_MEMO_BRANCH_BOOST = savedBranch;
  });

  test('IDENTIFIER_BOOST=0 + BRANCH_BOOST=0 preserves unmodified RRF order', async () => {
    // chunk-billing-vague ranks first in both vector and keyword lists (lower
    // distance = better vector hit; first in keyword list). With boosts enabled
    // chunk-billing-literal would win because the query contains a literal
    // identifier it matches. With both boosts disabled it must stay second.
    const chunks: Record<string, { text: string; branch: string | null }> = {
      'chunk-billing-vague': {
        text: 'billing is a complex area with many edge cases',
        branch: null,
      },
      'chunk-billing-literal': {
        text: 'function calculateFee() reads contract_bills.fee from the DB',
        branch: null,
      },
    };
    // vague chunk wins on both vector (lower distance) and keyword (rank 1) —
    // so raw RRF order is [vague, literal].
    const vectorSearch = async () => [
      { id: 'chunk-billing-vague', distance: 0.1 },
      { id: 'chunk-billing-literal', distance: 0.3 },
    ];
    const keywordSearch = async () => [
      { chunk_id: 'chunk-billing-vague' },
      { chunk_id: 'chunk-billing-literal' },
    ];
    const getChunk = async (id: string) => chunks[id]
      ? { id, content: chunks[id].text, branch: chunks[id].branch }
      : null;

    const searcher = new HybridSearcher({ vectorSearch, keywordSearch, getChunk });

    process.env.CAPTAIN_MEMO_IDENTIFIER_BOOST = '0';
    process.env.CAPTAIN_MEMO_BRANCH_BOOST = '0';

    const results: FusedItem[] = await searcher.search(
      [0.1, 0.2],
      'find contract_bills.fee in the code',
      5,
      { currentBranch: null },
    );
    // With both boosts disabled, pure RRF score wins: vague is first.
    expect(results[0]!.id).toBe('chunk-billing-vague');
  });
});
