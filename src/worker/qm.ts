// src/worker/qm.ts — pure Quartermaster config (auto-dedup). No I/O and no side
// effects beyond reading a plain env record in loadQmConfig. Mirrors the tide.ts
// loadTideConfig env-parsing style (numeric parse with default fallback, never NaN).
//
// The Quartermaster runs the housekeeping passes over stored memory (slicing the
// work into bounded chunks, periodically sweeping for near-duplicate rows). Auto-
// merge is OFF by default — dedup is a destructive consolidation, so it's strictly
// opt-in (CAPTAIN_MEMO_QM_DEDUP=1) while the master switch defaults ON.
import { DEFAULT_SIMILARITY_THRESHOLD } from '../shared/title-similarity.ts';

export interface QmConfig {
  /** Master switch. Default ON; set CAPTAIN_MEMO_QM_ENABLED=0 to disable the
   *  Quartermaster entirely. */
  enabled: boolean;
  /** Auto-merge of near-duplicate rows. Default OFF — a destructive consolidation,
   *  so opt-in only via CAPTAIN_MEMO_QM_DEDUP=1. */
  dedupEnabled: boolean;
  /** Auto-supersede of stale version-facts (P3). Default OFF — opt-in only via
   *  CAPTAIN_MEMO_QM_SUPERSEDE=1. */
  supersedeEnabled: boolean;
  /** Per-slice budget (ms): how long one housekeeping chunk may run. */
  sliceMs: number;
  /** ms between dedup sweeps. */
  dedupIntervalMs: number;
  /** Title-similarity (Jaccard) threshold for two rows to be merge candidates. */
  dedupTitleThreshold: number;
  /** Embedding cosine threshold — both this AND the title threshold must clear
   *  before two rows are merged. */
  dedupCosineThreshold: number;
  /** Max rows compared per dedup sweep. */
  dedupWindow: number;
}

export const DEFAULT_QM_CONFIG: QmConfig = {
  enabled: true,
  dedupEnabled: false,
  supersedeEnabled: false,
  sliceMs: 150,
  dedupIntervalMs: 3_600_000,
  dedupTitleThreshold: DEFAULT_SIMILARITY_THRESHOLD,
  dedupCosineThreshold: 0.98,
  dedupWindow: 500,
};

/** Build a QmConfig from a plain env record. Unparseable numeric values fall back
 *  to the default (never NaN). Booleans are asymmetric on purpose: enabled defaults
 *  ON (off only on explicit '0'); dedupEnabled defaults OFF (on only on explicit '1'). */
export function loadQmConfig(env: Record<string, string | undefined>): QmConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
  };
  const D = DEFAULT_QM_CONFIG;
  return {
    enabled: env.CAPTAIN_MEMO_QM_ENABLED !== '0',
    dedupEnabled: env.CAPTAIN_MEMO_QM_DEDUP === '1',
    supersedeEnabled: env.CAPTAIN_MEMO_QM_SUPERSEDE === '1',
    sliceMs: num(env.CAPTAIN_MEMO_QM_SLICE_MS, D.sliceMs),
    dedupIntervalMs: num(env.CAPTAIN_MEMO_QM_DEDUP_INTERVAL_MS, D.dedupIntervalMs),
    dedupTitleThreshold: num(env.CAPTAIN_MEMO_QM_DEDUP_TITLE, D.dedupTitleThreshold),
    dedupCosineThreshold: num(env.CAPTAIN_MEMO_QM_DEDUP_COSINE, D.dedupCosineThreshold),
    dedupWindow: num(env.CAPTAIN_MEMO_QM_DEDUP_WINDOW, D.dedupWindow),
  };
}
