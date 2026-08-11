// src/worker/dedup-candidates.ts — dedup candidates from the IVF CLUSTERS the vector index
// already assigned at insert time, rather than the (project_id, branch) cross-product.
//
// A fold needs both halves of an AND: near-duplicate titles (Jaccard) and agreeing vectors
// (cosine >= 0.95). dedupCandidateWindow finds the TITLE pairs first, across the whole partition
// cross-product, and leaves the cosine confirm to reject what does not hold up. Measured on the
// live 135k corpus with the surfaced gate dropped:
//
//     route                              pairs          time     groups   rows folded
//     (project, branch) cross-product    1,456,906,881   452 s      553         1,128
//     one KNN query per row              130,545 queries ~3.9 h       -             -
//     WITHIN IVF CLUSTER                 83,980,390     28.5 s      882         1,846
//
// The clusters are free: every embedding is assigned to one on INSERT (469 clusters over 155,223
// vectors here), so "which rows might be near this one" is already answered and stored. Per-row
// KNN was measured and REJECTED — 107 ms a query is slower than the cross-product it replaces and
// a single query outran the heartbeat.
//
// It also finds MORE than the exhaustive title route, which is not a contradiction: cosine runs
// inside the loop here, so a pair the title-greedy grouping had claimed into some other group is
// still reachable.
//
// ponytail: approximate by construction. Two duplicates that landed in different clusters are
// missed — the honest trade for a walk that stays affordable as the corpus grows, and measurably
// cheaper than the exhaustive route in both time and missed folds. Cluster iteration is also
// naturally resumable: a caller may hand over a subset of clusters per pass.
import { jaccard, significantTokens } from '../shared/title-similarity.ts';
import { cosine } from '../shared/vector-math.ts';
import { mergeBlocked } from '../shared/merge-guard.ts';
import type { ObservationType } from '../shared/types.ts';
import type { DuplicateGroup, DuplicateEntry } from './observations-store.ts';

/** A live observation eligible for folding. */
export interface DedupRow {
  id: number;
  type: string;
  title: string;
  project_id: string;
  branch: string | null;
  from_auto: number;
  from_search: number;
  from_drill: number;
}

export interface DedupClusterDeps {
  rows: DedupRow[];
  /** Observation ids per IVF cluster. Ids absent from `rows` are ignored, so the caller may pass
   *  the raw membership without pre-filtering. Hand over a subset to work the corpus in steps. */
  clusters: Iterable<number[]>;
  /** Centroid of an observation's chunk vectors, or null when it has none yet. */
  representativeVector: (obsId: number) => Float32Array | null;
  /** Cosine at or above which two rows are the same thing. Mirrors the slice's own confirm. */
  cosineThreshold: number;
  /** Title Jaccard at or above which two rows read alike. */
  titleThreshold: number;
  maxGroups: number;
  /** Title-pair veto. Defaults to the shared merge guard; injectable for tests. */
  blocked?: (titleA: string, titleB: string) => boolean;
  /** Breathe: this runs on the engine thread. */
  yieldToLoop?: () => Promise<void>;
  /** Ingest preempts housekeeping, as everywhere else. Checked at each breath. */
  shouldAbort?: () => boolean;
}

/** Rows walked between breaths. Same constant as the sibling finders. */
const HEARTBEAT_EVERY = 32;

const total = (r: DedupRow): number => r.from_auto + r.from_search + r.from_drill;
const toEntry = (r: DedupRow): DuplicateEntry => ({
  id: r.id, type: r.type as ObservationType, title: r.title, total: total(r),
});

/**
 * Group near-duplicate observations, one IVF cluster at a time.
 *
 * Greedy and rep-anchored, matching the other finders' survivor invariant: within a cluster rows
 * are walked count-desc (ties by id asc) so the highest-count row leads its group and the rest
 * fold INTO it. A row joins at most one group, across all clusters.
 *
 * Every guard the cross-product route applies still applies, cheapest first: same
 * (project_id, branch) scope, the title threshold, the merge guard, then the cosine confirm.
 * Fail-closed on a missing vector — a row with no embedding is never folded on titles alone.
 */
export async function findDedupGroupsByCluster(deps: DedupClusterDeps): Promise<DuplicateGroup[]> {
  const isBlocked = deps.blocked ?? mergeBlocked;
  const byId = new Map<number, DedupRow>();
  for (const r of deps.rows) byId.set(r.id, r);

  // Tokenise once per row, not once per comparison: a row in a dense cluster would otherwise be
  // re-tokenised for every neighbour it is measured against.
  const tokens = new Map<number, Set<string>>();
  const tokensOf = (r: DedupRow): Set<string> => {
    let t = tokens.get(r.id);
    if (!t) { t = significantTokens(r.title); tokens.set(r.id, t); }
    return t;
  };
  // Vectors are resolved LAZILY and only once the title gate has already passed — measured, 23,069
  // cosine calls against 62,298,009 scope checks, so eager resolution would be almost entirely waste.
  const vecs = new Map<number, Float32Array | null>();
  const vecOf = (id: number): Float32Array | null => {
    const hit = vecs.get(id);
    if (hit !== undefined) return hit;
    const v = deps.representativeVector(id) ?? null;
    vecs.set(id, v);
    return v;
  };

  const out: DuplicateGroup[] = [];
  const claimed = new Set<number>();
  let walked = 0;
  for (const cluster of deps.clusters) {
    if (out.length >= deps.maxGroups) break;
    const members = cluster
      .map(id => byId.get(id))
      .filter((r): r is DedupRow => r !== undefined);
    if (members.length < 2) continue;
    members.sort((a, b) => total(b) - total(a) || a.id - b.id);

    for (let i = 0; i < members.length; i++) {
      if (out.length >= deps.maxGroups) break;
      if (walked > 0 && walked % HEARTBEAT_EVERY === 0) {
        await deps.yieldToLoop?.();
        if (deps.shouldAbort?.()) return out;
      }
      walked++;
      const survivor = members[i]!;
      if (claimed.has(survivor.id)) continue;

      const folded: DedupRow[] = [];
      let sv: Float32Array | null | undefined;      // resolved on the first title match only
      for (let j = i + 1; j < members.length; j++) {
        const cand = members[j]!;
        if (claimed.has(cand.id)) continue;
        // Scope first: cheapest, and the one whose violation corrupts the survivor's counters.
        if (cand.project_id !== survivor.project_id || cand.branch !== survivor.branch) continue;
        if (jaccard(tokensOf(survivor), tokensOf(cand)) < deps.titleThreshold) continue;
        if (isBlocked(survivor.title, cand.title)) continue;
        if (sv === undefined) sv = vecOf(survivor.id);
        if (!sv) break;                             // fail-closed: no survivor vector, no group
        const cv = vecOf(cand.id);
        if (!cv) continue;                          // fail-closed
        if (cosine(sv, cv) < deps.cosineThreshold) continue;
        folded.push(cand);
      }
      if (folded.length === 0) continue;
      claimed.add(survivor.id);
      for (const m of folded) claimed.add(m.id);
      out.push({ survivor: toEntry(survivor), members: folded.map(toEntry) });
    }
  }
  return out.slice(0, deps.maxGroups);
}
