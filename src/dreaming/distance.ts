// src/dreaming/distance.ts
//
// Distance/similarity primitives for Local Dreaming. Per the spec
// (docs/specs/2026-05-27-local-dreaming-design.md), the clustering signal is
// a weighted combination of THREE layers:
//
//   1. Semantic embedding similarity   (always available, weak alone)
//   2. Temporal proximity              (likely-same-project window)
//   3. Co-retrieval frequency          (strongest signal — user-validated)
//
// v0.1.12+ widened the upstream co-retrieval signal by wiring /inject/context
// to bump from_auto on every prompt (the audit log captures who-was-surfaced-
// with-whom). This module provides the math; the loader (load.ts) supplies
// the inputs.
//
// SCOPE OF THIS FILE: dry-run v1 ships TEMPORAL + CO-RETRIEVAL only. Semantic
// is intentionally deferred — its inclusion requires pulling vectors out of
// the vector store, which adds I/O complexity that isn't worth paying before
// the simpler signals are validated against real data. Weights are re-
// normalized when semantic is absent (see weightedSimilarity).

/** Temporal similarity in (0, 1]. exp(-Δt / τ) — decays smoothly as the
 *  gap grows. τ = 7 days by default: pairs created within ~a week of each
 *  other still co-cluster; cross-month pairs essentially don't unless the
 *  co-retrieval signal carries them. */
export function temporalSimilarity(
  a_epoch: number,
  b_epoch: number,
  tauSeconds = 7 * 24 * 60 * 60,
): number {
  const dt = Math.abs(a_epoch - b_epoch);
  return Math.exp(-dt / tauSeconds);
}

/** Co-retrieval similarity in [0, 1]. Computed from how often two
 *  observations co-occur in the same retrieval response, normalized against
 *  each side's individual surface rate.
 *
 *  Formula: Jaccard-like overlap of surface events.
 *     coOccur(a, b) / (surfaces(a) + surfaces(b) - coOccur(a, b))
 *
 *  Rationale: two observations surfaced 100 times each, never together →
 *  zero co-retrieval. Two observations surfaced 5 times each, always together
 *  → 1.0. Symmetric, bounded, and immune to the "popular by accident" trap
 *  where a high-volume observation would otherwise dominate any pair it's in.
 *
 *  Returns 0 when either side never surfaced — no signal to extract. */
export function coRetrievalSimilarity(
  coOccur: number,
  surfacesA: number,
  surfacesB: number,
): number {
  if (surfacesA === 0 || surfacesB === 0) return 0;
  const denom = surfacesA + surfacesB - coOccur;
  if (denom <= 0) return 0;
  return Math.max(0, Math.min(1, coOccur / denom));
}

export interface SignalInputs {
  /** Optional cosine similarity in [-1, 1]. Pass null to skip the semantic
   *  layer; weights are renormalized automatically. */
  semantic: number | null;
  temporal: number;
  coRetrieval: number;
}

export interface SignalWeights {
  semantic: number;
  temporal: number;
  coRetrieval: number;
}

/** Spec-prescribed weights when ALL three signals are present. Tunable post-
 *  data; see Open Question #1 in the spec. */
export const DEFAULT_WEIGHTS: SignalWeights = {
  semantic: 0.2,
  temporal: 0.3,
  coRetrieval: 0.5,
};

/**
 * Combine signals into a single [0, 1] similarity score.
 *
 * When semantic is null the remaining two weights are renormalized so the
 * scale stays comparable across runs with/without semantic input — important
 * because the same eps threshold should mean the same thing whether or not
 * the semantic layer is wired up.
 */
export function weightedSimilarity(
  signals: SignalInputs,
  weights: SignalWeights = DEFAULT_WEIGHTS,
): number {
  if (signals.semantic === null) {
    const totalWithoutSem = weights.temporal + weights.coRetrieval;
    if (totalWithoutSem <= 0) return 0;
    const tNorm = weights.temporal / totalWithoutSem;
    const cNorm = weights.coRetrieval / totalWithoutSem;
    return Math.max(0, Math.min(1,
      tNorm * signals.temporal + cNorm * signals.coRetrieval,
    ));
  }
  // Map cosine [-1, 1] → similarity [0, 1] (clipped) so weights compose cleanly.
  const semSim = Math.max(0, Math.min(1, (signals.semantic + 1) / 2));
  return Math.max(0, Math.min(1,
    weights.semantic   * semSim
    + weights.temporal * signals.temporal
    + weights.coRetrieval * signals.coRetrieval,
  ));
}

/** Convert a similarity score in [0, 1] into a distance in [0, 1].
 *  DBSCAN's eps gates on distance, so callers compose:
 *
 *    distance(a, b) = similarityToDistance(weightedSimilarity({...}))
 */
export function similarityToDistance(similarity: number): number {
  return 1 - Math.max(0, Math.min(1, similarity));
}
