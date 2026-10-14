// src/worker/ivf-sweep.ts — the bounded, heartbeat-safe IVF clustering sweep
// (Track A2). Mirrors tide-sweep.ts's shape exactly: a pure orchestration
// function over injected deps, doing exactly ONE bounded unit of work per
// call — migrate one legacy batch, OR bootstrap once, OR assign one batch of
// newly-unclustered chunks, OR rebalance one batch of already-clustered ones.
// Never more than one of those per tick, so cost per call stays predictable.
import {
  targetClusterCount, outgrown, seedCentroids, miniBatchUpdate, nearestInBatch, isZeroVector, UNCLUSTERED_CLUSTER,
  type IvfConfig, type Centroid,
} from './ivf.ts';

export interface IvfSweepDeps {
  collection: string;
  cfg: IvfConfig;
  countLegacyRows: () => number;
  migrateLegacyBatch: (limit: number) => number;
  countVectors: (collection: string) => number;
  getCentroids: (collection: string) => Centroid[];
  /** `bootstrapVectors` is passed by the bootstrap only: the corpus size this set was seeded for, kept so a later slice can
   *  tell when the corpus has outgrown it (see bootstrapSize). */
  setCentroids: (collection: string, centroids: Centroid[], bootstrapVectors?: number) => void;
  /** The corpus size the current centroids were seeded for; null for an index built before that was recorded (then read as
   *  K x targetPerCluster). Optional: absent, every index reads that way. */
  bootstrapSize?: (collection: string) => number | null;
  /** Write back just the centroids a slice moved. Optional: absent, every slice replaces the whole set with setCentroids. */
  updateCentroids?: (collection: string, changed: Centroid[]) => void;
  allocateClusterIds: (collection: string, n: number) => number[];
  /** May be async: reading seeds by key is ~2 ms a row on a large store, so the real one yields to the event loop as it goes. */
  sampleAnyVectors: (collection: string, limit: number) => Array<{ chunkId: string; embedding: Float32Array }>
    | Promise<Array<{ chunkId: string; embedding: Float32Array }>>;
  sampleClusteredVectors: (
    collection: string,
    limit: number,
  ) => Array<{ chunkId: string; embedding: Float32Array; clusterId: number }>;
  /** The rebalance's sample: rows of already-clustered vectors that rotate through the corpus from call to call.
   *  Optional: absent, the rebalance reads sampleClusteredVectors (the same leading rows every call). */
  sampleRebalanceVectors?: (
    collection: string,
    limit: number,
  ) => Array<{ chunkId: string; embedding: Float32Array; clusterId: number }>;
  getUnclusteredChunks: (collection: string, limit: number) => Array<{ chunkId: string; embedding: Float32Array }>;
  /** Move a whole batch in one transaction. Per-row reassignment measured 49 ms/row against the
   *  real store versus 2.62 ms batched — the difference between an unaffordable index build and a
   *  routine one. */
  reassignClusterBatch: (items: Array<{ chunkId: string; embedding: Float32Array; clusterId: number }>) => void;
  /** Injected sampler — production callers pass `defaultSample` from ivf.ts;
   *  tests pass a deterministic one. */
  sample: (n: number, k: number) => number[];
  /** Hand control back to the event loop between the (already-bounded) steps
   *  within one slice. Injected for tests, mirrors tide-sweep.ts. */
  yieldToLoop: () => Promise<void>;
}

export interface IvfSweepResult {
  legacyMigrated: number;
  bootstrapped: number;
  assigned: number;
  rebalanced: number;
  /** Rows sent back to unclustered while repairing an index seeded from vectors with no direction. */
  reset: number;
}

const EMPTY_RESULT: IvfSweepResult = { legacyMigrated: 0, bootstrapped: 0, assigned: 0, rebalanced: 0, reset: 0 };

