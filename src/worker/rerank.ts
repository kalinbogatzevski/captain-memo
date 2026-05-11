import type { FusedItem } from './search.ts';

/**
 * Extract query tokens that look like code identifiers. A token qualifies if:
 *   - it contains `_`, `.`, or `/` (snake_case, dotted, paths), OR
 *   - it has an internal lowercase-to-uppercase transition (camelCase/PascalCase)
 *
 * Plain words and all-uppercase tokens are skipped — those are exactly the
 * queries where semantic ranking should win uncontested.
 */
export function extractIdentifierTokens(query: string): string[] {
  if (!query) return [];
  const rawTokens = query.split(/\s+/).filter(t => t.length > 0);
  const cleaned = rawTokens.map(t => t.replace(/[,;:!?)\]}'"]+$/u, ''));
  const codeShaped = /[_./]|[a-z][a-zA-Z]*[A-Z]/;
  return cleaned.filter(t => t.length > 0 && codeShaped.test(t));
}

export interface RerankChunk {
  id: string;
  content: string;
  branch: string | null;
}

export interface RerankContext {
  query: string;
  currentBranch: string | null;
  getChunk: (id: string) => Promise<RerankChunk | null>;
  identifierBoost: boolean;
  branchBoost: boolean;
}

const IDENTIFIER_BOOST_PER_MATCH = 0.3;
const IDENTIFIER_BOOST_CAP = 2.0;
const BRANCH_BOOST_MULTIPLIER = 1.1;

export async function applyBoosts(
  fused: FusedItem[],
  ctx: RerankContext,
): Promise<FusedItem[]> {
  const idTokens = ctx.identifierBoost ? extractIdentifierTokens(ctx.query) : [];
  if (idTokens.length === 0 && !(ctx.branchBoost && ctx.currentBranch)) {
    return fused;
  }
  const enriched = await Promise.all(
    fused.map(async item => ({ item, chunk: await ctx.getChunk(item.id) })),
  );
  const reranked = enriched.map(({ item, chunk }) => {
    if (!chunk) return item;
    let score = item.score;
    if (idTokens.length > 0) {
      const matches = idTokens.filter(t => chunk.content.includes(t)).length;
      if (matches > 0) {
        const multiplier = Math.min(
          1 + IDENTIFIER_BOOST_PER_MATCH * matches,
          IDENTIFIER_BOOST_CAP,
        );
        score *= multiplier;
      }
    }
    if (ctx.branchBoost && ctx.currentBranch && chunk.branch === ctx.currentBranch) {
      score *= BRANCH_BOOST_MULTIPLIER;
    }
    return { id: item.id, score };
  });
  reranked.sort((a, b) => b.score - a.score);
  return reranked;
}
