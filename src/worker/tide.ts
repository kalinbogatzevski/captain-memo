// src/worker/tide.ts — pure Tide memory-lifecycle math (Track A7). No I/O and no
// side effects (beyond reading a plain env record in loadTideConfig). Imported by
// index.ts (read-time re-rank) and observations-store.ts (the channel S0 seed).
//
// Model (see docs/tide-quartermaster.md): a memory's *buoyancy* — how afloat it is
// in its own right — is a query-INDEPENDENT signal combined with the hybrid-RRF
// relevance score as a BOUNDED multiplier, so relevance is never overridden:
//
//   buoyancy   = (1 + W20 · age_days / S)^(-1)            // FSRS power-law, fat tail
//   multiplier = B0 + (1 - B0) · buoyancy   ∈ [B0, 1]     // bounded re-rank factor
//
// where S (stability, days) is a slow-moving resistance-to-forgetting that only
// grows on recall — so a single recall (which resets age via last_surfaced_at)
// re-floats even a long-dormant row. The MVP uses a rational saturation for the
// strengthening (no exp/pow), so the writer-side update stays a single SQL UPDATE.
import type { RetrievalSource } from '../shared/types.ts';

export type TideChannel = 'observation' | 'memory' | 'skill';

export interface TideConfig {
  /** Master switch. When false the worker keeps today's flat recency decay. */
  enabled: boolean;
  /** B0 — relevance floor; the multiplier is bounded to [B0, 1] so a stale-but-
   *  relevant hit is demoted, never zeroed. */
  relevanceFloor: number;
  /** FSRS power-law shape constant. */
  w20: number;
  /** Per-channel initial stability (days), used when stability_days IS NULL. */
  s0: { observation: number; memory: number; skill: number };
  /** g(source) — recall-strengthening weight per provenance. A deliberate drill
   *  strengthens most; auto (the system's own co-occurrence) least. */
  src: { auto: number; search: number; drill: number };
  /** Base strengthening gain per recall. */
  stabilityGain: number;
  /** Saturation knob: fS = cap / (cap + S). Hot rows plateau, can't starve corpus. */
  stabilityCapDays: number;
}

export const DEFAULT_TIDE_CONFIG: TideConfig = {
  enabled: false,
  relevanceFloor: 0.30,
  w20: 0.15,
  s0: { observation: 7, memory: 60, skill: 180 },
  src: { auto: 0.5, search: 1.0, drill: 1.5 },
  stabilityGain: 0.5,
  stabilityCapDays: 365,
};

/** Build a TideConfig from a plain env record. Unparseable values fall back to
 *  the default (never NaN) — every threshold is config-driven on purpose. */
export function loadTideConfig(env: Record<string, string | undefined>): TideConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
  };
  const D = DEFAULT_TIDE_CONFIG;
  return {
    enabled: env.CAPTAIN_MEMO_TIDE_ENABLED === '1',
    relevanceFloor: num(env.CAPTAIN_MEMO_TIDE_RELEVANCE_FLOOR, D.relevanceFloor),
    w20: num(env.CAPTAIN_MEMO_TIDE_W20, D.w20),
    s0: {
      observation: num(env.CAPTAIN_MEMO_TIDE_S0_OBSERVATION_DAYS, D.s0.observation),
      memory: num(env.CAPTAIN_MEMO_TIDE_S0_MEMORY_DAYS, D.s0.memory),
      skill: num(env.CAPTAIN_MEMO_TIDE_S0_SKILL_DAYS, D.s0.skill),
    },
    src: {
      auto: num(env.CAPTAIN_MEMO_TIDE_SRC_AUTO, D.src.auto),
      search: num(env.CAPTAIN_MEMO_TIDE_SRC_SEARCH, D.src.search),
      drill: num(env.CAPTAIN_MEMO_TIDE_SRC_DRILL, D.src.drill),
    },
    stabilityGain: num(env.CAPTAIN_MEMO_TIDE_STAB_GAIN, D.stabilityGain),
    stabilityCapDays: num(env.CAPTAIN_MEMO_TIDE_STAB_CAP_DAYS, D.stabilityCapDays),
  };
}

/** Initial stability (days) for a channel — used when stability_days IS NULL. */
export function channelS0(channel: TideChannel, cfg: TideConfig): number {
  return channel === 'memory' ? cfg.s0.memory
    : channel === 'skill' ? cfg.s0.skill
    : cfg.s0.observation;
}

/** The subset of an observations row needed to compute buoyancy. */
export interface TideRow {
  created_at_epoch: number;
  last_surfaced_at: number | null;
  stability_days: number | null;
  from_drill: number;
  is_anchored: boolean;
}

/**
 * Buoyancy ∈ (0, 1] — how afloat the memory is on its own. Power-law in age so
 * ancient context sinks but never underflows to 0 (a drill can always resurface
 * it). Anchored rows are pinned at 1. Recency is measured from the last recall
 * (last_surfaced_at), falling back to creation when never surfaced — so a recall
 * resets age and re-floats the row.
 */
export function computeBuoyancy(
  rowData: TideRow,
  nowEpoch: number,
  cfg: TideConfig,
  channel: TideChannel = 'observation',
): number {
  if (rowData.is_anchored) return 1;
  const sinceEpoch = rowData.last_surfaced_at ?? rowData.created_at_epoch;
  const ageDays = Math.max(0, (nowEpoch - sinceEpoch) / 86_400);
  const S = rowData.stability_days ?? channelS0(channel, cfg);
  if (S <= 0) return 1; // degenerate guard: never divide by zero, treat as fresh
  return 1 / (1 + (cfg.w20 * ageDays) / S);
}

/** Bounded re-rank multiplier ∈ [B0, 1]. Multiplies the fused RRF score; relevance
 *  always dominates because the floor B0 prevents zeroing. */
export function tideMultiplier(buoyancy: number, cfg: TideConfig): number {
  return cfg.relevanceFloor + (1 - cfg.relevanceFloor) * buoyancy;
}

/**
 * Stability after a recall: S_new = S · (1 + gain · g(source) · fS), with rational
 * saturation fS = cap / (cap + S). Monotonically increasing (a recall only ever
 * strengthens), source-weighted (drill > search > auto), and saturating (hot rows
 * plateau and can't starve the rest of the corpus). NULL seeds from the channel S0.
 *
 * The shape is intentionally arithmetic-only (no exp/pow) so the writer-side update
 * is a single SQL UPDATE that mirrors this exactly — see observations-store.ts.
 */
export function nextStability(
  currentS: number | null,
  source: RetrievalSource,
  cfg: TideConfig,
  channel: TideChannel = 'observation',
): number {
  const S = currentS ?? channelS0(channel, cfg);
  const g = cfg.src[source];
  const fS = cfg.stabilityCapDays / (cfg.stabilityCapDays + S);
  return S * (1 + cfg.stabilityGain * g * fS);
}
