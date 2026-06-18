// src/eval/metrics.ts — pure retrieval metrics. No I/O.

export function mrr(rankedDocIds: string[], relevant: Set<string>): number {
  for (let i = 0; i < rankedDocIds.length; i++) {
    if (relevant.has(rankedDocIds[i]!)) return 1 / (i + 1);
  }
  return 0;
}

function dcg(rankedDocIds: string[], grades: Map<string, number>, k: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(k, rankedDocIds.length); i++) {
    const rel = grades.get(rankedDocIds[i]!) ?? 0;
    sum += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  return sum;
}

export function ndcgAtK(rankedDocIds: string[], grades: Map<string, number>, k: number): number {
  const ideal = [...grades.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const idcg = dcg(ideal, grades, k);
  if (idcg === 0) return 0;
  return dcg(rankedDocIds, grades, k) / idcg;
}

export function recallAtK(rankedDocIds: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const top = rankedDocIds.slice(0, k);
  let hits = 0;
  for (const id of relevant) if (top.includes(id)) hits++;
  return hits / relevant.size;
}

export function freshnessAt1(topDocId: string | undefined, expectedFreshDocId: string): number {
  return topDocId === expectedFreshDocId ? 1 : 0;
}

export function stalenessRate(rankedDocIds: string[], staleDocIds: Set<string>, k: number): number {
  const top = rankedDocIds.slice(0, k);
  if (top.length === 0) return 0;
  let stale = 0;
  for (const id of top) if (staleDocIds.has(id)) stale++;
  return stale / top.length;
}
