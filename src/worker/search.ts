import type { RerankChunk, BoostedItem } from './rerank.ts';
import { applyBoosts } from './rerank.ts';

export interface FusedItem {
  id: string;
  score: number;          // Normalized 0-1
}

export type { BoostedItem };

/**
 * Reciprocal Rank Fusion.
 *
 * For each ranked list, each item gets a score of 1 / (k + rank), where rank is
 * 1-indexed. Items appearing in multiple lists have their per-list scores summed.
 * Final scores are normalized to 0-1 by dividing by the maximum possible score.
 */
export function reciprocalRankFusion(rankedLists: string[][], k: number): FusedItem[] {
  if (rankedLists.length === 0) return [];

  const aggregate = new Map<string, number>();
  for (const list of rankedLists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!;
      const rank = i + 1;
      const contribution = 1 / (k + rank);
      aggregate.set(id, (aggregate.get(id) ?? 0) + contribution);
    }
  }
  if (aggregate.size === 0) return [];

  // Normalize: max possible score = sum of (1/(k+1)) across all lists
  const maxPossible = rankedLists.length * (1 / (k + 1));

  const items: FusedItem[] = Array.from(aggregate, ([id, raw]) => ({
    id,
    score: maxPossible > 0 ? raw / maxPossible : 0,
  }));
  items.sort((a, b) => b.score - a.score);
  return items;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Cosine similarity in [0,1] from sqlite-vec L2 distance on unit vectors:
 *  distance² = 2 − 2·cos ⇒ cos = 1 − distance²/2, mapped to [0,1] via (cos+1)/2
 *  = 1 − distance²/4. Assumes L2-normalized embeddings. */
export function cosineFromDistance(distance: number): number {
  return clamp01(1 - (distance * distance) / 4);
}

/** Weighted hybrid fusion: blends cosine magnitude with min-max-normalized BM25.
 *  Returns the same FusedItem[] shape as reciprocalRankFusion. */
export function weightedFusion(
  vectorResults: VectorHit[],
  keywordResults: KeywordHit[],
  opts: { vectorWeight: number; keywordWeight: number },
): FusedItem[] {
  const sem = new Map<string, number>();
  for (const v of vectorResults) sem.set(v.id, cosineFromDistance(v.distance));

  const kw = new Map<string, number>();
  if (keywordResults.length > 0) {
    let rmin = Infinity; // most negative = best
    let rmax = -Infinity; // least negative = worst
    for (const k of keywordResults) {
      if (k.rank < rmin) rmin = k.rank;
      if (k.rank > rmax) rmax = k.rank;
    }
    const span = rmin - rmax; // negative magnitude; 0 when all tied
    for (const k of keywordResults) {
      kw.set(k.chunk_id, span === 0 ? 1 : (k.rank - rmax) / span);
    }
  }

  const ids = new Set<string>([...sem.keys(), ...kw.keys()]);
  const items: FusedItem[] = [];
  for (const id of ids) {
    const sv = sem.get(id);
    const sk = kw.get(id);
    let score: number;
    if (sv !== undefined && sk !== undefined) score = opts.vectorWeight * sv + opts.keywordWeight * sk;
    else if (sv !== undefined) score = sv;   // redistribute: present leg at full weight
    else score = sk!;
    items.push({ id, score });
  }
  items.sort((a, b) => b.score - a.score);
  return items;
}

export interface VectorHit {
  id: string;
  distance: number;
}

export interface KeywordHit {
  chunk_id: string;
  rank: number; // FTS5 bm25(): negative, more-negative = better
}

export interface HybridSearcherOptions {
  vectorSearch: (embedding: number[], topK: number) => Promise<VectorHit[]>;
  keywordSearch: (query: string, topK: number) => Promise<KeywordHit[]>;
  rrfK?: number;
  perStrategyTopK?: number;
  getChunk?: (id: string) => Promise<RerankChunk | null>;
  /** Optional Tide re-rank applied to the FULL post-boost candidate pool BEFORE
   *  truncation: re-scores by a bounded buoyancy multiplier and re-sorts. Wired
   *  only when CAPTAIN_MEMO_TIDE_ENABLED=1; absent ⇒ ranking is unchanged. */
  tideRerank?: <T extends FusedItem>(items: T[]) => T[];
}

