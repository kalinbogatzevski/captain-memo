import { test, expect } from 'bun:test';
import {
  DEFAULT_TIDE_CONFIG,
  loadTideConfig,
  channelS0,
  computeBuoyancy,
  tideMultiplier,
  nextStability,
  tierDecision,
  type TideRow,
  type TideConfig,
  type TideState,
} from '../../src/worker/tide.ts';

const DAY = 86_400;
const NOW = 1_800_000_000; // fixed epoch seconds for provable recency

function row(over: Partial<TideRow> = {}): TideRow {
  return {
    created_at_epoch: NOW,
    last_surfaced_at: null,
    stability_days: null,
    from_drill: 0,
    is_anchored: false,
    ...over,
  };
}

const cfg: TideConfig = DEFAULT_TIDE_CONFIG;

// ── computeBuoyancy ────────────────────────────────────────────────────────
test('computeBuoyancy — a fresh row is fully afloat (~1)', () => {
  const b = computeBuoyancy(row({ last_surfaced_at: NOW }), NOW, cfg);
  expect(b).toBeCloseTo(1, 5);
});

test('computeBuoyancy — an ancient row sinks but never reaches 0 (fat tail)', () => {
  const old = computeBuoyancy(row({ last_surfaced_at: NOW - 365 * DAY }), NOW, cfg);
  expect(old).toBeGreaterThan(0);   // power-law never underflows
  expect(old).toBeLessThan(0.2);    // and is clearly demoted
});

test('computeBuoyancy — monotonically decreasing in age', () => {
  const young = computeBuoyancy(row({ last_surfaced_at: NOW - 7 * DAY }), NOW, cfg);
  const older = computeBuoyancy(row({ last_surfaced_at: NOW - 90 * DAY }), NOW, cfg);
  expect(young).toBeGreaterThan(older);
});

test('computeBuoyancy — anchored row is always 1.0 regardless of age', () => {
  const b = computeBuoyancy(row({ last_surfaced_at: NOW - 999 * DAY, is_anchored: true }), NOW, cfg);
  expect(b).toBe(1);
});

test('computeBuoyancy — falls back to created_at_epoch when never surfaced', () => {
  const r = row({ created_at_epoch: NOW - 30 * DAY, last_surfaced_at: null });
  const viaCreated = computeBuoyancy(r, NOW, cfg);
  const viaSurfaced = computeBuoyancy(row({ last_surfaced_at: NOW - 30 * DAY }), NOW, cfg);
  expect(viaCreated).toBeCloseTo(viaSurfaced, 10);
});

test('computeBuoyancy — higher stability resists forgetting (decays slower)', () => {
  const ageDays = 60;
  const lowS = computeBuoyancy(row({ last_surfaced_at: NOW - ageDays * DAY, stability_days: 7 }), NOW, cfg);
  const highS = computeBuoyancy(row({ last_surfaced_at: NOW - ageDays * DAY, stability_days: 120 }), NOW, cfg);
  expect(highS).toBeGreaterThan(lowS);
});

// ── the surface property (the headline guarantee) ──────────────────────────
test('computeBuoyancy — a single recall re-floats a long-dormant row', () => {
  // Same stability for both rows, so the ONLY difference is recency: this isolates
  // the surface property — a recall (last_surfaced_at → NOW) re-floats the row.
  const dormant = computeBuoyancy(row({ last_surfaced_at: NOW - 400 * DAY, stability_days: 7 }), NOW, cfg);
  const surfaced = computeBuoyancy(row({ last_surfaced_at: NOW, stability_days: 7 }), NOW, cfg);
  expect(dormant).toBeLessThan(0.2);
  expect(surfaced).toBeCloseTo(1, 5);
});

// ── tideMultiplier (the bounded re-rank factor) ────────────────────────────
test('tideMultiplier — bounded to [B0, 1]; relevance can never be zeroed', () => {
  expect(tideMultiplier(1, cfg)).toBeCloseTo(1, 10);
  expect(tideMultiplier(0, cfg)).toBeCloseTo(cfg.relevanceFloor, 10);     // 0.30 floor
  expect(tideMultiplier(0.5, cfg)).toBeCloseTo(0.30 + 0.70 * 0.5, 10);    // 0.65
});

// ── nextStability (recall strengthening) ───────────────────────────────────
test('nextStability — a recall increases stability (monotone up)', () => {
  const s1 = nextStability(7, 'search', cfg);
  expect(s1).toBeGreaterThan(7);
});

test('nextStability — drill strengthens more than search more than auto', () => {
  const a = nextStability(7, 'auto', cfg);
  const s = nextStability(7, 'search', cfg);
  const d = nextStability(7, 'drill', cfg);
  expect(d).toBeGreaterThan(s);
  expect(s).toBeGreaterThan(a);
});

test('nextStability — saturates: the relative gain shrinks as S grows', () => {
  const gainSmall = nextStability(7, 'drill', cfg) / 7;
  const gainBig = nextStability(700, 'drill', cfg) / 700;
  expect(gainBig).toBeLessThan(gainSmall);
});

