// Central rank-profile config (OSS edition). Mirrors the loadXxxConfig pattern:
// a num()/bool() helper and a pure resolver. v2 is the OSS DEFAULT (ships the
// search-quality ranking out of the box); `legacy` reproduces the prior ranking.
export type RankProfileName = 'legacy' | 'v2';
export type FusionMode = 'rrf' | 'weighted';

export interface RankConfig {
  profile: RankProfileName;
  fusionMode: FusionMode;
  rrfK: number;
  perStrategyTopK: number;
  vectorWeight: number;
  keywordWeight: number;
  temporalIntent: boolean;
  properNounBoost: boolean;
  temporalHalfLifeDays: number; // observation recency half-life (days) for the temporal blend (0 = no decay)
  temporalTopN: number;         // candidate pool the temporal blend re-ranks
  relevanceFloor: number;       // deprecated: no longer consumed by the temporal blend (kept for config compat)
  temporalFloor: number;        // bounded-multiplier floor in [0,1]: a max-stale obs keeps ≥ this of its score (1 = recency off)
  properNounBoostWeight: number;// rare-token boost multiplier (1 = no-op)
  supersedePenalty: number;     // score multiplier for superseded hits (1 = inert/no demote)
}

const LEGACY: RankConfig = {
  profile: 'legacy',
  fusionMode: 'rrf',
  rrfK: 60,
  perStrategyTopK: 25,
  vectorWeight: 0.5,
  keywordWeight: 0.5,
  temporalIntent: false,
  properNounBoost: false,
  temporalHalfLifeDays: 0,
  temporalTopN: 0,
  relevanceFloor: 0,
  temporalFloor: 1,
  properNounBoostWeight: 1,
  supersedePenalty: 1,
};

export const RANK_PROFILES: Record<RankProfileName, RankConfig> = {
  legacy: LEGACY,
  v2: {
    ...LEGACY,
    profile: 'v2',
    fusionMode: 'weighted',
    vectorWeight: 0.7,
    keywordWeight: 0.3,
    temporalIntent: true,
    properNounBoost: true,
    temporalHalfLifeDays: 21,
    temporalTopN: 10,
    relevanceFloor: 0.6,
    temporalFloor: 0.5,
    properNounBoostWeight: 1.15,
    supersedePenalty: 0.5,
  },
};

function isProfileName(v: string | undefined): v is RankProfileName {
  return v === 'legacy' || v === 'v2';
}

/** OSS default = v2 (ships the better ranking). Set CAPTAIN_MEMO_RANK_PROFILE=legacy to opt out. */
export function defaultProfileName(env: Record<string, string | undefined>): RankProfileName {
  const v = env.CAPTAIN_MEMO_RANK_PROFILE;
  return isProfileName(v) ? v : 'v2';
}

export function resolveRankConfig(
  requestProfile: string | undefined,
  env: Record<string, string | undefined>,
): RankConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
  };
  const bool = (v: string | undefined, d: boolean): boolean =>
    v === '1' ? true : v === '0' ? false : d;
  const name: RankProfileName = isProfileName(requestProfile) ? requestProfile : defaultProfileName(env);
  const base = RANK_PROFILES[name];
  const fm = env.CAPTAIN_MEMO_FUSION_MODE;
  return {
    ...base,
    rrfK: num(env.CAPTAIN_MEMO_RRF_K, base.rrfK),
    perStrategyTopK: num(env.CAPTAIN_MEMO_PER_STRATEGY_TOP_K, base.perStrategyTopK),
    fusionMode: fm === 'weighted' || fm === 'rrf' ? fm : base.fusionMode,
    vectorWeight: num(env.CAPTAIN_MEMO_VECTOR_WEIGHT, base.vectorWeight),
    keywordWeight: num(env.CAPTAIN_MEMO_KEYWORD_WEIGHT, base.keywordWeight),
    temporalIntent: bool(env.CAPTAIN_MEMO_TEMPORAL_INTENT, base.temporalIntent),
    properNounBoost: bool(env.CAPTAIN_MEMO_PROPER_NOUN_BOOST, base.properNounBoost),
    temporalHalfLifeDays: num(env.CAPTAIN_MEMO_TEMPORAL_HALF_LIFE_DAYS, base.temporalHalfLifeDays),
    temporalTopN: num(env.CAPTAIN_MEMO_TEMPORAL_TOP_N, base.temporalTopN),
    relevanceFloor: num(env.CAPTAIN_MEMO_RELEVANCE_FLOOR, base.relevanceFloor),
    temporalFloor: num(env.CAPTAIN_MEMO_TEMPORAL_FLOOR, base.temporalFloor),
    properNounBoostWeight: num(env.CAPTAIN_MEMO_PROPER_NOUN_BOOST_WEIGHT, base.properNounBoostWeight),
    supersedePenalty: num(env.CAPTAIN_MEMO_SUPERSEDE_PENALTY, base.supersedePenalty),
  };
}