export class HybridSearcher {
  private vectorSearch: HybridSearcherOptions['vectorSearch'];
  private keywordSearch: HybridSearcherOptions['keywordSearch'];
  private rrfK: number;
  private perStrategyTopK: number;
  private getChunk: HybridSearcherOptions['getChunk'];
  private tideRerank: HybridSearcherOptions['tideRerank'];

  constructor(opts: HybridSearcherOptions) {
    this.vectorSearch = opts.vectorSearch;
    this.keywordSearch = opts.keywordSearch;
    this.rrfK = opts.rrfK ?? 60;
    this.perStrategyTopK = opts.perStrategyTopK ?? 25;
    this.getChunk = opts.getChunk;
    this.tideRerank = opts.tideRerank;
  }

  async search(embedding: number[], query: string, topK: number, opts?: {
    currentBranch?: string | null;
    rrfK?: number;
    perStrategyTopK?: number;
    fusionMode?: 'rrf' | 'weighted';
    vectorWeight?: number;
    keywordWeight?: number;
    properNounBoost?: boolean;
    properNounBoostWeight?: number;
  }): Promise<BoostedItem[]> {
    const perStrategyTopK = opts?.perStrategyTopK ?? this.perStrategyTopK;
    const rrfK = opts?.rrfK ?? this.rrfK;
    const fusionMode = opts?.fusionMode ?? 'rrf';
    // Each half logs its own error so silent degradation is debuggable —
    // before, both halves could fail and the user got an empty result with
    // no signal. Now journalctl shows which half (vector / keyword) broke.
    const [vectorResults, keywordResults] = await Promise.all([
      this.vectorSearch(embedding, perStrategyTopK).catch(err => {
        console.error('[search] vector half failed:', (err as Error).message);
        return [];
      }),
      this.keywordSearch(query, perStrategyTopK).catch(err => {
        console.error('[search] keyword half failed:', (err as Error).message);
        return [];
      }),
    ]);

    const fused: FusedItem[] = fusionMode === 'weighted'
      ? weightedFusion(vectorResults, keywordResults, {
          vectorWeight: opts?.vectorWeight ?? 0.5,
          keywordWeight: opts?.keywordWeight ?? 0.5,
        })
      : reciprocalRankFusion([vectorResults.map(r => r.id), keywordResults.map(r => r.chunk_id)], rrfK);

    let ranked: BoostedItem[] = fused;
    if (this.getChunk) {
      const identifierBoost = process.env.CAPTAIN_MEMO_IDENTIFIER_BOOST !== '0';
      const branchBoost = process.env.CAPTAIN_MEMO_BRANCH_BOOST !== '0';
      const rareTokenBoost = (opts?.properNounBoost ?? false) && process.env.CAPTAIN_MEMO_RARE_TOKEN_BOOST !== '0';
      if (identifierBoost || branchBoost || rareTokenBoost) {
        ranked = await applyBoosts(fused, {
          query,
          currentBranch: opts?.currentBranch ?? null,
          getChunk: this.getChunk,
          identifierBoost,
          branchBoost,
          rareTokenBoost,
          rareTokenWeight: opts?.properNounBoostWeight ?? 1.15,
        });
      }
    }
    // Tide re-rank runs on the FULL post-boost pool BEFORE truncation, so a
    // near-dormant but exactly-relevant row a drill should rescue is never cut at
    // the slice before Tide can see it. Absent (Tide off) ⇒ unchanged behaviour.
    if (this.tideRerank) ranked = this.tideRerank(ranked);
    return ranked.slice(0, topK);
  }
}
