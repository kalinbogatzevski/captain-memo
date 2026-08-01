// src/worker/qm.ts — pure Quartermaster config (auto-dedup). No I/O and no side
// effects beyond reading a plain env record in loadQmConfig. Mirrors the tide.ts
// loadTideConfig env-parsing style (numeric parse with default fallback, never NaN).
//
// The Quartermaster runs the housekeeping passes over stored memory (slicing the
// work into bounded chunks, periodically sweeping for near-duplicate rows). Every
// pass defaults ON: an opt-in default meant the housekeeping shipped to nobody.
// Each has its own CAPTAIN_MEMO_QM_* kill switch, and the master switch stops all.
import { DEFAULT_SIMILARITY_THRESHOLD } from '../shared/title-similarity.ts';

export interface QmConfig {
  /** Master switch. Default ON; set CAPTAIN_MEMO_QM_ENABLED=0 to disable the
   *  Quartermaster entirely. */
  enabled: boolean;
  /** Auto-merge of near-duplicate rows. Default ON; off via CAPTAIN_MEMO_QM_DEDUP=0.
   *  It archives a row rather than deleting one, and never touches a drilled or
   *  anchored row, so the fold is recoverable — the opt-in default was priced for a
   *  destructiveness this pass does not have. */
  dedupEnabled: boolean;
  /** Auto-supersede of stale version-facts (P3). Default ON; off via
   *  CAPTAIN_MEMO_QM_SUPERSEDE=0. The safest of the passes — a reversible 0.5x score
   *  demotion that `captain-memo supersede undo` reverses — and the one that spent
   *  longest switched off, having never recorded a single run on the heaviest install. */
  supersedeEnabled: boolean;
  /** Per-slice budget (ms): how long one housekeeping chunk may run. */
  sliceMs: number;
  /** ms between dedup sweeps. */
  dedupIntervalMs: number;
  /** Title-similarity (Jaccard) threshold for two rows to be merge candidates. */
  dedupTitleThreshold: number;
  /** Embedding cosine threshold — both this AND the title threshold must clear
   *  before two rows are merged.
   *
   *  MEASURED on a 122,647-observation corpus: 400 pairs sharing an IDENTICAL title (definitionally the
   *  same knowledge) scored median 0.9467, p95 0.9779, max 0.9896 — only 3.5% reached the old 0.98.
   *  Unrelated same-project pairs sit near 0.50 (p95 0.755). 0.98 was above what two phrasings of one
   *  fact can produce in this space, so dedup merged 5 rows after examining 16,679 candidate groups
   *  across 1,204 runs. It was never blocked by the merge guard or the partitioning — one unsatisfiable
   *  constant. The title gate still has to pass first; this is the confirm, not the whole test. */
  dedupCosineThreshold: number;
  /** Cosine confirm for SUPERSESSION, deliberately separate from dedup's.
   *
   *  The two guard actions of very different destructiveness: dedup ARCHIVES a row; supersede applies a
   *  reversible 0.5x score demotion that `captain-memo supersede undo` reverses. Sharing one constant
   *  made the safe action inherit the dangerous one's paranoia. Version-supersede pairs measure median
   *  0.932, max 0.986 — 0.98 admitted 1 of 292. */
  supersedeCosineThreshold: number;
  /** Max rows compared per dedup sweep — the most-recently-surfaced N.
   *
   *  MEASURED on the same corpus (14,409 surfaced rows across 211 (project,branch) partitions).
   *  Grouping is O(n²) per partition, so the window buys duplicates at a rising price:
   *
   *    window    cost    foldable rows visible
   *       500    37 ms       9
   *     2,000   131 ms      44
   *     5,000   401 ms     200
   *    10,000  1506 ms     553
   *    14,409  3076 ms     850   (the whole surfaced set)
   *
   *  500 was a round number from the original design plan, never measured, and it hid 94% of
   *  the duplicates that existed. Full-scan is not the answer either: candidates() is evaluated
   *  synchronously before the slice's first yield, so 14,409 means a 3-second stall. 5,000 sits
   *  just under the ~450 ms whole-corpus scan the supersede pass already runs hourly. Rows below
   *  the cut are the ones that stopped surfacing — which is also the population dedup least needs
   *  to fold, since its target is what keeps reappearing in the envelope. */
  dedupWindow: number;
}

export const DEFAULT_QM_CONFIG: QmConfig = {
  enabled: true,
  dedupEnabled: true,
  supersedeEnabled: true,
  sliceMs: 150,
  dedupIntervalMs: 3_600_000,
  dedupTitleThreshold: DEFAULT_SIMILARITY_THRESHOLD,
  dedupCosineThreshold: 0.95,
  supersedeCosineThreshold: 0.93,
  dedupWindow: 5_000,
};

/** Build a QmConfig from a plain env record. Unparseable numeric values fall back
 *  to the default (never NaN). Every boolean now reads the same way — ON unless the
 *  operator writes an explicit '0' — so housekeeping arrives without anyone having to
 *  read the env reference to find out it exists. */
export function loadQmConfig(env: Record<string, string | undefined>): QmConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
  };
  const D = DEFAULT_QM_CONFIG;
  return {
    enabled: env.CAPTAIN_MEMO_QM_ENABLED !== '0',
    dedupEnabled: env.CAPTAIN_MEMO_QM_DEDUP !== '0',
    supersedeEnabled: env.CAPTAIN_MEMO_QM_SUPERSEDE !== '0',
    sliceMs: num(env.CAPTAIN_MEMO_QM_SLICE_MS, D.sliceMs),
    dedupIntervalMs: num(env.CAPTAIN_MEMO_QM_DEDUP_INTERVAL_MS, D.dedupIntervalMs),
    dedupTitleThreshold: num(env.CAPTAIN_MEMO_QM_DEDUP_TITLE, D.dedupTitleThreshold),
    dedupCosineThreshold: num(env.CAPTAIN_MEMO_QM_DEDUP_COSINE, D.dedupCosineThreshold),
    supersedeCosineThreshold: num(env.CAPTAIN_MEMO_QM_SUPERSEDE_COSINE, D.supersedeCosineThreshold),
    dedupWindow: num(env.CAPTAIN_MEMO_QM_DEDUP_WINDOW, D.dedupWindow),
  };
}
