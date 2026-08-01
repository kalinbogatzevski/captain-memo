import { test, expect, describe } from 'bun:test';
import { findThemeClusters, type ThemeRow } from '../../../src/worker/theme-cluster.ts';

// Stage 2. Stage 1 folds same-session restatements; this finds the OTHER population the
// measurement turned up: the same standing fact re-learned across sessions weeks apart
// ("update-status skill verified" / "…registered and callable", 9 days). Folding those is
// wrong — they are separate learning events, and collapsing them hides that the knowledge
// failed to stick. They want ONE theme that says the durable thing, with the originals
// archived beneath it and restorable.
//
// A cluster is therefore CROSS-SESSION by definition. A within-session group is stage 1's
// job and must never reach the model.

const at = (deg: number) => Float32Array.from([
  Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0,
]);
const row = (id: number, title: string, session: string, total = 1): ThemeRow => ({
  id, type: 'discovery', title, session_id: session, created_at_epoch: 1000 + id,
  from_auto: total, from_search: 0, from_drill: 0,
});
const vecs = (m: Record<number, Float32Array>) => (id: number) => m[id] ?? null;
const base = { cosineThreshold: 0.93, minMembers: 3, maxClusters: 10, isProtected: () => false };

describe('findThemeClusters', () => {
  test('clusters three cross-session restatements of one standing fact', () => {
    const rows = [
      row(1, 'update-status skill command verified and available', 's1', 9),
      row(2, 'update-status skill registered and callable', 's2', 3),
      row(3, 'Confirmed update-status skill availability', 's3', 1),
    ];
    const cs = findThemeClusters({ ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(4), 3: at(8) }) });
    expect(cs.length).toBe(1);
    expect(cs[0]!.members.map(m => m.id).sort()).toEqual([1, 2, 3]);
    expect(cs[0]!.sessionCount).toBe(3);
  });

  // The whole point of the split. A same-session group is a restatement stage 1 already folds;
  // sending it to a model would spend tokens to reach the same place less safely.
  test('refuses a cluster confined to ONE session', () => {
    const rows = [row(1, 'a', 's1', 3), row(2, 'b', 's1', 2), row(3, 'c', 's1', 1)];
    expect(findThemeClusters({ ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(3), 3: at(6) }) })).toEqual([]);
  });

  // Two rows are a pair, not a theme. Summarising a pair costs a model call to say what the
  // higher-count row already says.
  test('requires at least minMembers rows', () => {
    const rows = [row(1, 'a', 's1', 3), row(2, 'b', 's2', 1)];
    expect(findThemeClusters({ ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(3) }) })).toEqual([]);
  });

  test('does not cluster below the cosine threshold', () => {
    const rows = [row(1, 'a', 's1'), row(2, 'b', 's2'), row(3, 'c', 's3')];
    expect(findThemeClusters({ ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(40), 3: at(80) }) })).toEqual([]);
  });

  // Same rule the fold path applies: a row you drilled into or anchored is never touched by
  // the machine. Excluding it can drop the cluster under minMembers, which is correct.
  test('excludes protected rows, and drops the cluster if that leaves too few', () => {
    const rows = [row(1, 'a', 's1', 3), row(2, 'b', 's2', 2), row(3, 'c', 's3', 1)];
    const vm = { 1: at(0), 2: at(3), 3: at(6) };
    expect(findThemeClusters({
      ...base, rows, representativeVector: vecs(vm), isProtected: (id) => id === 3,
    })).toEqual([]);                                   // 2 left ⇒ under minMembers
  });

  test('keeps a cluster that still has enough members after exclusion', () => {
    const rows = [row(1, 'a', 's1', 4), row(2, 'b', 's2', 3), row(3, 'c', 's3', 2), row(4, 'd', 's4', 1)];
    const vm = { 1: at(0), 2: at(2), 3: at(4), 4: at(6) };
    const cs = findThemeClusters({
      ...base, rows, representativeVector: vecs(vm), isProtected: (id) => id === 4,
    });
    expect(cs.length).toBe(1);
    expect(cs[0]!.members.map(m => m.id).sort()).toEqual([1, 2, 3]);
  });

  test('fail-closed on a missing vector', () => {
    const rows = [row(1, 'a', 's1'), row(2, 'b', 's2'), row(3, 'c', 's3')];
    expect(findThemeClusters({ ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(3) }) })).toEqual([]);
  });

  test('honours the merge guard — a version mismatch never themes', () => {
    const rows = [
      row(1, 'Bump captain-memo to 1.0.0', 's1'),
      row(2, 'Bump captain-memo to 2.0.0', 's2'),
      row(3, 'Bump captain-memo to 3.0.0', 's3'),
    ];
    expect(findThemeClusters({ ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(2), 3: at(4) }) })).toEqual([]);
  });

  test('a row belongs to at most one cluster', () => {
    const rows = [
      row(1, 'a', 's1', 9), row(2, 'b', 's2', 8), row(3, 'c', 's3', 7),
      row(4, 'd', 's4', 6), row(5, 'e', 's5', 5), row(6, 'f', 's6', 4),
    ];
    const vm = { 1: at(0), 2: at(2), 3: at(4), 4: at(90), 5: at(92), 6: at(94) };
    const cs = findThemeClusters({ ...base, rows, representativeVector: vecs(vm) });
    const all = cs.flatMap(c => c.members.map(m => m.id));
    expect(new Set(all).size).toBe(all.length);
  });

  test('maxClusters caps the work', () => {
    const rows: ThemeRow[] = [];
    const vm: Record<number, Float32Array> = {};
    for (let g = 0; g < 3; g++) {
      for (let i = 0; i < 3; i++) {
        const id = g * 10 + i;
        rows.push(row(id, `g${g} row${i}`, `s${g}_${i}`, 3 - i));
        vm[id] = at(g * 60 + i * 2);
      }
    }
    expect(findThemeClusters({ ...base, rows, representativeVector: vecs(vm) }).length).toBe(3);
    expect(findThemeClusters({ ...base, rows, representativeVector: vecs(vm), maxClusters: 1 }).length).toBe(1);
  });
});
