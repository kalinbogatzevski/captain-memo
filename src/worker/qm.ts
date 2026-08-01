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
  /** Semantic consolidation (idle-time). Default ON; off via CAPTAIN_MEMO_QM_SEMANTIC=0.
   *
   *  The pass the pipeline never had. Dedup gates candidacy on TITLE similarity and only then
   *  confirms with cosine, which measured on a 124k corpus makes the confirm dead code: ZERO
   *  semantically-similar pairs reach it at any threshold from 0.90 to 0.97, because nothing
   *  survives the title gate. Two observations stating one fact in different words were
   *  structurally unreachable. This inverts the order — cosine FINDS — for same-session pairs
   *  only, behind every guard the title path already applies. */
  semanticEnabled: boolean;
  /** Cosine at or above which two SAME-SESSION observations are one event.
   *
   *  Same number as dedup's confirm, reached from the other direction: it is the level at which
   *  measured pairs stop being restatements. Note that it is only trustworthy WITH the session
   *  restriction — at this cosine, cross-session pairs are the same standing fact re-learned
   *  weeks apart (a theme, not a fold) and the middle bands hold build progressions that no
   *  threshold separates. */
  semanticCosineThreshold: number;
  /** Max groups one semantic pass may emit — bounds the downstream fold work. */
  semanticMaxGroups: number;
  /** How often to CHECK whether the machine is idle enough to run the pass. The check is
   *  cheap; the pass itself only runs when every idle signal agrees. */
  semanticCheckIntervalMs: number;
  /** Hard floor: seconds of no observation activity before the pass may start. Guards the
   *  case every instantaneous signal misses — a user reading, thinking, or mid-sentence. */
  semanticMinIdleSeconds: number;
  /** Theme building (idle-time, Stage 2). Default ON; off via CAPTAIN_MEMO_QM_THEME=0.
   *
   *  Stage 1 folds same-session restatements. This handles the other measured population: the
   *  same standing fact re-learned across sessions weeks apart, where a fold would destroy the
   *  evidence that it failed to stick. One generated observation states the durable fact; the
   *  originals are archived beneath it and restorable in one call. Requires a summarizer. */
  themeEnabled: boolean;
  /** Cosine for cluster membership. LOWER than the fold threshold on purpose: a theme is
   *  additive and reversible where a fold archives a row into another's identity, so it can
   *  afford a wider net — and the judge is a second, semantic gate the fold path has no
   *  equivalent of. 312 unblocked pairs sit in the 0.93 band on the reference corpus. */
  themeCosineThreshold: number;
  /** Minimum rows for a theme. Two is a pair, not a theme. */
  themeMinMembers: number;
  /** Max clusters judged per pass — each one is a model call. */
  themeMaxClusters: number;
  /** How often to tick WHILE a forced window is open (`consolidate --for`).
   *
   *  Deliberately far shorter than semanticCheckIntervalMs. Those are two clocks with opposite
   *  intents: the scheduled check is tuned for politeness — wake rarely, never intrude — whereas
   *  a forced window is the user explicitly ASKING for intrusion. Inheriting the polite cadence
   *  made `--for 10m` buy roughly one extra pass instead of grinding the backlog, since the
   *  window and the interval were both 10 minutes. */
  forcedTickMs: number;
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
  semanticEnabled: true,
  semanticCosineThreshold: 0.95,
  semanticMaxGroups: 200,
  semanticCheckIntervalMs: 600_000,   // check every 10 min; the pass itself is rare
  semanticMinIdleSeconds: 1_800,      // 30 min quiet before anything starts
  themeEnabled: true,
  themeCosineThreshold: 0.93,
  themeMinMembers: 3,
  themeMaxClusters: 5,                // 5 model calls per idle pass; themes accrue slowly
  forcedTickMs: 30_000,               // while forcing: every 30s, not every 10 min
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
    semanticEnabled: env.CAPTAIN_MEMO_QM_SEMANTIC !== '0',
    semanticCosineThreshold: num(env.CAPTAIN_MEMO_QM_SEMANTIC_COSINE, D.semanticCosineThreshold),
    semanticMaxGroups: num(env.CAPTAIN_MEMO_QM_SEMANTIC_MAX_GROUPS, D.semanticMaxGroups),
    semanticCheckIntervalMs: num(env.CAPTAIN_MEMO_QM_SEMANTIC_CHECK_MS, D.semanticCheckIntervalMs),
    semanticMinIdleSeconds: num(env.CAPTAIN_MEMO_QM_SEMANTIC_MIN_IDLE_S, D.semanticMinIdleSeconds),
    themeEnabled: env.CAPTAIN_MEMO_QM_THEME !== '0',
    themeCosineThreshold: num(env.CAPTAIN_MEMO_QM_THEME_COSINE, D.themeCosineThreshold),
    themeMinMembers: num(env.CAPTAIN_MEMO_QM_THEME_MIN_MEMBERS, D.themeMinMembers),
    themeMaxClusters: num(env.CAPTAIN_MEMO_QM_THEME_MAX_CLUSTERS, D.themeMaxClusters),
    forcedTickMs: num(env.CAPTAIN_MEMO_QM_FORCED_TICK_MS, D.forcedTickMs),
  };
}