test('nextStability — NULL seeds from the channel S0, then grows', () => {
  const seeded = nextStability(null, 'search', cfg, 'observation');
  expect(seeded).toBeGreaterThan(channelS0('observation', cfg));
});

// ── channelS0 + loadTideConfig ─────────────────────────────────────────────
test('channelS0 — per-channel initial stability', () => {
  expect(channelS0('observation', cfg)).toBe(7);
  expect(channelS0('memory', cfg)).toBe(60);
  expect(channelS0('skill', cfg)).toBe(180);
});

// ── tiering config (Phase 2) ───────────────────────────────────────────────
test('loadTideConfig — tiering is opt-in (default off), env flips + threshold overrides', () => {
  expect(loadTideConfig({}).tieringEnabled).toBe(false);
  expect(loadTideConfig({ CAPTAIN_MEMO_TIDE_TIERING: '1' }).tieringEnabled).toBe(true);
  expect(loadTideConfig({ CAPTAIN_MEMO_TIDE_EBB_THRESHOLD: '0.4' }).ebbThreshold).toBe(0.4);
  expect(loadTideConfig({ CAPTAIN_MEMO_TIDE_AGE_FLOOR_DAYS: '30' }).ageFloorDays).toBe(30);
  expect(loadTideConfig({ CAPTAIN_MEMO_TIDE_ARCHIVE_AGE_DAYS: '365' }).archiveAgeDays).toBe(365);
  expect(loadTideConfig({ CAPTAIN_MEMO_TIDE_SWEEP_BATCH: 'oops' }).sweepBatch).toBe(DEFAULT_TIDE_CONFIG.sweepBatch);
});

// ── tierDecision (Phase 2 state machine) ───────────────────────────────────
function dec(over: Partial<{ current: TideState; buoyancy: number; ageDays: number; fromDrill: number; isAnchored: boolean }> = {}) {
  return tierDecision(
    { current: 'active', buoyancy: 0.01, ageDays: 400, fromDrill: 0, isAnchored: false, ...over },
    cfg,
  );
}

test('tierDecision — anchored rows never ebb', () => {
  expect(dec({ isAnchored: true })).toBeNull();
});

test('tierDecision — any drill makes a row permanently ebb-ineligible', () => {
  expect(dec({ fromDrill: 1 })).toBeNull();
});

test('tierDecision — active → dormant when buoyancy below ebb AND past the age floor', () => {
  expect(dec({ current: 'active', buoyancy: 0.2, ageDays: 100 })).toBe('dormant');
});

test('tierDecision — age gate: young rows do not ebb even at near-zero buoyancy', () => {
  expect(dec({ current: 'active', buoyancy: 0.01, ageDays: 30 })).toBeNull();
});

test('tierDecision — buoyancy gate: afloat rows do not ebb even when old', () => {
  expect(dec({ current: 'active', buoyancy: 0.9, ageDays: 400 })).toBeNull();
});

test('tierDecision — dormant → archived only below the archive floor AND past archive age', () => {
  expect(dec({ current: 'dormant', buoyancy: 0.01, ageDays: 200 })).toBe('archived');
  expect(dec({ current: 'dormant', buoyancy: 0.2, ageDays: 400 })).toBeNull();   // above archive floor
  expect(dec({ current: 'dormant', buoyancy: 0.01, ageDays: 100 })).toBeNull();  // below archive age
});

test('tierDecision — never moves up; archived is terminal for the sweep', () => {
  expect(dec({ current: 'archived', buoyancy: 0.01, ageDays: 999 })).toBeNull();
  // a high-buoyancy dormant row is left for recall to surface, never lifted by the sweep
  expect(dec({ current: 'dormant', buoyancy: 0.95, ageDays: 1 })).toBeNull();
});

test('loadTideConfig — enabled by default (v0.5.3+), explicit 0 disables, overrides', () => {
  expect(loadTideConfig({}).enabled).toBe(true);                                  // default ON
  expect(loadTideConfig({ CAPTAIN_MEMO_TIDE_ENABLED: '0' }).enabled).toBe(false); // explicit OFF
  expect(loadTideConfig({ CAPTAIN_MEMO_TIDE_ENABLED: '1' }).enabled).toBe(true);
  expect(loadTideConfig({ CAPTAIN_MEMO_TIDE_ENABLED: 'anything-else' }).enabled).toBe(true);
  expect(loadTideConfig({ CAPTAIN_MEMO_TIDE_RELEVANCE_FLOOR: '0.5' }).relevanceFloor).toBe(0.5);
  expect(loadTideConfig({ CAPTAIN_MEMO_TIDE_S0_OBSERVATION_DAYS: '14' }).s0.observation).toBe(14);
  // garbage falls back to the default rather than NaN
  expect(loadTideConfig({ CAPTAIN_MEMO_TIDE_W20: 'oops' }).w20).toBe(DEFAULT_TIDE_CONFIG.w20);
});
