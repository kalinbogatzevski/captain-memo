// src/dreaming/orchestrate.ts
//
// Glue between the loader and the pure cluster module. Builds a closure-
// captured distance function over a DreamInputs bundle, runs DBSCAN, and
// returns a structured report. Read-only — no DB writes, no Haiku calls.

import { cluster, type PointId, type ClusterResult } from './cluster.ts';
import type { DreamInputs, DreamObservation } from './load.ts';
import {
  temporalSimilarity,
  coRetrievalSimilarity,
  weightedSimilarity,
  similarityToDistance,
} from './distance.ts';

export interface DreamRunOpts {
  /** DBSCAN eps in distance space [0, 1]. Spec default 0.35. */
  eps: number;
  /** DBSCAN minPts. Spec default 3. */
  minPts: number;
  /** Temporal decay constant in seconds. Spec default 7 days. */
  tauSeconds: number;
}

export interface DreamCluster {
  /** Observations in this cluster, in order of appearance in inputs. */
  members: DreamObservation[];
  /** Span (oldest → newest) in epoch seconds. */
  span: { from: number; to: number };
  /** Sum of co-occurrence counts across all member pairs — a coarse "how
   *  tight is this theme" score. Higher = stronger evidence the user treats
   *  these as one topic. */
  coOccurrenceWeight: number;
}

export interface DreamReport {
  /** Total observations the loader returned for the window. */
  total: number;
  /** Number of points with zero co-retrieval evidence — useful for diagnosing
   *  whether the audit log is actually populated. */
  withoutCoRetrieval: number;
  /** Discovered clusters. */
  clusters: DreamCluster[];
  /** Observations that didn't reach minPts density — solo notes. */
  noise: DreamObservation[];
  /** Effective signal weights (after renormalization when semantic is absent). */
  weights: { semantic: number; temporal: number; coRetrieval: number };
  /** Pass-through of the eps / minPts / tau that produced this report. */
  opts: DreamRunOpts;
}

/**
 * Run the dry-run pipeline against a pre-loaded input bundle. Pure — no I/O.
 * The caller is responsible for loading inputs (see load.ts) and rendering
 * the report (see report.ts).
 */
export function dryRun(inputs: DreamInputs, opts: DreamRunOpts): DreamReport {
  const byId = new Map<number, DreamObservation>();
  for (const obs of inputs.observations) byId.set(obs.id, obs);

  // Pre-compute "any co-retrieval evidence at all" per id for diagnostics.
  const seenInPair = new Set<number>();
  for (const key of inputs.coOccurrence.keys()) {
    const [a, b] = key.split(':').map(Number);
    seenInPair.add(a!);
    seenInPair.add(b!);
  }
  const withoutCoRetrieval = inputs.observations.filter(o => !seenInPair.has(o.id)).length;

  // Distance closure. Semantic is intentionally absent in v1 — see distance.ts
  // module header for rationale. The weights returned in the report reflect
  // the renormalized (semantic-less) form so users can verify what was used.
  const distance = (a: PointId, b: PointId): number => {
    if (a === b) return 0;
    const A = byId.get(a);
    const B = byId.get(b);
    if (!A || !B) return Infinity;  // unknown id: pushed outside any eps.

    const temporal = temporalSimilarity(A.created_at_epoch, B.created_at_epoch, opts.tauSeconds);
    const co = inputs.coOccurrence.get(inputs.pairKey(A.id, B.id)) ?? 0;
    const coSim = coRetrievalSimilarity(co, A.surfaces, B.surfaces);
    const sim = weightedSimilarity({ semantic: null, temporal, coRetrieval: coSim });
    return similarityToDistance(sim);
  };

  const ids = inputs.observations.map(o => o.id);
  const result: ClusterResult = cluster(ids, distance, { eps: opts.eps, minPts: opts.minPts });

  const clusters: DreamCluster[] = result.clusters.map(memberIds => {
    const members = memberIds.map(id => byId.get(id)!).filter(Boolean);
    let weight = 0;
    for (let i = 0; i < memberIds.length; i++) {
      for (let j = i + 1; j < memberIds.length; j++) {
        weight += inputs.coOccurrence.get(inputs.pairKey(memberIds[i]!, memberIds[j]!)) ?? 0;
      }
    }
    const epochs = members.map(m => m.created_at_epoch);
    return {
      members,
      span: { from: Math.min(...epochs), to: Math.max(...epochs) },
      coOccurrenceWeight: weight,
    };
  });

  const noise = result.noise.map(id => byId.get(id)!).filter(Boolean);

  return {
    total: inputs.observations.length,
    withoutCoRetrieval,
    clusters,
    noise,
    // Renormalized weights as actually used (semantic absent → 0).
    weights: { semantic: 0, temporal: 0.3 / 0.8, coRetrieval: 0.5 / 0.8 },
    opts,
  };
}
