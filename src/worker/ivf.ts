// src/worker/ivf.ts — pure IVF (inverted-file) clustering math for the ANN vector
// index (Track A2). No I/O, no deps beyond shared vector-math. Mirrors tide.ts's
// shape (config + pure functions); consumed by vector-store.ts (storage) and
// ivf-sweep.ts (the bounded background sweep that keeps clusters current).
import { cosine, centroid } from '../shared/vector-math.ts';

export interface IvfConfig {
  /** Master switch. Default OFF — new, unvalidated-in-production code; opt in
   *  with CAPTAIN_MEMO_IVF_ENABLED=1 once verified on your own corpus. */
  enabled: boolean;
  /** Below this many vectors in a collection, skip clustering entirely — brute
   *  force stays, and it's already fast at this scale. */
  minCorpusSize: number;
  /** Target vectors per cluster (sqlite-vec's own partition-key guidance is
   *  "~100s of vectors per partition value"). K is derived from corpus size
   *  divided by this, not hardcoded. */
  targetPerCluster: number;
  /** Clusters probed per query — the recall/speed knob. */
  probeClusters: number;
  /** Sweep bounds: vectors processed per slice, ms between slices. Mirrors
   *  Tide's sweep shape exactly. */
  /** Rows per sweep slice.
   *
   *  Tuned against BOTH costs, not just throughput — measuring rows/second alone is what led to
   *  256 and took the worker down twice. One slice is ONE transaction, so the batch size is also
   *  how long the exclusive write lock is held, and every RPC queues behind it. Measured on the
   *  real 143k-vector store:
   *
   *    batch |  ms/row | lock held | full build
   *        1 |   16.07 |     16 ms |  38.5 min   never blocks, but slow
   *       32 |    4.55 |    146 ms |  10.9 min
   *       64 |    3.01 |    192 ms |   7.2 min   <- best of both
   *      128 |    4.39 |    562 ms |  10.5 min
   *      256 |   33.46 |   8567 ms |  80.1 min   blocks everything; vec0 goes superlinear
   *
   *  Past ~64 the vec0 partition rewrite degrades sharply, so the large batch is worse on BOTH
   *  axes — it is not even a throughput-for-latency trade. */
  sweepBatch: number;
  sweepIntervalMs: number;
  /** Mini-batch centroid update learning-rate floor — a centroid's per-batch
   *  update weight never drops below this even after many hits, so it keeps
   *  adapting instead of freezing solid once a cluster has seen a lot of data. */
  minLearningRate: number;
}

export const DEFAULT_IVF_CONFIG: IvfConfig = {
  enabled: false,
  minCorpusSize: 3000,
  targetPerCluster: 300,
  // Measured on the live 143,726-vector / 477-centroid index, 50 probes spread across the
  // corpus, recall@10 against an exhaustive scan as ground truth:
  //
  //   probe   p50      recall@10
  //       1   6.2 ms       0.384
  //       4  15.3 ms       0.748
  //       8  27.2 ms       0.858   <- previous default: silently lost 14% of true neighbours
  //      16  47.5 ms       0.938
  //      32  95.2 ms       0.978
  //
  // 16 costs +20 ms inside a 397-782 ms end-to-end search (the probe is a small fraction; query
  // embedding, FTS and ranking dominate), so the extra latency is under 4% of what a caller
  // feels while recall gains 8 points. Recall is the reason this index exists — a fast search
  // that drops a relevant memory has failed at the only job it has.
  probeClusters: 16,
  sweepBatch: 64,
  sweepIntervalMs: 60_000,
  minLearningRate: 0.01,
};

/** Build an IvfConfig from a plain env record. Unparseable values fall back to
 *  the default (never NaN) — mirrors tide.ts's loadTideConfig exactly. */
export function loadIvfConfig(env: Record<string, string | undefined>): IvfConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
  };
  const D = DEFAULT_IVF_CONFIG;
  return {
    enabled: env.CAPTAIN_MEMO_IVF_ENABLED === '1',
    minCorpusSize: num(env.CAPTAIN_MEMO_IVF_MIN_CORPUS, D.minCorpusSize),
    targetPerCluster: num(env.CAPTAIN_MEMO_IVF_TARGET_PER_CLUSTER, D.targetPerCluster),
    probeClusters: num(env.CAPTAIN_MEMO_IVF_PROBE_CLUSTERS, D.probeClusters),
    sweepBatch: num(env.CAPTAIN_MEMO_IVF_SWEEP_BATCH, D.sweepBatch),
    sweepIntervalMs: num(env.CAPTAIN_MEMO_IVF_SWEEP_MS, D.sweepIntervalMs),
    minLearningRate: num(env.CAPTAIN_MEMO_IVF_MIN_LEARNING_RATE, D.minLearningRate),
  };
}

