// src/worker/theme-cluster.ts — Stage 2's finder: cross-session clusters that want a THEME.
//
// Stage 1 (semantic-candidates.ts) folds same-session restatements — one event the summarizer
// described twice. Measurement turned up a second, different population that a fold would
// damage: the same standing fact re-learned across sessions weeks apart.
//
//   cos 0.970 · 9 days apart
//     A: update-status skill command verified and available
//     B: update-status skill registered and callable
//
// Those are separate learning events. Archiving one into the other hides the fact that the
// knowledge failed to stick, and the survivor's counters would claim a continuity that never
// happened. What they want is ONE durable statement with the originals preserved beneath it —
// the dreaming spec's G2, whose schema (theme_member_ids, archived_into_theme_id) has existed
// since migration v6 and was never written to.
//
// CROSS-SESSION IS THE DEFINITION, not a filter. A cluster confined to one session is stage 1's
// work; sending it to a model would spend tokens to reach the same place less safely.
//
// This module only FINDS. It never calls a model and never writes — the judge decides whether a
// cluster deserves a theme at all, and is free to return nothing.
import { cosine } from '../shared/vector-math.ts';
import { mergeBlocked } from '../shared/merge-guard.ts';

export interface ThemeRow {
  id: number;
  type: string;
  title: string;
  session_id: string;
  created_at_epoch: number;
  project_id: string;
  branch: string | null;
  from_auto: number;
  from_search: number;
  from_drill: number;
}

export interface ThemeCluster {
  /** Rows to be summarised, highest-count first. Always >= minMembers. */
  members: ThemeRow[];
  /** Distinct sessions represented. Always >= 2 — that is what makes it a theme. */
  sessionCount: number;
  /** The single (project_id, branch) every member shares. The theme is filed here. */
  project_id: string;
  branch: string | null;
}

export interface ThemeClusterDeps {
  rows: ThemeRow[];
  representativeVector: (obsId: number) => Float32Array | null;
  /** Cosine for cluster membership. Lower than the FOLD threshold on purpose: a theme is
   *  additive and reversible where a fold archives a row into another's identity, so it can
   *  afford to gather a slightly wider net. The judge is the second gate. */
  cosineThreshold: number;
  /** Minimum rows for a theme. Two is a pair, not a theme — summarising it costs a model call
   *  to restate what the higher-count row already says. */
  minMembers: number;
  maxClusters: number;
  /** Drilled or anchored ⇒ the machine never touches it, same rule as the fold path. */
  isProtected: (obsId: number) => boolean;
  /** How often these two were surfaced TOGETHER, as a Jaccard-style ratio in [0,1]
   *  (see dreaming/distance.ts coRetrievalSimilarity). This is the signal that makes a theme a
   *  theme rather than a vocabulary match: two observations the user keeps pulling up in the
   *  same breath are one topic, whatever words they happen to use. */
  coRetrieval: (a: number, b: number) => number;
  /** Minimum co-retrieval evidence to join a cluster. */
  coRetrievalThreshold?: number;
  blocked?: (titleA: string, titleB: string) => boolean;
  /**
   * Breathe. This walk runs on the ENGINE thread and its cost is INVERTED: the seed loop breaks
   * at maxClusters, so finding clusters is CHEAP and finding NOTHING is the expensive case —
   * nothing stops it walking every seed against every candidate. Measured on the live 135k corpus
   * (5,000-row window, largest partition 1,999 rows ⇒ 2,359,673 pairs): 928 ms when 5 clusters are
   * found, 10,747 ms when none are. Synchronous, that outlives the 5 s heartbeat window — /health
   * reports "engine unresponsive", /stats times out and writer RPCs 503 (observed live 2026-08-09).
   * Absent ⇒ no yielding, which is only safe for the small inputs in tests.
   */
  yieldToLoop?: () => Promise<void>;
  /** Ingest preempts housekeeping, exactly as in runQmDedupSlice. Checked at each breath. */
  shouldAbort?: () => boolean;
  /** Cluster keys the judge already refused. Skipped here rather than downstream so the
   *  maxClusters budget is spent on clusters nobody has ruled on yet — otherwise the stable
   *  ordering means the same refused head is re-judged every tick and the tail is never reached. */
  declined?: Set<string>;
  /** Sorted-member-id key for a cluster. Injected so the store owns the canonical form. */
  clusterKey?: (memberIds: number[]) => string;
}

/** Any shared surfacing at all is evidence; the ratio is naturally small because it is divided by
 *  every appearance of BOTH rows. Measured pairs on the reference corpus cluster well under 0.1. */
const DEFAULT_CO_RETRIEVAL_MIN = 0.02;

/** Seeds (and rows) walked between breaths. Mirrors runQmDedupSlice's constant so the two
 *  housekeeping walks yield at the same granularity. */
const HEARTBEAT_EVERY = 32;

const total = (r: ThemeRow): number => r.from_auto + r.from_search + r.from_drill;

/**
 * Greedy, seed-anchored clustering. Rows are walked count-desc so the most-surfaced row seeds
 * each cluster and membership is judged against it (not against a drifting centroid, which
 * would let a chain wander far from where it started). A row joins at most one cluster.
 *
 * Every exclusion is applied BEFORE the size check, so a cluster that only reaches minMembers
 * by counting protected or vectorless rows is correctly dropped rather than shipped short.
 */
