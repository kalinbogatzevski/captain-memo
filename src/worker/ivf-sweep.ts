// src/worker/ivf-sweep.ts — the bounded, heartbeat-safe IVF clustering sweep
// (Track A2). Mirrors tide-sweep.ts's shape exactly: a pure orchestration
// function over injected deps, doing exactly ONE bounded unit of work per
// call — migrate one legacy batch, OR bootstrap once, OR assign one batch of
// newly-unclustered chunks, OR rebalance one batch of already-clustered ones.
// Never more than one of those per tick, so cost per call stays predictable.
import {
  targetClusterCount, seedCentroids, miniBatchUpdate,
  type IvfConfig, type Centroid,
} from './ivf.ts';

export interface IvfSweepDeps {
  collection: string;
  cfg: IvfConfig;
  countLegacyRows: () => number;
  migrateLegacyBatch: (limit: number) => number;
  countVectors: (collection: string) => number;
  getCentroids: (collection: string) => Centroid[];
  setCentroids: (collection: string, centroids: Centroid[]) => void;
  allocateClusterIds: (collection: string, n: number) => number[];
  sampleAnyVectors: (collection: string, limit: number) => Array<{ chunkId: string; embedding: Float32Array }>;
  sampleClusteredVectors: (
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
}

const EMPTY_RESULT: IvfSweepResult = { legacyMigrated: 0, bootstrapped: 0, assigned: 0, rebalanced: 0 };

/**
 * Run one bounded IVF sweep slice. Does exactly one of, in priority order:
 *  1. Migrate one batch of legacy (pre-A2) rows, if any remain — this step
 *     runs UNCONDITIONALLY, regardless of `cfg.enabled`. `add()`/`query()`
 *     operate exclusively on the new `vec_chunks_p` table, so migration is a
 *     required correctness step now, not part of the opt-in clustering
 *     feature — gating it on `enabled` would strand an existing install's
 *     entire corpus in the old table forever on the default (disabled)
 *     config. See the plan's Global Constraints for the full incident.
 *  2. Nothing further, if clustering itself is disabled.
 *  3. Nothing, if the corpus is still below the clustering threshold.
 *  4. Bootstrap centroids (once), if the corpus has crossed the threshold
 *     and no centroids exist yet.
 *  5. Assign one batch of newly-unclustered chunks to existing centroids.
 *  6. Rebalance one batch of already-clustered chunks (periodic upkeep),
 *     only actually moving chunks whose nearest centroid changed.
 */
export async function runIvfSweepSlice(deps: IvfSweepDeps): Promise<IvfSweepResult> {
  const { cfg, collection } = deps;

  const legacyRemaining = deps.countLegacyRows();
  if (legacyRemaining > 0) {
    const migrated = deps.migrateLegacyBatch(cfg.sweepBatch);
    return { ...EMPTY_RESULT, legacyMigrated: migrated };
  }

  if (!cfg.enabled) return EMPTY_RESULT; // clustering itself stays opt-in; migration above does not

  const totalVectors = deps.countVectors(collection);
  if (totalVectors < cfg.minCorpusSize) return EMPTY_RESULT;

  const centroids = deps.getCentroids(collection);
  if (centroids.length === 0) {
    const k = targetClusterCount(totalVectors, cfg);
    const vectors = deps.sampleAnyVectors(collection, k);
    if (vectors.length === 0) return EMPTY_RESULT;
    const clusterIds = deps.allocateClusterIds(collection, Math.min(k, vectors.length));
    const seeded = seedCentroids(
      vectors.map(v => ({ id: v.chunkId, vector: v.embedding })),
      clusterIds,
      deps.sample,
    );
    deps.setCentroids(collection, seeded);
    return { ...EMPTY_RESULT, bootstrapped: seeded.length };
  }

  await deps.yieldToLoop();

  const unclustered = deps.getUnclusteredChunks(collection, cfg.sweepBatch);
  if (unclustered.length > 0) {
    const { centroids: updated, assignments } = miniBatchUpdate(
      unclustered.map(u => ({ id: u.chunkId, vector: u.embedding })),
      centroids,
      cfg,
    );
    const byId = new Map(unclustered.map(u => [u.chunkId, u.embedding]));
    deps.reassignClusterBatch(assignments.map(a => ({
      chunkId: a.id, embedding: byId.get(a.id)!, clusterId: a.clusterId,
    })));
    deps.setCentroids(collection, updated);
    return { ...EMPTY_RESULT, assigned: assignments.length };
  }

  // Nothing unclustered left — periodic rebalance: resample already-clustered
  // vectors and only move the ones whose nearest centroid has actually changed
  // (avoids needless delete+reinsert for chunks that are still correctly placed).
  const sample = deps.sampleClusteredVectors(collection, cfg.sweepBatch);
  if (sample.length === 0) return EMPTY_RESULT;
  const { centroids: updated, assignments } = miniBatchUpdate(
    sample.map(s => ({ id: s.chunkId, vector: s.embedding })),
    centroids,
    cfg,
  );
  const currentClusterById = new Map(sample.map(s => [s.chunkId, s.clusterId]));
  const embeddingById = new Map(sample.map(s => [s.chunkId, s.embedding]));
  const changed = assignments.filter(a => currentClusterById.get(a.id) !== a.clusterId);
  deps.reassignClusterBatch(changed.map(a => ({
    chunkId: a.id, embedding: embeddingById.get(a.id)!, clusterId: a.clusterId,
  })));
  deps.setCentroids(collection, updated);
  return { ...EMPTY_RESULT, rebalanced: changed.length };
}
