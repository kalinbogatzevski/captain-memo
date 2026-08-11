import { test, expect, describe } from 'bun:test';
import { findDedupGroupsByCluster, type DedupRow } from '../../../src/worker/dedup-candidates.ts';

// Dedup candidates from the IVF clusters the index already assigned at insert, instead of the
// (project, branch) cross-product. Measured on the live 135k corpus, same population:
//
//   cross-product   1,456,906,881 pairs   452 s    553 groups   1,128 rows
//   within-cluster     83,980,390 pairs   28.5 s   882 groups   1,846 rows
//
// Faster AND more, because cosine runs inside the loop rather than rejecting a title-greedy
// grouping after the fact. Per-row KNN was measured at ~107 ms a query and rejected.

const at = (deg: number) => Float32Array.from([
  Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0,
]);
const row = (id: number, title: string, total = 1,
             project = 'p', branch: string | null = null): DedupRow => ({
  id, type: 'discovery', title, project_id: project, branch,
  from_auto: total, from_search: 0, from_drill: 0,
});
const base = { cosineThreshold: 0.95, titleThreshold: 0.5, maxGroups: 10, blocked: () => false };
const vecs = (m: Record<number, Float32Array>) => (id: number) => m[id] ?? null;

// Two genuine restatements the merge guard is happy with.
const A = 'worker restart uses force stop to clear zombie processes';
const B = 'worker restart uses force stop for zombie processes';

describe('findDedupGroupsByCluster', () => {
  test('folds a near-duplicate pair sharing a cluster', async () => {
    const g = await findDedupGroupsByCluster({
      ...base, rows: [row(1, A, 5), row(2, B, 2)], clusters: [[1, 2]],
      representativeVector: vecs({ 1: at(0), 2: at(1) }),
    });
    expect(g.length).toBe(1);
    expect(g[0]!.survivor.id).toBe(1);                        // highest count leads
    expect(g[0]!.members.map(m => m.id)).toEqual([2]);
  });

  test('ignores ids that are not in the candidate rows', async () => {
    // Cluster membership is raw index data; it names chunks for archived or out-of-scope rows too.
    const g = await findDedupGroupsByCluster({
      ...base, rows: [row(1, A, 5)], clusters: [[1, 2, 3, 999]],
      representativeVector: vecs({ 1: at(0) }),
    });
    expect(g).toEqual([]);
  });

  test('never crosses a project or branch boundary, even inside one cluster', async () => {
    const g = await findDedupGroupsByCluster({
      ...base,
      rows: [row(1, A, 5, 'alpha'), row(2, A, 4, 'beta'), row(3, A, 3, 'alpha', 'feature')],
      clusters: [[1, 2, 3]],
      representativeVector: vecs({ 1: at(0), 2: at(0), 3: at(0) }),
    });
    expect(g).toEqual([]);                                     // three distinct scopes
  });

  test('both gates still bind: unrelated titles, and vectors that disagree', async () => {
    expect(await findDedupGroupsByCluster({
      ...base, rows: [row(1, 'billing invoice generation schedule', 5),
                      row(2, 'network switch firmware upgrade path', 2)],
      clusters: [[1, 2]], representativeVector: vecs({ 1: at(0), 2: at(0) }),   // identical vectors
    })).toEqual([]);

    expect(await findDedupGroupsByCluster({
      ...base, rows: [row(1, A, 5), row(2, B, 2)],
      clusters: [[1, 2]], representativeVector: vecs({ 1: at(0), 2: at(80) }),  // far apart
    })).toEqual([]);
  });

  test('the merge guard vetoes, and a missing vector fails closed', async () => {
    expect(await findDedupGroupsByCluster({
      ...base, rows: [row(1, A, 5), row(2, B, 2)], clusters: [[1, 2]],
      representativeVector: vecs({ 1: at(0), 2: at(0) }), blocked: () => true,
    })).toEqual([]);

    expect(await findDedupGroupsByCluster({
      ...base, rows: [row(1, A, 5), row(2, B, 2)], clusters: [[1, 2]],
      representativeVector: (id) => (id === 2 ? null : at(0)),   // member not embedded yet
    })).toEqual([]);
  });

  test('a row is claimed once, across clusters, and maxGroups caps the work', async () => {
    const rows = [row(1, A, 9), row(2, B, 5),
                  row(3, 'commission cycle scope moved to contract creation date', 4),
                  row(4, 'commission cycle scope now uses contract creation date', 2)];
    const vm = { 1: at(0), 2: at(1), 3: at(40), 4: at(41) };
    const clusters = [[1, 2], [2, 3, 4]];                      // row 2 appears in both
    const all = await findDedupGroupsByCluster({
      ...base, rows, clusters, representativeVector: vecs(vm),
    });
    expect(all.length).toBe(2);
    const touched = all.flatMap(g => [g.survivor.id, ...g.members.map(m => m.id)]).sort();
    expect(touched).toEqual([1, 2, 3, 4]);                     // 2 folded once, not twice

    expect((await findDedupGroupsByCluster({
      ...base, rows, clusters, representativeVector: vecs(vm), maxGroups: 1,
    })).length).toBe(1);
  });

  test('breathes, and lets ingest preempt mid-walk', async () => {
    const rows: DedupRow[] = [];
    const ids: number[] = [];
    const vm: Record<number, Float32Array> = {};
    for (let i = 1; i <= 200; i++) {
      // Deliberately unmatchable: every token unique, so no pair can clear the title gate and
      // the walk measures nothing but its own breathing.
      rows.push(row(i, `topic${i} subject${i} detail${i} scope${i}`, 1));
      vm[i] = at(i % 90); ids.push(i);
    }
    let yields = 0;
    await findDedupGroupsByCluster({
      ...base, rows, clusters: [ids], representativeVector: vecs(vm),
      yieldToLoop: async () => { yields++; },
    });
    expect(yields).toBeGreaterThan(0);

    let y2 = 0;
    const out = await findDedupGroupsByCluster({
      ...base, rows, clusters: [ids], representativeVector: vecs(vm),
      yieldToLoop: async () => { y2++; }, shouldAbort: () => y2 >= 2,
    });
    expect(out).toEqual([]);
    expect(y2).toBeLessThan(10);
  });

  test('clusters can be handed over in steps — the caller controls how much per pass', async () => {
    const rows = [row(1, A, 9), row(2, B, 5),
                  row(3, 'commission cycle scope moved to contract creation date', 4),
                  row(4, 'commission cycle scope now uses contract creation date', 2)];
    const vm = { 1: at(0), 2: at(1), 3: at(40), 4: at(41) };
    const first = await findDedupGroupsByCluster({
      ...base, rows, clusters: [[1, 2]], representativeVector: vecs(vm),
    });
    const second = await findDedupGroupsByCluster({
      ...base, rows, clusters: [[3, 4]], representativeVector: vecs(vm),
    });
    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    expect(first[0]!.survivor.id).toBe(1);
    expect(second[0]!.survivor.id).toBe(3);
  });
});
