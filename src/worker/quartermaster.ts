// src/worker/quartermaster.ts — the pure, heartbeat-safe auto-dedup slice (Quartermaster).
// Modelled on tide-sweep.ts: pure orchestration over INJECTED deps, so it unit-tests with
// no worker, DB, or real timer. It folds near-identical observations the candidate window
// already scoped (project/branch + negation/identifier guard), gating each fold behind a
// cosine ≥ threshold confirm, FAIL-CLOSED when a vector is missing, and protecting
// drilled/anchored rows by making the survivor sticky-anchored. The slice yields to the
// event loop after every group and re-checks the abort signal BEFORE each group, so an
// ingest arriving mid-slice preempts it and the writer's heartbeat is never starved.
import { cosine } from '../shared/vector-math.ts';
import type { QmConfig } from './qm.ts';
import type { DuplicateGroup } from './observations-store.ts';

export interface QmDedupDeps {
  /** Bounded window of candidate groups from dedupCandidateWindow (already
   *  (project,branch)-scoped + negation/identifier guarded). */
  candidates: () => DuplicateGroup[];
  /** Representative (centroid) vector of an observation's chunk vectors, or null
   *  when none exists yet — the fail-closed signal. */
  representativeVector: (obsId: number) => Float32Array | null;
  /** True when the row is drilled (from_drill>0) or anchored (is_anchored=1). */
  memberIsProtected: (obsId: number) => boolean;
  /** Persist one fold (writer-only): add members' counts onto the survivor, archive members. */
  mergeGroup: (survivorId: number, memberIds: number[], atEpoch: number) => void;
  /** Pin the survivor so it (and the protection it inherited) never ebbs or folds. */
  markAnchored: (survivorId: number) => void;
  /** True when ingest/embedding work is queued or running — the slice yields to it. */
  shouldAbort: () => boolean;
  cfg: QmConfig;
  /** Current wall-clock, epoch seconds. Injected for deterministic tests. */
  now: () => number;
  /** Hand control back to the event loop (so the heartbeat fires). Injected for tests. */
  yieldToLoop: () => Promise<void>;
}

export interface QmDedupResult {
  scanned: number;  // candidate groups examined
  merges: number;   // folded MEMBERS (not groups)
  aborted: boolean; // bailed early to let ingest run
}

/**
 * Run one bounded auto-dedup slice. Walks the candidate groups; for each, confirms the
 * survivor has a representative vector (else skips the whole group — can't confirm), then
 * folds only the members whose cosine to the survivor clears `cfg.dedupCosineThreshold`,
 * skipping any member that lacks a vector (fail-closed). If any folded member was
 * protected (drilled/anchored), the survivor is anchored so the protection is sticky.
 * Yields after every group and re-checks `shouldAbort()` before the next, so an ingest
 * arriving mid-slice preempts it. Off unless BOTH the master switch and dedup are enabled.
 */
export async function runQmDedupSlice(deps: QmDedupDeps): Promise<QmDedupResult> {
  const res: QmDedupResult = { scanned: 0, merges: 0, aborted: false };
  if (!deps.cfg.enabled || !deps.cfg.dedupEnabled) return res; // off by default
  const atEpoch = deps.now();
  for (const group of deps.candidates()) {
    if (deps.shouldAbort()) { res.aborted = true; return res; } // ingest/heartbeat preempt
    res.scanned++;
    const survVec = deps.representativeVector(group.survivor.id);
    if (!survVec) { await deps.yieldToLoop(); continue; }       // no survivor vector ⇒ can't confirm ⇒ skip
    const foldable: number[] = [];
    let anyProtected = false;
    for (const m of group.members) {
      const mVec = deps.representativeVector(m.id);
      if (!mVec) continue;                                       // fail-closed: no member vector ⇒ don't fold it
      if (cosine(survVec, mVec) < deps.cfg.dedupCosineThreshold) continue;
      foldable.push(m.id);
      if (deps.memberIsProtected(m.id)) anyProtected = true;
    }
    if (foldable.length > 0) {
      deps.mergeGroup(group.survivor.id, foldable, atEpoch);
      if (anyProtected) deps.markAnchored(group.survivor.id);   // sticky drill-protection on the survivor
      res.merges += foldable.length;
    }
    await deps.yieldToLoop();                                    // heartbeat breathes; abort re-checked next group
  }
  return res;
}