/**
 * Run one bounded IVF sweep slice. Does exactly one of, in priority order:
 *  1. Migrate one batch of legacy (pre-A2) rows, if any remain — this step
 *     runs UNCONDITIONALLY, regardless of `cfg.enabled`. `add()`/`query()`
 *     operate exclusively on the new `vec_chunks_p` table, so migration is a
 *     required correctness step now, not part of the opt-in clustering
 *     feature — gating it on `enabled` would strand an existing install's
 *     entire corpus in the old table forever on a switched-off (=0)
 *     config. See the plan's Global Constraints for the full incident.
 *  2. Nothing further, if clustering itself is disabled.
 *  3. Nothing, if the corpus is still below the clustering threshold.
 *  3b. Repair an index whose centroids include an all-zero one, or that the corpus
 *     has outgrown (see below): send one batch of its rows back to unclustered, and
 *     once none are left fall through to the bootstrap, which replaces the whole set.
 *  4. Bootstrap centroids (once), if the corpus has crossed the threshold
 *     and no centroids exist yet.
 *  5. Assign one batch of newly-unclustered chunks to existing centroids.
 *  6. Rebalance one batch of already-clustered chunks (periodic upkeep),
 *     only actually moving chunks whose nearest centroid changed. The batch
 *     rotates through the corpus.
 */
