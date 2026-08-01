import { test, expect, describe } from 'bun:test';
import { findSemanticGroups, type SemanticRow } from '../../../src/worker/semantic-candidates.ts';

// Measured on the live 124k corpus (docs/specs/2026-08-01-semantic-consolidation-findings.md):
// title-Jaccard gating makes cosine a CONFIRM that never fires — zero semantically-similar pairs
// reach it at any threshold. This finder is the missing half: cosine as the FINDER.
//
// Restricted to SAME-SESSION pairs on purpose. At cos >= 0.95, 83% of surviving pairs are
// same-session (one event the summarizer described twice). Cross-session pairs at the same cosine
// are the same standing fact RE-learned weeks apart — separate events that want a theme, not a
// fold — and the middle bands hold build progressions that no threshold separates safely.

const v = (...xs: number[]) => Float32Array.from(xs);
const row = (id: number, title: string, session: string, total = 1,
             project = 'p', branch: string | null = null): SemanticRow => ({
  id, type: 'discovery', title, session_id: session, project_id: project, branch,
  from_auto: total, from_search: 0, from_drill: 0,
});

/** Unit vectors at a known angle: cos(theta) apart in the first two dimensions. */
const at = (deg: number) => v(Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0);

describe('findSemanticGroups', () => {
  const vecs = (m: Record<number, Float32Array>) => (id: number) => m[id] ?? null;

  test('groups two same-session rows whose vectors clear the threshold', () => {
    const rows = [row(1, 'TalQ: native Qt client', 's1', 5), row(2, 'Retrieved TalQ discovery', 's1', 2)];
    const groups = findSemanticGroups({
      rows, representativeVector: vecs({ 1: at(0), 2: at(5) }), // cos ~0.996
      cosineThreshold: 0.95, maxGroups: 10,
    });
    expect(groups.length).toBe(1);
    expect(groups[0]!.survivor.id).toBe(1);        // highest count survives
    expect(groups[0]!.members.map(m => m.id)).toEqual([2]);
  });

  test('does NOT group rows from different sessions, however close', () => {
    const rows = [row(1, 'update-status skill verified', 's1'), row(2, 'update-status skill callable', 's2')];
    expect(findSemanticGroups({
      rows, representativeVector: vecs({ 1: at(0), 2: at(1) }), // cos ~0.9998
      cosineThreshold: 0.95, maxGroups: 10,
    })).toEqual([]);
  });

  test('does not group below the threshold', () => {
    const rows = [row(1, 'alpha thing', 's1'), row(2, 'beta thing', 's1')];
    expect(findSemanticGroups({
      rows, representativeVector: vecs({ 1: at(0), 2: at(40) }), // cos ~0.766
      cosineThreshold: 0.95, maxGroups: 10,
    })).toEqual([]);
  });

  // Fail-closed: the confirm downstream also refuses a vectorless row, but a finder that emits
  // one would inflate the candidate count and hide that embedding is behind.
  test('skips a row with no vector rather than guessing', () => {
    const rows = [row(1, 'has vector', 's1'), row(2, 'no vector yet', 's1')];
    expect(findSemanticGroups({
      rows, representativeVector: vecs({ 1: at(0) }),
      cosineThreshold: 0.95, maxGroups: 10,
    })).toEqual([]);
  });

  test('honours the merge guard — a blocked pair never groups', () => {
    const rows = [row(1, 'Bump version to 1.2.3', 's1'), row(2, 'Bump version to 4.5.6', 's1')];
    expect(findSemanticGroups({
      rows, representativeVector: vecs({ 1: at(0), 2: at(2) }),
      cosineThreshold: 0.95, maxGroups: 10,
    })).toEqual([]);   // real mergeBlocked: differing version sets
  });

  test('highest-count row survives regardless of input order', () => {
    const rows = [row(1, 'quiet phrasing', 's1', 1), row(2, 'loud phrasing', 's1', 99)];
    const g = findSemanticGroups({
      rows, representativeVector: vecs({ 1: at(0), 2: at(3) }),
      cosineThreshold: 0.95, maxGroups: 10,
    });
    expect(g[0]!.survivor.id).toBe(2);
    expect(g[0]!.members.map(m => m.id)).toEqual([1]);
  });

  test('a row already claimed by a group is not re-emitted in another', () => {
    const rows = [row(1, 'a', 's1', 9), row(2, 'b', 's1', 5), row(3, 'c', 's1', 1)];
    const g = findSemanticGroups({
      rows, representativeVector: vecs({ 1: at(0), 2: at(2), 3: at(4) }),
      cosineThreshold: 0.95, maxGroups: 10,
    });
    const emitted = g.flatMap(x => [x.survivor.id, ...x.members.map(m => m.id)]);
    expect(new Set(emitted).size).toBe(emitted.length);
  });

  test('maxGroups caps the emitted work', () => {
    const rows = [
      row(1, 'a1', 's1', 2), row(2, 'a2', 's1', 1),
      row(3, 'b1', 's2', 2), row(4, 'b2', 's2', 1),
      row(5, 'c1', 's3', 2), row(6, 'c2', 's3', 1),
    ];
    const vm = { 1: at(0), 2: at(2), 3: at(0), 4: at(2), 5: at(0), 6: at(2) };
    expect(findSemanticGroups({ rows, representativeVector: vecs(vm), cosineThreshold: 0.95, maxGroups: 10 }).length).toBe(3);
    expect(findSemanticGroups({ rows, representativeVector: vecs(vm), cosineThreshold: 0.95, maxGroups: 2 }).length).toBe(2);
  });

  // FOUND IN PRODUCTION: the pass ran for hours reporting "10 scanned, 0 folded". A session is
  // NOT a scope — one real session spanned 27 (project, branch) pairs across 1,564 rows, because
  // switching repos mid-session is normal. The finder emitted cross-scope groups, mergeDuplicateGroup
  // correctly refused every member, and the honest merge count was zero. Forever, silently.
  describe('scope', () => {
    test('never groups across project_id, even within one session', () => {
      const rows = [
        row(1, 'identical phrasing', 's1', 3, 'captain-memo'),
        row(2, 'identical phrasing', 's1', 1, 'erp-platform'),
      ];
      expect(findSemanticGroups({
        rows, representativeVector: vecs({ 1: at(0), 2: at(1) }),
        cosineThreshold: 0.95, maxGroups: 10,
      })).toEqual([]);
    });

    test('never groups across branch within one project', () => {
      const rows = [
        row(1, 'identical phrasing', 's1', 3, 'p', 'master'),
        row(2, 'identical phrasing', 's1', 1, 'p', 'feature/x'),
      ];
      expect(findSemanticGroups({
        rows, representativeVector: vecs({ 1: at(0), 2: at(1) }),
        cosineThreshold: 0.95, maxGroups: 10,
      })).toEqual([]);
    });

    test('still groups when session AND scope both match', () => {
      const rows = [
        row(1, 'a', 's1', 3, 'captain-memo', 'master'),
        row(2, 'b', 's1', 1, 'captain-memo', 'master'),
      ];
      const g = findSemanticGroups({
        rows, representativeVector: vecs({ 1: at(0), 2: at(2) }),
        cosineThreshold: 0.95, maxGroups: 10,
      });
      expect(g.length).toBe(1);
      expect(g[0]!.members.map(m => m.id)).toEqual([2]);
    });
  });

  test('a session with one row produces nothing', () => {
    expect(findSemanticGroups({
      rows: [row(1, 'solo', 's1')], representativeVector: vecs({ 1: at(0) }),
      cosineThreshold: 0.95, maxGroups: 10,
    })).toEqual([]);
  });
});
