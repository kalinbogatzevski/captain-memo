export interface FusedItem {
  id: string;
  score: number;          // Normalized 0-1
}

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
