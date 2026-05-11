import { describe, test, expect } from 'bun:test';
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
