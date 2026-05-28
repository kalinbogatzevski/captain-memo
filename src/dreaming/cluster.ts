// src/dreaming/cluster.ts
//
// Pure DBSCAN — density-based clustering keyed off a caller-supplied distance
// function. No I/O, no globals; takes an array of ids and a pairwise distance
// callback, returns clusters + noise. Used by `captain-memo dream --dry-run`
// to validate the spec's clustering hypothesis (docs/specs/2026-05-27-local-
// dreaming-design.md) before any writes or Haiku calls.
//
// Why DBSCAN over k-means / hierarchical:
//   - The spec doesn't know k ahead of time. DBSCAN discovers cluster count.
//   - Density-based handles "noise" (singletons that legitimately don't belong
//     to any theme) without forcing them into the nearest cluster.
//   - Eps + minPts are the two tunables; eps gates "near enough" and minPts
//     gates "dense enough." Both surface directly to the CLI as flags so the
//     user can sweep them against real data without code changes.

/** Identifies a point. Opaque to the algorithm — the caller maps it back to
 *  observation_id, doc_id, or whatever domain key is meaningful. */
export type PointId = number;

/** Distance function. Symmetric (d(a,b) === d(b,a)) and d(a,a) === 0. The
 *  algorithm calls this O(n²) times; expensive callers should memoize. */
export type Distance = (a: PointId, b: PointId) => number;

export interface ClusterOpts {
  /** Maximum distance for two points to be considered neighbors. */
  eps: number;
  /** Minimum neighbor count (including the point itself) to seed a cluster. */
  minPts: number;
}

export interface ClusterResult {
  /** One array of point ids per cluster, in discovery order. */
  clusters: PointId[][];
  /** Points that fell into no cluster — solo themes / outliers. */
  noise: PointId[];
}

/**
 * Density-based clustering.
 *
 * Implementation is the textbook DBSCAN — adapted for small inputs (sub-1000
 * observations) so we keep it dependency-free. For larger corpora the
 * O(n²) neighbor scan becomes the bottleneck; if profiling demands it later
 * we can swap in a kd-tree or ball-tree without changing the API.
 *
 * Determinism: clusters are emitted in the order points appear in `ids`, so
 * the same input always produces the same output. Important for the dry-run
 * report to be stable across re-runs.
 */
export function cluster(
  ids: PointId[],
  distance: Distance,
  opts: ClusterOpts,
): ClusterResult {
  const { eps, minPts } = opts;
  const visited = new Set<PointId>();
  const assigned = new Map<PointId, number>();   // pointId → clusterIndex
  const clusters: PointId[][] = [];
  const noise: PointId[] = [];

  const neighborsOf = (p: PointId): PointId[] => {
    const result: PointId[] = [];
    for (const q of ids) {
      if (q === p) { result.push(q); continue; }
      if (distance(p, q) <= eps) result.push(q);
    }
    return result;
  };

  for (const p of ids) {
    if (visited.has(p)) continue;
    visited.add(p);
    const neighbors = neighborsOf(p);
    if (neighbors.length < minPts) {
      noise.push(p);
      continue;
    }
    // Seed a fresh cluster and walk its density-reachable expansion.
    const clusterIdx = clusters.length;
    const members: PointId[] = [];
    clusters.push(members);
    members.push(p);
    assigned.set(p, clusterIdx);

    const queue = neighbors.filter(n => n !== p);
    while (queue.length > 0) {
      const q = queue.shift()!;
      if (!visited.has(q)) {
        visited.add(q);
        const qNeighbors = neighborsOf(q);
        if (qNeighbors.length >= minPts) {
          // Density-reachable through q: enqueue its neighbors too. We dedupe
          // via visited + assigned rather than a Set on the queue because
          // duplicates produce identical work (visited gate skips re-walks).
          for (const r of qNeighbors) {
            if (!visited.has(r) && !assigned.has(r)) queue.push(r);
          }
        }
      }
      if (!assigned.has(q)) {
        members.push(q);
        assigned.set(q, clusterIdx);
        // q was previously classified as noise — promote it. DBSCAN's
        // "border point" rule: a non-core point inside another core's
        // eps-neighborhood still belongs to that cluster.
        const noiseIdx = noise.indexOf(q);
        if (noiseIdx >= 0) noise.splice(noiseIdx, 1);
      }
    }
  }

  return { clusters, noise };
}