/** How many clusters a collection of this size should have. Never less than 1. */
export function targetClusterCount(vectorCount: number, cfg: IvfConfig): number {
  return Math.max(1, Math.round(vectorCount / cfg.targetPerCluster));
}

export interface Centroid {
  clusterId: number;
  vector: number[];
  /** Running count of vectors ever assigned to this centroid — drives the
   *  decaying mini-batch learning rate (standard mini-batch k-means: weight
   *  new-batch-mean by batchSize / totalHitCount, floored so it never fully
   *  freezes even after a lot of history). */
  hitCount: number;
}

/** Nearest centroid to `vector` by cosine similarity (highest similarity wins).
 *  Returns null only when `centroids` is empty. */
export function nearestCentroid(
  vector: number[] | Float32Array,
  centroids: readonly Centroid[],
): { clusterId: number; similarity: number } | null {
  let best: { clusterId: number; similarity: number } | null = null;
  for (const c of centroids) {
    const sim = cosine(vector, c.vector);
    if (!best || sim > best.similarity) best = { clusterId: c.clusterId, similarity: sim };
  }
  return best;
}

/** The M nearest centroids to `vector`, sorted nearest-first. */
export function nearestCentroids(
  vector: number[] | Float32Array,
  centroids: readonly Centroid[],
  m: number,
): Centroid[] {
  return [...centroids]
    .map(c => ({ c, sim: cosine(vector, c.vector) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, m)
    .map(x => x.c);
}

/** One mini-batch k-means update: assigns each item in the batch to its nearest
 *  centroid, groups assignments by cluster, and nudges each touched centroid
 *  toward that group's mean (via the existing `centroid()` helper) using a
 *  decaying learning rate (batchSize / newHitCount, floored at
 *  cfg.minLearningRate) — the standard mini-batch k-means update. Bounded by
 *  the batch's own size; safe to call once per sweep tick. Centroids with no
 *  items assigned in this batch pass through unchanged. */
export function miniBatchUpdate(
  batch: ReadonlyArray<{ id: string; vector: number[] | Float32Array }>,
  centroids: readonly Centroid[],
  cfg: IvfConfig,
): { centroids: Centroid[]; assignments: Array<{ id: string; clusterId: number }> } {
  const assignments: Array<{ id: string; clusterId: number }> = [];
  const byCluster = new Map<number, Array<number[] | Float32Array>>();
  for (const item of batch) {
    const nearest = nearestCentroid(item.vector, centroids);
    if (!nearest) continue;
    assignments.push({ id: item.id, clusterId: nearest.clusterId });
    const list = byCluster.get(nearest.clusterId) ?? [];
    list.push(item.vector);
    byCluster.set(nearest.clusterId, list);
  }
  const next = centroids.map(c => {
    const hits = byCluster.get(c.clusterId);
    if (!hits || hits.length === 0) return c;
    const batchMean = centroid(hits)!; // hits.length > 0, so never null
    const hitCount = c.hitCount + hits.length;
    const lr = Math.max(cfg.minLearningRate, hits.length / hitCount);
    const vector = c.vector.map((x, i) => x + lr * (batchMean[i]! - x));
    return { clusterId: c.clusterId, vector, hitCount };
  });
  return { centroids: next, assignments };
}

/** Seed initial centroids via the Forgy method: sample k vectors from the
 *  corpus (via the injected `sample`) and use them as-is. `clusterIds` supplies
 *  the (already globally-allocated) ids to tag each seed with — this function
 *  never invents cluster ids itself, since allocation must be DB-backed and
 *  collision-free across collections (VectorStore's job, not this pure module's). */
export function seedCentroids(
  vectors: ReadonlyArray<{ id: string; vector: number[] | Float32Array }>,
  clusterIds: readonly number[],
  sample: (n: number, k: number) => number[],
): Centroid[] {
  const indices = sample(vectors.length, Math.min(clusterIds.length, vectors.length));
  return indices.map((idx, i) => ({
    clusterId: clusterIds[i]!,
    vector: Array.from(vectors[idx]!.vector),
    hitCount: 1,
  }));
}

/** Real (non-deterministic) sampler: k distinct indices in [0, n), via a
 *  partial Fisher-Yates shuffle. If k >= n, returns all indices in [0, n). */
export function defaultSample(n: number, k: number): number[] {
  const pool = Array.from({ length: n }, (_, i) => i);
  const take = Math.min(k, n);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (n - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, take);
}
