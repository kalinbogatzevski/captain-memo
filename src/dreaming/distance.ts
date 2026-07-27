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
 *  other still co-cluster; older pairs need progressively more co-retrieval
 *  to compensate, and past a hard ceiling they cannot cluster at all. That
 *  ceiling is ~19 days at the default eps/τ — see maxBridgeableGapDays, which
 *  computes it exactly and is printed in the dry-run report. (An earlier
 *  version of this comment said co-retrieval could carry cross-month pairs.
 *  It can't: at eps 0.35 even coRet=1.0 tops out just under 19 days.) */
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
 * The weights ACTUALLY applied for a run. When the semantic layer is absent its
 * share is redistributed across the other two, so the same eps threshold means
 * the same thing whether or not semantic is wired up.
 *
 * Exported because two callers need this answer: the one that APPLIES the
 * weights (weightedSimilarity, below) and the one that REPORTS them
 * (orchestrate.ts). Those used to be separate copies of the same arithmetic —
 * orchestrate hardcoded `0.3 / 0.8` — which meant the printed weights would
 * have silently started lying the first time DEFAULT_WEIGHTS was tuned.
 */
export function effectiveWeights(
  hasSemantic: boolean,
  weights: SignalWeights = DEFAULT_WEIGHTS,
): SignalWeights {
  if (hasSemantic) return { ...weights };
  const total = weights.temporal + weights.coRetrieval;
  if (total <= 0) return { semantic: 0, temporal: 0, coRetrieval: 0 };
  return {
    semantic: 0,
    temporal: weights.temporal / total,
    coRetrieval: weights.coRetrieval / total,
  };
}

/**
 * Largest age gap, in days, that can still land inside `eps` — assuming a
 * PERFECT co-retrieval score of 1.0. Past this point two observations cannot
 * cluster however often they are recalled together, because the decayed
 * temporal term can no longer cover the remaining distance.
 *
 * Solve  wC·1 + wT·e^(−Δt/τ) ≥ 1 − eps  for Δt:
 *   Δt ≤ −τ · ln( (1 − eps − wC) / wT )
 *
 * Infinity when co-retrieval alone already clears the threshold (temporal is
 * then never the binding constraint); 0 when even a same-instant pair can't.
 *
 * This is surfaced in the report because the default pairing is easy to
 * misread: at eps 0.35, τ 7d and the semantic-less weights the ceiling is
 * ~19 days, so a `--since 30d` run cannot cluster across its own window
 * unless --tau-days is raised to match. The module header used to claim
 * co-retrieval could carry cross-month pairs; at default eps it cannot.
 */
export function maxBridgeableGapDays(
  eps: number,
  tauSeconds: number,
  weights: SignalWeights = effectiveWeights(false),
): number {
  const needed = 1 - eps - weights.coRetrieval;
  if (needed <= 0) return Infinity;
  if (weights.temporal <= 0) return 0;
  const ratio = needed / weights.temporal;
  if (ratio >= 1) return 0;
  return (-tauSeconds * Math.log(ratio)) / 86400;
}

/**
 * Smallest τ (in days) whose pair-age ceiling covers a look-back window of
 * `windowDays` — i.e. what to pass to --tau-days so a widened --since can
 * actually cluster across itself.
 *
 * The ceiling is linear in τ (ceiling = τ · K for a constant K fixed by eps and
 * the weights), so K is read straight off maxBridgeableGapDays at τ = 1 day
 * rather than restating the logarithm here. At the defaults K ≈ 2.708, which is
 * why the shipped pairing is coherent: --since 14d against a 7d τ gives a 19d
 * ceiling with room to spare.
 *
 * Returns 0 when no τ is needed (the ceiling is already unbounded).
 */
export function tauDaysForWindow(
  windowDays: number,
  eps: number,
  weights: SignalWeights = effectiveWeights(false),
): number {
  const perDay = maxBridgeableGapDays(eps, 86400, weights);
  if (!Number.isFinite(perDay)) return 0;
  if (perDay <= 0) return Infinity;
  return windowDays / perDay;
}

/**
 * Combine signals into a single [0, 1] similarity score.
 *
 * When semantic is null the remaining two weights are renormalized (see
 * effectiveWeights) so the scale stays comparable across runs with/without
 * semantic input.
 */
export function weightedSimilarity(
  signals: SignalInputs,
  weights: SignalWeights = DEFAULT_WEIGHTS,
): number {
  const w = effectiveWeights(signals.semantic !== null, weights);
  if (signals.semantic === null) {
    return Math.max(0, Math.min(1,
      w.temporal * signals.temporal + w.coRetrieval * signals.coRetrieval,
    ));
  }
  // Map cosine [-1, 1] → similarity [0, 1] (clipped) so weights compose cleanly.
  const semSim = Math.max(0, Math.min(1, (signals.semantic + 1) / 2));
  return Math.max(0, Math.min(1,
    w.semantic   * semSim
    + w.temporal * signals.temporal
    + w.coRetrieval * signals.coRetrieval,
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