export async function findThemeClusters(deps: ThemeClusterDeps): Promise<ThemeCluster[]> {
  const isBlocked = deps.blocked ?? mergeBlocked;
  const eligible = deps.rows.filter(r => !deps.isProtected(r.id));

  // PARTITION BY (project_id, branch) first — the same scoping mergeDuplicateGroup enforces and
  // groupSurfacedRows applies for folds. Without it, three unrelated projects that phrase a bug
  // the same way ("Fix the login redirect loop") cluster on cosine alone, get archived together,
  // and the surviving theme is filed under whichever project_id the worker happens to run as.
  // Measured on the live corpus before this fix: ALL 5 clusters the next pass would have judged
  // crossed a scope boundary, 4 of 5 crossed project_id itself.
  const partitions = new Map<string, ThemeRow[]>();
  for (const r of eligible) {
    const k = JSON.stringify([r.project_id, r.branch]);
    const b = partitions.get(k);
    if (b) b.push(r); else partitions.set(k, [r]);
  }

  const out: ThemeCluster[] = [];
  for (const bucket of partitions.values()) {
    if (out.length >= deps.maxClusters) break;
    if (deps.shouldAbort?.()) return out.slice(0, deps.maxClusters);
    out.push(...await clusterOnePartition(bucket, deps, isBlocked, deps.maxClusters - out.length));
  }
  return out.slice(0, deps.maxClusters);
}

/** Cluster within ONE (project_id, branch) partition. Every member shares the scope by construction. */
async function clusterOnePartition(
  rows0: ThemeRow[],
  deps: ThemeClusterDeps,
  isBlocked: (a: string, b: string) => boolean,
  budget: number,
): Promise<ThemeCluster[]> {
  const sorted = [...rows0].sort((a, b) => total(b) - total(a) || a.id - b.id);
  const coRetMin = deps.coRetrievalThreshold ?? DEFAULT_CO_RETRIEVAL_MIN;

  // Vector resolution is itself O(n) DB round-trips — measured 0.58 ms/row, so 2.9 s for a
  // 5,000-row window before a single pair is compared. Breathe here too, not just in the pairs.
  const vecs = new Map<number, Float32Array>();
  let resolved = 0;
  for (const r of sorted) {
    if (resolved > 0 && resolved % HEARTBEAT_EVERY === 0) {
      await deps.yieldToLoop?.();
      if (deps.shouldAbort?.()) return [];
    }
    resolved++;
    const v = deps.representativeVector(r.id);
    if (v) vecs.set(r.id, v);
  }

  const out: ThemeCluster[] = [];
  const claimed = new Set<number>();
  let seedsWalked = 0;
  for (const seed of sorted) {
    if (out.length >= budget) break;
    // One breath per HEARTBEAT_EVERY seeds. Each seed costs an O(n) inner walk, so the gap
    // between breaths stays bounded by (HEARTBEAT_EVERY x partition size), not by the quadratic.
    if (seedsWalked > 0 && seedsWalked % HEARTBEAT_EVERY === 0) {
      await deps.yieldToLoop?.();
      if (deps.shouldAbort?.()) return out;
    }
    seedsWalked++;
    if (claimed.has(seed.id)) continue;
    const sv = vecs.get(seed.id);
    if (!sv) continue;                                   // fail-closed

    const members: ThemeRow[] = [seed];
    for (const cand of sorted) {
      if (cand.id === seed.id || claimed.has(cand.id)) continue;
      const cv = vecs.get(cand.id);
      if (!cv) continue;                                 // fail-closed
      // BOTH signals required. Cosine says these READ alike; co-retrieval says you have actually
      // used them as one thing. Similarity alone groups every observation that shares a
      // vocabulary — which on a real corpus is most of a project — and that is the failure the
      // whole design exists to avoid.
      //
      // CO-RETRIEVAL IS CHECKED FIRST, and the order is load-bearing for cost, not for meaning:
      // the two are a pure AND, so the verdict is identical either way. Co-retrieval is one map
      // lookup; cosine is 1024 multiply-adds (~4.5 us measured). Co-retrieval is also far the
      // more selective of the two — on the live corpus its evidence covers 427k pairs out of the
      // 2.36M a 5,000-row window compares, so cheap-and-selective first skips the expensive test
      // for the overwhelming majority. This is precisely the finds-nothing case that measured
      // 10,747 ms with cosine leading.
      if (deps.coRetrieval(seed.id, cand.id) < coRetMin) continue;
      if (cosine(sv, cv) < deps.cosineThreshold) continue;
      if (isBlocked(seed.title, cand.title)) continue;
      members.push(cand);
    }

    if (members.length < deps.minMembers) continue;
    const sessions = new Set(members.map(m => m.session_id));
    if (sessions.size < 2) continue;                     // same-session ⇒ stage 1's job

    // Already refused? Claim the rows so they cannot re-form a near-identical cluster this pass,
    // but do NOT emit it — the budget belongs to clusters nobody has ruled on.
    if (deps.declined && deps.clusterKey) {
      const key = deps.clusterKey(members.map(m => m.id));
      if (deps.declined.has(key)) {
        for (const m of members) claimed.add(m.id);
        continue;
      }
    }

    for (const m of members) claimed.add(m.id);
    out.push({
      members, sessionCount: sessions.size,
      project_id: seed.project_id, branch: seed.branch,   // shared by construction
    });
  }
  return out;
}