export async function runIvfSweepSlice(deps: IvfSweepDeps): Promise<IvfSweepResult> {
  const { cfg, collection } = deps;

  const legacyRemaining = deps.countLegacyRows();
  if (legacyRemaining > 0) {
    const migrated = deps.migrateLegacyBatch(cfg.sweepBatch);
    return { ...EMPTY_RESULT, legacyMigrated: migrated };
  }

  if (!cfg.enabled) return EMPTY_RESULT; // clustering can be switched off; migration above cannot

  const totalVectors = deps.countVectors(collection);
  if (totalVectors < cfg.minCorpusSize) return EMPTY_RESULT;

  let centroids = deps.getCentroids(collection);

  // An all-zero centroid scores 0 against every vector and a populated one scores above it, so it never wins a row and
  // the mini-batch update never moves it: a bad seed was permanent. An outside user's store was seeded (first rows of
  // the table, 2026-08, while an embed failure still stored zero vectors) with 10 zero centroids of 11: all 41,198
  // vectors in one cluster, so every finder walked all 848M pairs. Seeding now skips such vectors, but an index already
  // built that way has to be redone: the rows go back to unclustered one batch per slice (the same 64-row transaction
  // as an assignment), and when none is left the bootstrap below replaces the centroids in ONE transaction, so a reader
  // never sees an empty set. Search keeps answering throughout: it always probes the unclustered partition.
  // MEASURED on a copy of the 272k-vector dev store (2026-10-14), 300 reset slices of 64 rows, flat from the first slice to
  // the last as the unclustered partition grew to 19,200: slice 110-150 ms p50, 240-400 ms p95, 460 ms max; the write
  // transaction (the lock) 41-48 ms p50, 146-273 ms p95, 314 ms max; about 6% of writer time at the 2 s build cadence.
  //
  // The same repair redoes an index the corpus has outgrown. The number of clusters was chosen once, at the bootstrap, and a store
  // seeded at ~3,300 vectors kept 11 centroids at 40.9k (an average cluster of 3,700), where every dedup, semantic and theme pass
  // takes its groups from cluster membership. Once the corpus is `regrowRatio` times the size the index was built for (outgrown)
  // the bootstrap below runs again with the K the corpus has now. It costs two passes over every row and, until the unclustered
  // partition drains, flat-scan queries, so the ratio keeps it to an index that has fallen far behind, and the size the last
  // bootstrap recorded (not its seed count) is what is compared, so a bootstrap that found few usable seeds cannot trigger another.
  const regrowing = centroids.length > 0 && outgrown(
    deps.bootstrapSize?.(collection) ?? centroids.length * cfg.targetPerCluster, totalVectors, cfg);
  const repairing = regrowing || centroids.some(c => isZeroVector(c.vector));
  const resetBatch = (): number => {
    const placed = deps.sampleClusteredVectors(collection, cfg.sweepBatch);
    if (placed.length > 0) {
      deps.reassignClusterBatch(placed.map(p => ({ chunkId: p.chunkId, embedding: p.embedding, clusterId: UNCLUSTERED_CLUSTER })));
    }
    return placed.length;
  };
  if (repairing) {
    const n = resetBatch();
    if (n > 0) return { ...EMPTY_RESULT, reset: n };
    centroids = [];
  }

  if (centroids.length === 0) {
    const k = targetClusterCount(totalVectors, cfg);
    const vectors = await deps.sampleAnyVectors(collection, k);
    if (vectors.length === 0) return EMPTY_RESULT;
    const clusterIds = deps.allocateClusterIds(collection, Math.min(k, vectors.length));
    const seeded = seedCentroids(
      vectors.map(v => ({ id: v.chunkId, vector: v.embedding })),
      clusterIds,
      deps.sample,
    );
    if (seeded.length === 0) return EMPTY_RESULT;   // every sampled vector lacked a direction: try again next slice
    // Reading the seeds gave the event loop turns, and a chunk added in one of them took the OLD set's nearest cluster.
    // Replacing the set would strand it under an id no query probes, so what is left is sent back first. No await from
    // here to setCentroids: nothing can be added in between.
    if (repairing) {
      const n = resetBatch();
      if (n > 0) return { ...EMPTY_RESULT, reset: n };
    }
    deps.setCentroids(collection, seeded, totalVectors);
    return { ...EMPTY_RESULT, bootstrapped: seeded.length };
  }

  await deps.yieldToLoop();

  // A slice moves at most sweepBatch centroids of K, and miniBatchUpdate hands every other one back as the same object, so
  // only those are written: rewriting all K every slice was 510 ms p50 of a 1.6 s assign slice at 931 centroids, 6.6 ms this way.
  const saveCentroids = (updated: Centroid[]): void => {
    if (!deps.updateCentroids) return deps.setCentroids(collection, updated);
    const moved = updated.filter((c, i) => c !== centroids[i]);
    if (moved.length > 0) deps.updateCentroids(collection, moved);
  };

  const unclustered = deps.getUnclusteredChunks(collection, cfg.sweepBatch);
  if (unclustered.length > 0) {
    const items = unclustered.map(u => ({ id: u.chunkId, vector: u.embedding }));
    const { centroids: updated, assignments } = miniBatchUpdate(
      items, centroids, cfg, await nearestInBatch(items, centroids, deps.yieldToLoop),
    );
    const byId = new Map(unclustered.map(u => [u.chunkId, u.embedding]));
    deps.reassignClusterBatch(assignments.map(a => ({
      chunkId: a.id, embedding: byId.get(a.id)!, clusterId: a.clusterId,
    })));
    saveCentroids(updated);
    return { ...EMPTY_RESULT, assigned: assignments.length };
  }

  // Nothing unclustered left — periodic rebalance: resample already-clustered
  // vectors and only move the ones whose nearest centroid has actually changed
  // (avoids needless delete+reinsert for chunks that are still correctly placed).
  const sample = (deps.sampleRebalanceVectors ?? deps.sampleClusteredVectors)(collection, cfg.sweepBatch);
  if (sample.length === 0) return EMPTY_RESULT;
  const items = sample.map(s => ({ id: s.chunkId, vector: s.embedding }));
  const { centroids: updated, assignments } = miniBatchUpdate(
    items, centroids, cfg, await nearestInBatch(items, centroids, deps.yieldToLoop), true,
  );
  const currentClusterById = new Map(sample.map(s => [s.chunkId, s.clusterId]));
  const embeddingById = new Map(sample.map(s => [s.chunkId, s.embedding]));
  const changed = assignments.filter(a => currentClusterById.get(a.id) !== a.clusterId);
  deps.reassignClusterBatch(changed.map(a => ({
    chunkId: a.id, embedding: embeddingById.get(a.id)!, clusterId: a.clusterId,
  })));
  saveCentroids(updated);
  return { ...EMPTY_RESULT, rebalanced: changed.length };
}
