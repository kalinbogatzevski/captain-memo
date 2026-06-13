// src/worker/promotion-config.ts — pure config for the opt-in promotion job.
// No I/O beyond reading a plain env record (mirrors qm.ts/loadQmConfig). The
// job promotes durable, high-signal observations into curated memory via the
// shared writeMemory() path; it is OFF by default (a write to the user's memory
// dir), so enable is asymmetric: ON only on explicit '1'. Spec §7/§8.
import {
  DEFAULT_PROMOTE_INTERVAL_MS,
  DEFAULT_PROMOTE_MAX_PER_RUN,
  ENV_PROMOTE_ENABLE,
  ENV_PROMOTE_INTERVAL_MS,
  ENV_PROMOTE_MAX_PER_RUN,
} from '../shared/paths.ts';

export interface PromotionConfig {
  /** Master switch. Default OFF; set CAPTAIN_MEMO_PROMOTE_ENABLE=1 to enable. */
  enabled: boolean;
  /** ms between promotion ticks. */
  intervalMs: number;
  /** Per-run promotion cap. */
  maxPerRun: number;
  /** Minimum recall signal (from_auto + from_search + from_drill) for a row to
   *  be a candidate. Importance gate, mirrors spec §7 "recall-count ≥ k". */
  minRecall: number;
}

export const DEFAULT_PROMOTION_CONFIG: PromotionConfig = {
  enabled: false,
  intervalMs: DEFAULT_PROMOTE_INTERVAL_MS,
  maxPerRun: DEFAULT_PROMOTE_MAX_PER_RUN,
  minRecall: 1,
};

/** Build a PromotionConfig from a plain env record. Unparseable numeric values
 *  fall back to the default (never NaN). enabled is ON only on explicit '1'. */
export function loadPromotionConfig(env: Record<string, string | undefined>): PromotionConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
  };
  const D = DEFAULT_PROMOTION_CONFIG;
  return {
    enabled: env[ENV_PROMOTE_ENABLE] === '1',
    intervalMs: num(env[ENV_PROMOTE_INTERVAL_MS], D.intervalMs),
    maxPerRun: num(env[ENV_PROMOTE_MAX_PER_RUN], D.maxPerRun),
    minRecall: D.minRecall,
  };
}
