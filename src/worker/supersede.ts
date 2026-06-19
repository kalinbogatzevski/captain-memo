// src/worker/supersede.ts — the pure, heartbeat-safe supersede-detection slice (P3) and
// the pure search-time demotion. Modelled on quartermaster.ts: orchestration over INJECTED
// deps, so it unit-tests with no worker/DB/timer. Each candidate (an older→newest version
// pair, already (project,branch)+entityKey scoped by supersedeCandidateWindow) is linked
// only when its embedding cosine clears the dedup threshold, FAIL-CLOSED on a missing
// vector, and NEVER for a protected (drilled/anchored) older row. OFF unless the master
// switch AND supersedeEnabled are on.
import { cosine } from '../shared/vector-math.ts';
import type { QmConfig } from './qm.ts';
import type { SupersedeCandidate } from './observations-store.ts';

/** Candidates processed between heartbeat yields + abort re-checks. */
const HEARTBEAT_EVERY = 32;

export interface QmSupersedeDeps {
  candidates: () => SupersedeCandidate[];
  representativeVector: (obsId: number) => Float32Array | null;
  isProtected: (obsId: number) => boolean;
  linkSupersede: (
    olderId: number,
    newerId: number,
    meta: { entityKey: string; olderVersion: string; newerVersion: string; atEpoch: number },
  ) => void;
  shouldAbort: () => boolean;
  cfg: QmConfig;
  now: () => number;
  yieldToLoop: () => Promise<void>;
}

export interface QmSupersedeResult {
  scanned: number;
  linked: number;
  skippedNoVector: number;
  aborted: boolean;
}

export async function runQmSupersedeSlice(deps: QmSupersedeDeps): Promise<QmSupersedeResult> {
  const res: QmSupersedeResult = { scanned: 0, linked: 0, skippedNoVector: 0, aborted: false };
  if (!deps.cfg.enabled || !deps.cfg.supersedeEnabled) return res; // off by default
  const atEpoch = deps.now();
  let seen = 0;
  for (const cand of deps.candidates()) {
    if (seen > 0 && seen % HEARTBEAT_EVERY === 0) {
      await deps.yieldToLoop();
      if (deps.shouldAbort()) { res.aborted = true; return res; }
    }
    seen++;
    res.scanned++;
    if (deps.isProtected(cand.older.id)) continue;          // never supersede a drilled/anchored row
    const oVec = deps.representativeVector(cand.older.id);
    const nVec = deps.representativeVector(cand.newer.id);
    if (!oVec || !nVec) { res.skippedNoVector++; continue; } // fail-closed
    if (cosine(oVec, nVec) < deps.cfg.dedupCosineThreshold) continue; // confirm same subject
    deps.linkSupersede(cand.older.id, cand.newer.id, {
      entityKey: cand.entityKey,
      olderVersion: cand.older.version,
      newerVersion: cand.newer.version,
      atEpoch,
    });
    res.linked++;
  }
  return res;
}

/**
 * Search-time demotion (P3): multiply the score of any hit whose backing observation is
 * superseded by `penalty` (< 1) and re-sort by score desc. NEVER drops a hit. Returns the
 * original array unchanged when penalty ≥ 1, no ids are superseded, or the list is empty.
 */
export function applySupersedeDemotion<T extends { score: number; metadata: Record<string, unknown> }>(
  items: T[],
  supersededIds: Set<number>,
  penalty: number,
): T[] {
  if (penalty >= 1 || supersededIds.size === 0 || items.length === 0) return items;
  let changed = false;
  const out = items.map((item) => {
    const oid = item.metadata?.observation_id;
    if (typeof oid === 'number' && supersededIds.has(oid)) {
      changed = true;
      return { ...item, score: item.score * penalty };
    }
    return item;
  });
  return changed ? out.sort((a, b) => b.score - a.score) : items;
}
