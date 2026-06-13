// src/worker/promotion.ts — the pure, heartbeat-safe promotion slice (opt-in).
// Modelled on quartermaster.ts/runQmDedupSlice: pure orchestration over INJECTED
// deps, so it unit-tests with no worker, DB, or real timer. It pulls a bounded
// candidate window of durable, high-signal observations, runs ONE judge pass
// (the "remember forever?" gate — most observations are NOT promoted) that
// distills each survivor into a curated {type,name,description,body}, writes each
// via the shared writeMemory() with sourceObservationId provenance and NO cwd
// (so target resolution falls through to deps.rememberDir), marks it promoted so
// a re-run never re-promotes it, caps at cfg.maxPerRun, and logs every
// promote/skip with a reason. Off unless cfg.enabled.
import type { Observation } from '../shared/types.ts';
import type { RememberInput, WriteMemoryResult } from './memory-writer.ts';
import type { PromotionConfig } from './promotion-config.ts';

/** One judged survivor — the distilled curated entry the judge returns. */
export interface PromotionVerdict {
  sourceObservationId: number;
  type: string;
  name: string;
  description: string;
  body: string;
}

export interface PromotionDeps {
  /** Bounded candidate window (durable types + recall ≥ minRecall, not yet
   *  promoted) — typically obsStore.promotionCandidates(...). */
  candidates: () => Observation[];
  /** ONE judge pass over all candidates: returns ONLY the survivors to promote,
   *  each distilled. The gate — most rows are dropped (absent from the result). */
  judge: (rows: Observation[]) => Promise<PromotionVerdict[]>;
  /** Shared curated-memory writer. The slice passes NO cwd so the target falls
   *  through to deps.rememberDir inside writeMemory. */
  writeMemory: (input: RememberInput) => Promise<WriteMemoryResult>;
  /** Stamp the source observation promoted (idempotency) — obsStore.markPromoted. */
  markPromoted: (id: number, atEpoch: number) => void;
  cfg: PromotionConfig;
  /** Current wall-clock, epoch seconds. Injected for deterministic tests. */
  now: () => number;
  /** Structured logging sink (console.error in prod) — every promote/skip. */
  log: (line: string) => void;
}

export interface PromotionResult {
  scanned: number;  // candidates the judge saw
  promoted: number; // observations written to curated memory + marked
  skipped: number;  // candidates the judge dropped, or writes beyond the cap
  errored: number;  // writes that threw or returned { ok: false }
}

/**
 * Run one promotion slice. Off unless cfg.enabled. Pulls candidates, runs one
 * judge pass, then writes up to cfg.maxPerRun survivors via writeMemory (NO cwd
 * ⇒ rememberDir). A row is marked promoted ONLY on a successful write, so a
 * failed write retries next run (no silent loss); a survivor beyond the cap is
 * left unmarked and picked up next run. Never throws on a single bad write — it
 * logs and counts it.
 */
export async function runPromotionSlice(deps: PromotionDeps): Promise<PromotionResult> {
  const res: PromotionResult = { scanned: 0, promoted: 0, skipped: 0, errored: 0 };
  if (!deps.cfg.enabled) return res; // off by default — consult nothing
  const atEpoch = deps.now();

  const rows = deps.candidates();
  res.scanned = rows.length;
  if (rows.length === 0) return res;

  const verdicts = await deps.judge(rows);
  const keepIds = new Set(verdicts.map(v => v.sourceObservationId));
  for (const r of rows) {
    if (!keepIds.has(r.id)) {
      res.skipped++;
      deps.log(`[promote] skip obs ${r.id} "${r.title}" — judged ephemeral`);
    }
  }

  for (const v of verdicts) {
    if (res.promoted >= deps.cfg.maxPerRun) {
      res.skipped++;
      deps.log(`[promote] skip obs ${v.sourceObservationId} — max-per-run cap (${deps.cfg.maxPerRun}) reached`);
      continue;
    }
    const input: RememberInput = {
      body: v.body,
      type: v.type,
      name: v.name,
      description: v.description,
      projectContext: {}, // NO cwd ⇒ writeMemory targets deps.rememberDir
      sourceObservationId: v.sourceObservationId,
    };
    let result: WriteMemoryResult;
    try {
      result = await deps.writeMemory(input);
    } catch (err) {
      res.errored++;
      deps.log(`[promote] ERROR writing obs ${v.sourceObservationId}: ${(err as Error).message}`);
      continue; // unmarked ⇒ retried next run
    }
    if (!result.ok) {
      res.errored++;
      deps.log(`[promote] write failed for obs ${v.sourceObservationId}: ${result.reason}`);
      continue; // unmarked ⇒ retried next run
    }
    deps.markPromoted(v.sourceObservationId, atEpoch);
    res.promoted++;
    deps.log(`[promote] obs ${v.sourceObservationId} -> ${result.action} ${result.path}`);
  }
  return res;
}
