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

const STOPWORDS = new Set([
  'the','and','for','with','what','which','this','that','from','your','about',
  'does','how','why','when','where','into','over','than','then','they','them',
  'version','latest','current','release', // common but low-signal here
]);

/** Plain-word tokens worth boosting: length >= 4, not a stopword, a single
 *  \p{L}\p{N}_ token, and NOT already an identifier token (those have their own boost). */
export function extractRareTokenCandidates(query: string, idTokens: string[]): string[] {
  if (!query) return [];
  const idSet = new Set(idTokens);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of query.split(/\s+/)) {
    const t = raw.replace(/[,;:!?)\]}'"]+$/u, '');
    if (t.length < 4) continue;
    if (!/^[\p{L}\p{N}_]+$/u.test(t)) continue;
    if (idSet.has(t)) continue;
    const lower = t.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
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
  rareTokenBoost: boolean;
  rareTokenWeight: number;
}

/** Boost provenance for one hit — only the boosts that actually fired. */
export interface BoostProvenance {
  identifier?: number; // multiplier applied (omitted if boost didn't fire)
  branch?: number;     // multiplier applied (omitted if boost didn't fire)
  rareToken?: number;  // multiplier applied (omitted if boost didn't fire)
}

/** A FusedItem extended with optional boost-provenance metadata. */
export interface BoostedItem extends FusedItem {
  boosts?: BoostProvenance;
}

const IDENTIFIER_BOOST_PER_MATCH = 0.3;
const IDENTIFIER_BOOST_CAP = 2.0;
const BRANCH_BOOST_MULTIPLIER = 1.1;

export async function applyBoosts(
  fused: FusedItem[],
  ctx: RerankContext,
): Promise<BoostedItem[]> {
  const idTokens = ctx.identifierBoost ? extractIdentifierTokens(ctx.query) : [];
  const rareTokens = ctx.rareTokenBoost ? extractRareTokenCandidates(ctx.query, idTokens) : [];
  if (idTokens.length === 0 && rareTokens.length === 0 && !(ctx.branchBoost && ctx.currentBranch)) {
    return fused;
  }
  const enriched = await Promise.all(
    fused.map(async item => ({ item, chunk: await ctx.getChunk(item.id) })),
  );
  const reranked: BoostedItem[] = enriched.map(({ item, chunk }) => {
    if (!chunk) return item;
    let score = item.score;
    const boosts: BoostProvenance = {};
    if (idTokens.length > 0) {
      const matches = idTokens.filter(t => chunk.content.includes(t)).length;
      if (matches > 0) {
        const multiplier = Math.min(
          1 + IDENTIFIER_BOOST_PER_MATCH * matches,
          IDENTIFIER_BOOST_CAP,
        );
        score *= multiplier;
        boosts.identifier = multiplier;
      }
    }
    if (rareTokens.length > 0) {
      const matched = rareTokens.some(t => chunk.content.includes(t));
      if (matched) {
        score *= ctx.rareTokenWeight;
        boosts.rareToken = ctx.rareTokenWeight;
      }
    }
    if (ctx.branchBoost && ctx.currentBranch && chunk.branch === ctx.currentBranch) {
      score *= BRANCH_BOOST_MULTIPLIER;
      boosts.branch = BRANCH_BOOST_MULTIPLIER;
    }
    const result: BoostedItem = { id: item.id, score };
    if (Object.keys(boosts).length > 0) result.boosts = boosts;
    return result;
  });
  reranked.sort((a, b) => b.score - a.score);
  return reranked;
}
