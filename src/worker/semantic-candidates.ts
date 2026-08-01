// src/worker/semantic-candidates.ts — the finder the dedup pipeline never had.
//
// Today's dedup gates candidacy on title similarity (Jaccard >= 0.5) and only THEN confirms with
// cosine. Measured on the live 124k corpus, that ordering makes the cosine confirm dead code:
// ZERO semantically-similar pairs reach it at any threshold from 0.90 to 0.97, because nothing
// survives the title gate to be confirmed. Two observations stating one fact in different words
// were structurally unreachable. See docs/specs/2026-08-01-semantic-consolidation-findings.md.
//
// This module inverts the order for a narrow, safe slice of the problem: cosine FINDS, and every
// existing guard still runs downstream. It emits DuplicateGroup — the exact shape
// runQmDedupSlice already consumes — so the proven slice (cosine re-confirm, protected-row skip,
// cross-scope eligibility, archive-not-delete, abort-on-ingest) is reused unchanged.
//
// WHY SAME-SESSION ONLY. At cos >= 0.95, 88 pairs survive the merge guard corpus-wide and 83% of
// them are same-session — one event the summarizer described twice, which is near-definitionally
// a duplicate. The rest are not:
//   - Cross-session pairs weeks apart ("update-status skill verified" vs "…registered and
//     callable", 9 days) are the same standing fact RE-LEARNED. Folding hides that it failed to
//     stick; those want a theme (stage 2), not a fold.
//   - The middle bands hold build progressions ("Add private notes with strict area visibility"
//     → "…category-aware rules" → "Add is_private flag", cos 0.971-0.979) which are three stages
//     of one feature. No cosine threshold and no elapsed-time rule separates those from
//     restatements, so the machine stays out.
// A shared session_id is the one signal that says "same moment, same work" without inference.
import { cosine } from '../shared/vector-math.ts';
import { mergeBlocked } from '../shared/merge-guard.ts';
import type { ObservationType } from '../shared/types.ts';
import type { DuplicateGroup, DuplicateEntry } from './observations-store.ts';

/** A live, surfaced observation eligible for semantic grouping. */
export interface SemanticRow {
  id: number;
  type: string;
  title: string;
  session_id: string;
  project_id: string;
  branch: string | null;
  from_auto: number;
  from_search: number;
  from_drill: number;
}

export interface SemanticGroupDeps {
  /** Candidate rows. Sessions with fewer than two rows contribute nothing. */
  rows: SemanticRow[];
  /** Centroid of an observation's chunk vectors, or null when it has none yet. */
  representativeVector: (obsId: number) => Float32Array | null;
  /** Cosine at or above which two same-session rows are one event. */
  cosineThreshold: number;
  /** Cap on emitted groups — bounds the downstream slice's work. */
  maxGroups: number;
  /** Title-pair veto. Defaults to the shared merge guard; injectable for tests. */
  blocked?: (titleA: string, titleB: string) => boolean;
}

const total = (r: SemanticRow): number => r.from_auto + r.from_search + r.from_drill;
const toEntry = (r: SemanticRow): DuplicateEntry => ({
  id: r.id, type: r.type as ObservationType, title: r.title, total: total(r),
});

/**
 * Group same-session observations whose vectors agree at or above the threshold.
 *
 * Greedy and rep-anchored, matching groupSurfacedRows' survivor invariant: rows are walked
 * count-desc (ties by id asc) so the highest-count row always leads its group and the members
 * fold INTO it. A row joins at most one group.
 *
 * Fail-closed on a missing vector: the row is skipped entirely rather than grouped on title
 * evidence alone. The downstream confirm would also refuse it, but emitting it here would
 * inflate the candidate count and mask that embedding is lagging.
 */
export function findSemanticGroups(deps: SemanticGroupDeps): DuplicateGroup[] {
  const isBlocked = deps.blocked ?? mergeBlocked;
  // Keyed by (session, project, branch) — a session is NOT a scope. One real session spanned 27
  // (project, branch) pairs across 1,564 rows, because switching repos mid-session is ordinary.
  // Grouping on session alone emitted cross-scope groups that mergeDuplicateGroup then refused
  // member by member, so the pass reported "10 scanned, 0 folded" indefinitely and silently.
  const bySession = new Map<string, SemanticRow[]>();
  for (const r of deps.rows) {
    const k = JSON.stringify([r.session_id, r.project_id, r.branch]);
    const b = bySession.get(k);
    if (b) b.push(r); else bySession.set(k, [r]);
  }

  const out: DuplicateGroup[] = [];
  for (const bucket of bySession.values()) {
    if (bucket.length < 2 || out.length >= deps.maxGroups) continue;
    // Survivor invariant: highest total leads, ties by lowest id (matches findDuplicateGroups).
    const rows = [...bucket].sort((a, b) => total(b) - total(a) || a.id - b.id);

    // Resolve vectors once per row — the pair loop is O(n²) in the session, which is small.
    const vecs = new Map<number, Float32Array>();
    for (const r of rows) {
      const v = deps.representativeVector(r.id);
      if (v) vecs.set(r.id, v);
    }

    const claimed = new Set<number>();
    for (const survivor of rows) {
      if (out.length >= deps.maxGroups) break;
      if (claimed.has(survivor.id)) continue;
      const sv = vecs.get(survivor.id);
      if (!sv) continue;                                    // fail-closed
      const members: SemanticRow[] = [];
      for (const cand of rows) {
        if (cand.id === survivor.id || claimed.has(cand.id)) continue;
        const cv = vecs.get(cand.id);
        if (!cv) continue;                                  // fail-closed
        if (cosine(sv, cv) < deps.cosineThreshold) continue;
        if (isBlocked(survivor.title, cand.title)) continue;
        members.push(cand);
      }
      if (members.length === 0) continue;
      claimed.add(survivor.id);
      for (const m of members) claimed.add(m.id);
      out.push({ survivor: toEntry(survivor), members: members.map(toEntry) });
    }
  }
  return out.slice(0, deps.maxGroups);
}
