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

export type PromotionMode = 'off' | 'shadow' | 'on';

export interface PromotionConfig {
  /** Master switch, ONE knob with three values so two flags can never contradict each other:
   *   '1' | 'on' -> on      (judges, writes curated memory, stamps promoted/declined)
   *   'shadow'   -> shadow  (judges, records verdicts to its own ledger, writes NOTHING)
   *   anything else, including unset/'true'/'yes'/typos -> off
   *  The asymmetry is deliberate and inherited: a misread env var must fail to "didn't run",
   *  never to "ran unsupervised against the user's memory dir". */
  mode: PromotionMode;
  /** ms between promotion ticks. */
  intervalMs: number;
  /** Per-run promotion cap. */
  maxPerRun: number;
  /** Minimum recall signal (from_auto + from_search + from_drill) for a row to
   *  be a candidate. Importance gate, mirrors spec §7 "recall-count ≥ k". */
  minRecall: number;
}

export const DEFAULT_PROMOTION_CONFIG: PromotionConfig = {
  mode: 'off',
  intervalMs: DEFAULT_PROMOTE_INTERVAL_MS,
  maxPerRun: DEFAULT_PROMOTE_MAX_PER_RUN,
  minRecall: 1,
};

/** '1'/'on' -> on, 'shadow' -> shadow, EVERYTHING else -> off. Case/whitespace tolerant on the two
 *  recognised words, because "SHADOW " failing closed to a live-looking config would be worse than
 *  useless — but never tolerant enough to turn a typo into a live run. */
export function parseMode(raw: string | undefined): PromotionMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '1' || v === 'on') return 'on';
  if (v === 'shadow') return 'shadow';
  return 'off';
}

/** Build a PromotionConfig from a plain env record. Unparseable numeric values
 *  fall back to the default (never NaN). enabled is ON only on explicit '1'. */
export function loadPromotionConfig(env: Record<string, string | undefined>): PromotionConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
  };
  const D = DEFAULT_PROMOTION_CONFIG;
  return {
    mode: parseMode(env[ENV_PROMOTE_ENABLE]),
    intervalMs: num(env[ENV_PROMOTE_INTERVAL_MS], D.intervalMs),
    maxPerRun: num(env[ENV_PROMOTE_MAX_PER_RUN], D.maxPerRun),
    minRecall: D.minRecall,
  };
}
