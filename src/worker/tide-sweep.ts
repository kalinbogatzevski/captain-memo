// src/worker/tide-sweep.ts — the bounded, heartbeat-safe ebb sweep (Tide tiering,
// Phase 2). Moves idle, low-buoyancy observations DOWN the lifecycle
// (active → dormant → archived). Surfacing (the only upward move) is recall-driven and
// lives in observations-store.bumpRetrieval, never here. The slice yields to the event
// loop between every row and re-checks the abort signal AFTER each yield, so an ingest
// arriving mid-slice preempts it and the writer's 1s heartbeat is never starved.
import {
  computeBuoyancy, tierDecision,
  type TideConfig, type TideState, type TideRow,
} from './tide.ts';

export interface TideSweepDeps {
  /** Bounded, oldest-first candidates past the age floor (see ObservationsStore). */
  candidates: (limit: number, olderThanEpoch: number) => Array<TideRow & { id: number; tide_state: TideState }>;
  /** Persist one downward tier flip (writer-only). */
  setTideState: (id: number, state: TideState, atEpoch: number) => void;
  /** True when ingest/embedding work is queued or running — the slice yields to it. */
  shouldAbort: () => boolean;
  cfg: TideConfig;
  /** Current wall-clock, epoch seconds. Injected for deterministic tests. */
  now: () => number;
  /** Hand control back to the event loop (so the heartbeat fires). Injected for tests. */
  yieldToLoop: () => Promise<void>;
}

export interface TideSweepResult {
  scanned: number;
  ebbed: number;     // active → dormant
  archived: number;  // dormant → archived
  aborted: boolean;  // bailed early to let ingest run
}

/**
 * Run one bounded ebb-sweep slice. Pulls up to `cfg.sweepBatch` oldest candidates past
 * the minimum age floor, applies the pure `tierDecision`, and persists each downward
 * flip. Yields between every row and re-checks `shouldAbort()` AFTER the yield, so an
 * ingest arriving 10ms into a slice preempts it. Pure orchestration over injected deps,
 * so it unit-tests without a worker, a DB, or a real timer.
 */
export async function runTideSweepSlice(deps: TideSweepDeps): Promise<TideSweepResult> {
  const { cfg, now } = deps;
  const result: TideSweepResult = { scanned: 0, ebbed: 0, archived: 0, aborted: false };
  // Tiering requires the MVP re-rank (enabled) — surface-on-recall lives in the enabled
  // bumpRetrieval branch, so we must not ebb rows that recalls couldn't re-float.
  if (!cfg.enabled || !cfg.tieringEnabled) return result;
  if (deps.shouldAbort()) { result.aborted = true; return result; }

  const nowEpoch = now();
  const olderThan = nowEpoch - cfg.ageFloorDays * 86_400; // cheapest age pre-filter, in SQL
  const candidates = deps.candidates(cfg.sweepBatch, olderThan);

  for (const cand of candidates) {
    if (deps.shouldAbort()) { result.aborted = true; break; } // re-checked every iteration
    result.scanned++;
    const buoyancy = computeBuoyancy(cand, nowEpoch, cfg);
    const ageDays = Math.max(0, (nowEpoch - (cand.last_surfaced_at ?? cand.created_at_epoch)) / 86_400);
    const next = tierDecision(
      { current: cand.tide_state, buoyancy, ageDays, fromDrill: cand.from_drill, isAnchored: cand.is_anchored },
      cfg,
    );
    if (next === 'dormant') { deps.setTideState(cand.id, next, nowEpoch); result.ebbed++; }
    else if (next === 'archived') { deps.setTideState(cand.id, next, nowEpoch); result.archived++; }
    await deps.yieldToLoop(); // let the heartbeat fire; abort re-checked next iteration
  }
  return result;
}
