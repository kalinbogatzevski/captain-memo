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
const row = (id: number, title: string, session: string, total = 1,
             project = 'p', branch: string | null = null): ThemeRow => ({
  id, type: 'discovery', title, session_id: session, created_at_epoch: 1000 + id,
  project_id: project, branch,
  from_auto: total, from_search: 0, from_drill: 0,
});
const vecs = (m: Record<number, Float32Array>) => (id: number) => m[id] ?? null;
// Co-retrieval defaults to "always co-recalled" in most tests so the older cases keep asserting
// what they were written to assert; the dedicated block below drives it directly.
const base = {
  cosineThreshold: 0.93, minMembers: 3, maxClusters: 10, isProtected: () => false,
  coRetrieval: () => 1,
};

describe('findThemeClusters', () => {
  test('clusters three cross-session restatements of one standing fact', async () => {
    const rows = [
      row(1, 'update-status skill command verified and available', 's1', 9),
      row(2, 'update-status skill registered and callable', 's2', 3),
      row(3, 'Confirmed update-status skill availability', 's3', 1),
    ];
    const cs = await findThemeClusters({ ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(4), 3: at(8) }) });
    expect(cs.length).toBe(1);
    expect(cs[0]!.members.map(m => m.id).sort()).toEqual([1, 2, 3]);
    expect(cs[0]!.sessionCount).toBe(3);
  });

  // The whole point of the split. A same-session group is a restatement stage 1 already folds;
  // sending it to a model would spend tokens to reach the same place less safely.
  test('refuses a cluster confined to ONE session', async () => {
    const rows = [row(1, 'a', 's1', 3), row(2, 'b', 's1', 2), row(3, 'c', 's1', 1)];
    expect(await findThemeClusters({ ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(3), 3: at(6) }) })).toEqual([]);
  });

  // Two rows are a pair, not a theme. Summarising a pair costs a model call to say what the
  // higher-count row already says.
  test('requires at least minMembers rows', async () => {
    const rows = [row(1, 'a', 's1', 3), row(2, 'b', 's2', 1)];
    expect(await findThemeClusters({ ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(3) }) })).toEqual([]);
  });

  test('does not cluster below the cosine threshold', async () => {
    const rows = [row(1, 'a', 's1'), row(2, 'b', 's2'), row(3, 'c', 's3')];
    expect(await findThemeClusters({ ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(40), 3: at(80) }) })).toEqual([]);
  });

  // Same rule the fold path applies: a row you drilled into or anchored is never touched by
  // the machine. Excluding it can drop the cluster under minMembers, which is correct.
  test('excludes protected rows, and drops the cluster if that leaves too few', async () => {
    const rows = [row(1, 'a', 's1', 3), row(2, 'b', 's2', 2), row(3, 'c', 's3', 1)];
    const vm = { 1: at(0), 2: at(3), 3: at(6) };
    expect(await findThemeClusters({
      ...base, rows, representativeVector: vecs(vm), isProtected: (id) => id === 3,
    })).toEqual([]);                                   // 2 left ⇒ under minMembers
  });

  test('keeps a cluster that still has enough members after exclusion', async () => {
    const rows = [row(1, 'a', 's1', 4), row(2, 'b', 's2', 3), row(3, 'c', 's3', 2), row(4, 'd', 's4', 1)];
    const vm = { 1: at(0), 2: at(2), 3: at(4), 4: at(6) };
    const cs = await findThemeClusters({
      ...base, rows, representativeVector: vecs(vm), isProtected: (id) => id === 4,
    });
    expect(cs.length).toBe(1);
    expect(cs[0]!.members.map(m => m.id).sort()).toEqual([1, 2, 3]);
  });

  test('fail-closed on a missing vector', async () => {
    const rows = [row(1, 'a', 's1'), row(2, 'b', 's2'), row(3, 'c', 's3')];
    expect(await findThemeClusters({ ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(3) }) })).toEqual([]);
  });

  test('honours the merge guard — a version mismatch never themes', async () => {
    const rows = [
      row(1, 'Bump captain-memo to 1.0.0', 's1'),
      row(2, 'Bump captain-memo to 2.0.0', 's2'),
      row(3, 'Bump captain-memo to 3.0.0', 's3'),
    ];
    expect(await findThemeClusters({ ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(2), 3: at(4) }) })).toEqual([]);
  });

  test('a row belongs to at most one cluster', async () => {
    const rows = [
      row(1, 'a', 's1', 9), row(2, 'b', 's2', 8), row(3, 'c', 's3', 7),
      row(4, 'd', 's4', 6), row(5, 'e', 's5', 5), row(6, 'f', 's6', 4),
    ];
    const vm = { 1: at(0), 2: at(2), 3: at(4), 4: at(90), 5: at(92), 6: at(94) };
    const cs = await findThemeClusters({ ...base, rows, representativeVector: vecs(vm) });
    const all = cs.flatMap(c => c.members.map(m => m.id));
    expect(new Set(all).size).toBe(all.length);
  });

  // FOUND BY ADVERSARIAL REVIEW, verified against the live corpus: before partitioning, ALL 5
  // clusters the next pass would have judged crossed a scope boundary and 4 of 5 crossed
  // project_id. Three unrelated repos phrasing a bug the same way would have been archived
  // together beneath one theme filed under whichever project the worker happened to run as.
  describe('scope', () => {
    test('never clusters across project_id', async () => {
      const rows = [
        row(1, 'Fix the login redirect loop', 's1', 3, 'erp-platform'),
        row(2, 'Fix the login redirect loop', 's2', 2, 'captain-hub'),
        row(3, 'Fix the login redirect loop', 's3', 1, '123net_aelita'),
      ];
      expect(await findThemeClusters({
        ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(1), 3: at(2) }),
      })).toEqual([]);
    });

    test('never clusters across branch within one project', async () => {
      const rows = [
        row(1, 'same words', 's1', 3, 'p', 'master'),
        row(2, 'same words', 's2', 2, 'p', 'feature/x'),
        row(3, 'same words', 's3', 1, 'p', 'master'),
      ];
      expect(await findThemeClusters({
        ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(1), 3: at(2) }),
      })).toEqual([]);   // only 2 in master ⇒ under minMembers
    });

    test('a cluster reports the scope it is filed under', async () => {
      const rows = [
        row(1, 'a', 's1', 3, 'erp-platform', 'master'),
        row(2, 'b', 's2', 2, 'erp-platform', 'master'),
        row(3, 'c', 's3', 1, 'erp-platform', 'master'),
      ];
      const cs = await findThemeClusters({
        ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(2), 3: at(4) }),
      });
      expect(cs.length).toBe(1);
      expect(cs[0]!.project_id).toBe('erp-platform');
      expect(cs[0]!.branch).toBe('master');
    });

    test('two projects each get their own theme rather than one merged cluster', async () => {
      const rows = [
        row(1, 'a', 's1', 6, 'A'), row(2, 'a', 's2', 5, 'A'), row(3, 'a', 's3', 4, 'A'),
        row(4, 'a', 's4', 3, 'B'), row(5, 'a', 's5', 2, 'B'), row(6, 'a', 's6', 1, 'B'),
      ];
      const vm = { 1: at(0), 2: at(1), 3: at(2), 4: at(0), 5: at(1), 6: at(2) };
      const cs = await findThemeClusters({ ...base, rows, representativeVector: vecs(vm) });
      expect(cs.length).toBe(2);
      expect(cs.map(c => c.project_id).sort()).toEqual(['A', 'B']);
      for (const c of cs) expect(new Set(c.members.map(m => m.project_id)).size).toBe(1);
    });
  });

  // THE PAGE'S ACTUAL PROMISE: "grouped by what you recall together — not merely by what shares
  // vocabulary". Cosine alone groups things that READ alike, which is the weaker claim. Requiring
  // co-retrieval evidence means a theme only forms over observations the user has genuinely
  // pulled up in the same breath. 355,315 such pairs exist on the reference corpus.
  describe('co-retrieval', () => {
    const rows = [
      row(1, 'the same conclusion, phrasing one', 's1', 3),
      row(2, 'the same conclusion, phrasing two', 's2', 2),
      row(3, 'the same conclusion, phrasing three', 's3', 1),
    ];
    const vm = { 1: at(0), 2: at(2), 3: at(4) };   // all well above the cosine threshold

    test('refuses a cluster whose members have never been recalled together', async () => {
      expect(await findThemeClusters({
        ...base, rows, representativeVector: vecs(vm), coRetrieval: () => 0,
      })).toEqual([]);
    });

    test('forms the cluster when the recall evidence is there', async () => {
      const cs = await findThemeClusters({
        ...base, rows, representativeVector: vecs(vm), coRetrieval: () => 0.5,
      });
      expect(cs.length).toBe(1);
      expect(cs[0]!.members.length).toBe(3);
    });

    test('drops the member that shares words but was never recalled alongside', async () => {
      const cs = await findThemeClusters({
        ...base,
        rows: [...rows, row(4, 'the same conclusion, phrasing four', 's4', 1)],
        representativeVector: vecs({ ...vm, 4: at(6) }),
        coRetrieval: (a, b) => (a === 4 || b === 4 ? 0 : 1),
      });
      expect(cs.length).toBe(1);
      expect(cs[0]!.members.map(m => m.id).sort()).toEqual([1, 2, 3]);   // 4 excluded
    });

    test('honours the threshold, not merely non-zero evidence', async () => {
      expect(await findThemeClusters({
        ...base, rows, representativeVector: vecs(vm),
        coRetrieval: () => 0.01, coRetrievalThreshold: 0.1,
      })).toEqual([]);
    });
  });

  // FOUND AFTER A FULL NIGHT OF ZEROS: 75 runs, 279 clusters considered, 279 declined, 0 written.
  // findThemeClusters returns a stable order and the pass takes the first maxClusters of it, so
  // the same head was re-judged 56 times while everything past position 5 stayed unreachable.
  // Skipping known refusals is what lets the budget reach the tail.
  describe('declined clusters', () => {
    const rows = [
      row(1, 'a', 's1', 9), row(2, 'a2', 's2', 8), row(3, 'a3', 's3', 7),
      row(4, 'b', 's4', 6), row(5, 'b2', 's5', 5), row(6, 'b3', 's6', 4),
    ];
    const vm = { 1: at(0), 2: at(2), 3: at(4), 4: at(90), 5: at(92), 6: at(94) };
    const key = (ids: number[]) => [...ids].sort((x, y) => x - y).join(',');

    test('without a decline memory, a cap always returns the same head', async () => {
      const first = await findThemeClusters({ ...base, rows, representativeVector: vecs(vm), maxClusters: 1 });
      const again = await findThemeClusters({ ...base, rows, representativeVector: vecs(vm), maxClusters: 1 });
      expect(first[0]!.members.map(m => m.id)).toEqual(again[0]!.members.map(m => m.id));
    });

    test('a refused cluster steps aside so the next one gets the budget', async () => {
      const first = await findThemeClusters({ ...base, rows, representativeVector: vecs(vm), maxClusters: 1 });
      const refused = new Set([key(first[0]!.members.map(m => m.id))]);
      const second = await findThemeClusters({
        ...base, rows, representativeVector: vecs(vm), maxClusters: 1,
        declined: refused, clusterKey: key,
      });
      expect(second.length).toBe(1);
      expect(second[0]!.members.map(m => m.id)).not.toEqual(first[0]!.members.map(m => m.id));
    });

    test('every cluster refused ⇒ nothing emitted, rather than the head again', async () => {
      const all = await findThemeClusters({ ...base, rows, representativeVector: vecs(vm) });
      const refused = new Set(all.map(c => key(c.members.map(m => m.id))));
      expect(await findThemeClusters({
        ...base, rows, representativeVector: vecs(vm), declined: refused, clusterKey: key,
      })).toEqual([]);
    });
  });

  test('maxClusters caps the work', async () => {
    const rows: ThemeRow[] = [];
    const vm: Record<number, Float32Array> = {};
    for (let g = 0; g < 3; g++) {
      for (let i = 0; i < 3; i++) {
        const id = g * 10 + i;
        rows.push(row(id, `g${g} row${i}`, `s${g}_${i}`, 3 - i));
        vm[id] = at(g * 60 + i * 2);
      }
    }
    expect((await findThemeClusters({ ...base, rows, representativeVector: vecs(vm) })).length).toBe(3);
    expect((await findThemeClusters({ ...base, rows, representativeVector: vecs(vm), maxClusters: 1 })).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// HEARTBEAT. The clusterer runs on the engine thread, and its cost is INVERTED: it is cheap
// when it finds clusters (the seed loop breaks at maxClusters) and most expensive when it finds
// NOTHING, because then nothing ever breaks the loop. Measured on the live 135k corpus with the
// 5,000-row window: 928 ms when 5 clusters are found, 10,747 ms when none are — 2,359,673 pairs
// in the largest partition (1,999 rows), fully synchronous. That stall outlives the 5 s heartbeat
// freshness window, so /health reports "engine unresponsive", /stats times out and writer RPCs
// 503 — observed live on 2026-08-09.
// ---------------------------------------------------------------------------

describe('heartbeat: a big partition must not starve the engine thread', () => {
  /** One partition, no co-retrieval anywhere ⇒ zero clusters ⇒ the full quadratic walk. */
  const bigPartition = (n: number) => {
    const rows: ThemeRow[] = [];
    const vm: Record<number, Float32Array> = {};
    for (let i = 0; i < n; i++) {
      rows.push(row(i, `row ${i}`, `s${i}`, 1));       // distinct sessions ⇒ all cross-session
      vm[i] = at(i % 90);
    }
    return { rows, vm };
  };

  test('yields to the loop while walking a large partition', async () => {
    const { rows, vm } = bigPartition(300);
    let yields = 0;
    await findThemeClusters({
      ...base, rows, representativeVector: vecs(vm), coRetrieval: () => 0,
      yieldToLoop: async () => { yields++; },
    });
    // Without yielding this is one uninterrupted synchronous block, however long it takes.
    expect(yields).toBeGreaterThan(0);
  });

  test('aborts mid-walk when ingest arrives, instead of finishing the quadratic', async () => {
    const { rows, vm } = bigPartition(300);
    let yields = 0;
    const out = await findThemeClusters({
      ...base, rows, representativeVector: vecs(vm), coRetrieval: () => 0,
      yieldToLoop: async () => { yields++; },
      shouldAbort: () => yields >= 2,        // ingest lands after the second breath
    });
    expect(out).toEqual([]);
    expect(yields).toBeLessThan(20);          // stopped early — did NOT walk all 300 seeds
  });

  test('still finds what it found before — yielding changes timing, never results', async () => {
    // Same rows as the very first test in this file — the yield must not change the verdict.
    const rows = [
      row(1, 'update-status skill command verified and available', 's1', 9),
      row(2, 'update-status skill registered and callable', 's2', 3),
      row(3, 'Confirmed update-status skill availability', 's3', 1),
    ];
    const out = await findThemeClusters({
      ...base, rows, representativeVector: vecs({ 1: at(0), 2: at(4), 3: at(8) }),
    });
    expect(out.length).toBe(1);
    expect(out[0]!.members.map(m => m.id).sort()).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// EVIDENCE-DRIVEN CANDIDATES. Membership needs BOTH cosine and co-retrieval, so every possible
// cluster edge is already a co-retrieval pair. Scanning the (project, branch) cross-product to
// rediscover them is the wrong way round: measured on the live corpus, 1,456,906,881 comparisons
// to find edges among 44,100 evidence pairs — 33,036x more work than the answer needs. Given the
// neighbour list, the walk iterates the evidence instead. Same verdict, different route.
// ---------------------------------------------------------------------------
describe('evidence-driven candidate iteration', () => {
  const build = (n: number) => {
    const rows: ThemeRow[] = [];
    const vm: Record<number, Float32Array> = {};
    // 1-3 are genuine cross-session restatements; the rest are numbered noise the merge guard
    // would block anyway, which is exactly the bulk the cross-product wastes its time on.
    const real = ['update-status skill command verified and available',
                  'update-status skill registered and callable',
                  'Confirmed update-status skill availability'];
    for (let i = 1; i <= n; i++) {
      rows.push(row(i, real[i - 1] ?? `unrelated note ${i} about something else`, `s${i}`, 1));
      vm[i] = at(i % 5);
    }
    return { rows, vm };
  };
  // Only 1-2-3 have evidence with each other; everything else is unrelated noise.
  const EVIDENCE: Record<number, number[]> = { 1: [2, 3], 2: [1, 3], 3: [1, 2] };
  const coRet = (a: number, b: number) => (EVIDENCE[a]?.includes(b) ? 1 : 0);

  test('produces exactly the same clusters as the full cross-product scan', async () => {
    const { rows, vm } = build(60);
    const common = { ...base, rows, representativeVector: vecs(vm), coRetrieval: coRet, minMembers: 3 };
    const viaScan = await findThemeClusters(common);
    const viaEvidence = await findThemeClusters({
      ...common, coRetrievalNeighbours: (id: number) => EVIDENCE[id] ?? [],
    });
    expect(viaEvidence).toEqual(viaScan);
    expect(viaScan.length).toBe(1);                       // the 1-2-3 cluster, found both ways
  });

  test('asks about far fewer pairs', async () => {
    const { rows, vm } = build(60);
    let scanCalls = 0, evidenceCalls = 0;
    await findThemeClusters({ ...base, rows, representativeVector: vecs(vm), minMembers: 3,
      coRetrieval: (a, b) => { scanCalls++; return coRet(a, b); } });
    await findThemeClusters({ ...base, rows, representativeVector: vecs(vm), minMembers: 3,
      coRetrieval: (a, b) => { evidenceCalls++; return coRet(a, b); },
      coRetrievalNeighbours: (id: number) => EVIDENCE[id] ?? [] });
    expect(evidenceCalls).toBeLessThan(scanCalls / 10);
  });

  test('a zero threshold admits non-evidence pairs, so the shortcut must not be taken', async () => {
    const { rows, vm } = build(12);
    const common = { ...base, rows, representativeVector: vecs(vm), coRetrieval: coRet,
                     coRetrievalThreshold: 0, minMembers: 3 };
    const viaScan = await findThemeClusters(common);
    const viaEvidence = await findThemeClusters({
      ...common, coRetrievalNeighbours: (id: number) => EVIDENCE[id] ?? [],
    });
    expect(viaEvidence).toEqual(viaScan);                  // must fall back, not narrow
  });
});
