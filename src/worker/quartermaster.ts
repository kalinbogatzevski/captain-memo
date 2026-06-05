// src/worker/quartermaster.ts — the pure, heartbeat-safe auto-dedup slice (Quartermaster).
// Modelled on tide-sweep.ts: pure orchestration over INJECTED deps, so it unit-tests with
// no worker, DB, or real timer. It folds near-identical observations the candidate window
// already scoped (project/branch + negation/identifier guard), gating each fold behind a
// cosine ≥ threshold confirm, FAIL-CLOSED when a vector is missing, and NEVER auto-folding
// a protected (drilled/anchored) row — those are skipped outright, never archived by the
// machine. The slice yields to the event loop after every group AND every K members within
// a group, re-checking the abort signal, so a single huge group can't overrun the writer's
// heartbeat and an ingest arriving mid-slice always preempts it.
import { cosine } from '../shared/vector-math.ts';
import type { QmConfig } from './qm.ts';
import type { DuplicateGroup } from './observations-store.ts';

/** Members processed between intra-group heartbeat yields + abort re-checks. */
const HEARTBEAT_EVERY = 32;

export interface QmDedupDeps {
  /** Bounded window of candidate groups from dedupCandidateWindow (already
   *  (project,branch)-scoped + negation/identifier guarded). */
  candidates: () => DuplicateGroup[];
  /** Representative (centroid) vector of an observation's chunk vectors, or null
   *  when none exists yet — the fail-closed signal. */
  representativeVector: (obsId: number) => Float32Array | null;
  /** True when the row is drilled (from_drill>0) or anchored (is_anchored=1). */
  memberIsProtected: (obsId: number) => boolean;
  /** Persist one fold (writer-only): add members' counts onto the survivor, archive
   *  members. Returns the count of members it ACTUALLY archived (after its own
   *  cross-scope eligibility filter) — the honest tally for res.merges. */
  mergeGroup: (survivorId: number, memberIds: number[], atEpoch: number) => number;
  /** True when ingest/embedding work is queued or running — the slice yields to it. */
  shouldAbort: () => boolean;
  cfg: QmConfig;
  /** Current wall-clock, epoch seconds. Injected for deterministic tests. */
  now: () => number;
  /** Hand control back to the event loop (so the heartbeat fires). Injected for tests. */
  yieldToLoop: () => Promise<void>;
}

export interface QmDedupResult {
  scanned: number;         // candidate groups examined
  merges: number;          // folded MEMBERS (not groups), as actually archived
  skippedNoVector: number; // groups skipped (no survivor vector) + members skipped (no member vector)
  aborted: boolean;        // bailed early to let ingest run
}

/**
 * Run one bounded auto-dedup slice. Walks the candidate groups; for each, confirms the
 * survivor has a representative vector (else skips the whole group — can't confirm —
 * counting it as skippedNoVector), then folds only the members whose cosine to the
 * survivor clears `cfg.dedupCosineThreshold`, skipping any member that lacks a vector
 * (fail-closed, skippedNoVector++) and any PROTECTED member (drilled/anchored) outright —
 * a protected memory is never archived automatically. `res.merges` is the honest count the
 * writer actually archived (mergeGroup's return), not the count we proposed. Yields after
 * every group AND every HEARTBEAT_EVERY members, re-checking `shouldAbort()` so an ingest
 * arriving mid-slice — even mid huge-group — preempts it. Off unless BOTH the master switch
 * and dedup are enabled.
 */
export async function runQmDedupSlice(deps: QmDedupDeps): Promise<QmDedupResult> {
  const res: QmDedupResult = { scanned: 0, merges: 0, skippedNoVector: 0, aborted: false };
  if (!deps.cfg.enabled || !deps.cfg.dedupEnabled) return res; // off by default
  const atEpoch = deps.now();
  for (const group of deps.candidates()) {
    if (deps.shouldAbort()) { res.aborted = true; return res; } // ingest/heartbeat preempt
    res.scanned++;
    const survVec = deps.representativeVector(group.survivor.id);
    if (!survVec) { res.skippedNoVector++; await deps.yieldToLoop(); continue; } // no survivor vector ⇒ skip
    const foldable: number[] = [];
    let seen = 0;
    for (const m of group.members) {
      // Intra-group heartbeat: a huge group does N centroid reads; yield + re-check
      // abort every HEARTBEAT_EVERY members so it can't starve the heartbeat, and bail
      // without folding the partial group when ingest arrives mid-walk.
      if (seen > 0 && seen % HEARTBEAT_EVERY === 0) {
        await deps.yieldToLoop();
        if (deps.shouldAbort()) { res.aborted = true; return res; }
      }
      seen++;
      if (deps.memberIsProtected(m.id)) continue;                // never auto-fold a drilled/pinned memory
      const mVec = deps.representativeVector(m.id);
      if (!mVec) { res.skippedNoVector++; continue; }            // fail-closed: no member vector ⇒ don't fold it
      if (cosine(survVec, mVec) < deps.cfg.dedupCosineThreshold) continue;
      foldable.push(m.id);
    }
    if (foldable.length > 0) {
      res.merges += deps.mergeGroup(group.survivor.id, foldable, atEpoch); // honest: what was archived
    }
    await deps.yieldToLoop();                                    // heartbeat breathes; abort re-checked next group
  }
  return res;
}
