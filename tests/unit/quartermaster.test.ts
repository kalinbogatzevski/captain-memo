import { test, expect } from 'bun:test';
import { runQmDedupSlice, type QmDedupDeps } from '../../src/worker/quartermaster.ts';
import { DEFAULT_QM_CONFIG, type QmConfig } from '../../src/worker/qm.ts';
import type { DuplicateGroup, DuplicateEntry } from '../../src/worker/observations-store.ts';

const NOW = 1000;

function entry(id: number, total = 1): DuplicateEntry {
  return { id, type: 'feature', title: `obs-${id}`, total };
}

function group(survivorId: number, memberIds: number[]): DuplicateGroup {
  return { survivor: entry(survivorId), members: memberIds.map(id => entry(id)) };
}

/** A unit vector pointing at `angleDeg` degrees in the first 2 dims (rest zero).
 *  cosine(v(0), v(θ)) = cos(θ), so callers dial an exact similarity. */
function vecAt(angleDeg: number): Float32Array {
  const r = (angleDeg * Math.PI) / 180;
  return new Float32Array([Math.cos(r), Math.sin(r), 0, 0]);
}

interface Recorded {
  merges: Array<{ survivorId: number; memberIds: number[]; atEpoch: number }>;
  yields: number;
}

function makeDeps(
  groups: DuplicateGroup[],
  vectors: Map<number, Float32Array | null>,
  over: Partial<QmDedupDeps> = {},
): { deps: QmDedupDeps; rec: Recorded } {
  const rec: Recorded = { merges: [], yields: 0 };
  const cfg: QmConfig = { ...DEFAULT_QM_CONFIG, enabled: true, dedupEnabled: true, dedupCosineThreshold: 0.98 };
  const deps: QmDedupDeps = {
    candidates: () => groups,
    representativeVector: (id) => (vectors.has(id) ? vectors.get(id)! : null),
    memberIsProtected: () => false,
    // Honest writer: archives every proposed member (no cross-scope drop in unit land),
    // so the returned count == the proposed count. Fix B threads this back to res.merges.
    mergeGroup: (survivorId, memberIds, atEpoch) => {
      rec.merges.push({ survivorId, memberIds, atEpoch });
      return memberIds.length;
    },
    shouldAbort: () => false,
    cfg,
    now: () => NOW,
    yieldToLoop: async () => { rec.yields++; },
    ...over,
  };
  return { deps, rec };
}

test('runQmDedupSlice — off by default: dedupEnabled=false consults no candidates', async () => {
  let consulted = false;
  const { deps, rec } = makeDeps([group(1, [2])], new Map(), {
    cfg: { ...DEFAULT_QM_CONFIG, enabled: true, dedupEnabled: false },
    candidates: () => { consulted = true; return []; },
  });
  const r = await runQmDedupSlice(deps);
  expect(r).toEqual({ scanned: 0, merges: 0, skippedNoVector: 0, aborted: false });
  expect(consulted).toBe(false);
  expect(rec.merges).toHaveLength(0);
});

test('runQmDedupSlice — off when the master switch is off', async () => {
  const { deps } = makeDeps([group(1, [2])], new Map([[1, vecAt(0)], [2, vecAt(0)]]), {
    cfg: { ...DEFAULT_QM_CONFIG, enabled: false, dedupEnabled: true },
  });
  const r = await runQmDedupSlice(deps);
  expect(r).toEqual({ scanned: 0, merges: 0, skippedNoVector: 0, aborted: false });
});

test('runQmDedupSlice — cosine gate: a near-identical member (0.99) folds', async () => {
  // cosine(vecAt(0), vecAt(8)) = cos(8°) ≈ 0.990 ≥ 0.98
  const { deps, rec } = makeDeps([group(1, [2])], new Map([[1, vecAt(0)], [2, vecAt(8)]]));
  const r = await runQmDedupSlice(deps);
  expect(r).toEqual({ scanned: 1, merges: 1, skippedNoVector: 0, aborted: false });
  expect(rec.merges).toEqual([{ survivorId: 1, memberIds: [2], atEpoch: NOW }]);
});

test('runQmDedupSlice — cosine gate: a member at 0.90 does NOT fold (no merge)', async () => {
  // cosine(vecAt(0), vecAt(26)) = cos(26°) ≈ 0.899 < 0.98
  const { deps, rec } = makeDeps([group(1, [2])], new Map([[1, vecAt(0)], [2, vecAt(26)]]));
  const r = await runQmDedupSlice(deps);
  expect(r).toEqual({ scanned: 1, merges: 0, skippedNoVector: 0, aborted: false });
  expect(rec.merges).toHaveLength(0);
});

test('runQmDedupSlice — fail-closed: a member with no vector is not folded, counts skippedNoVector', async () => {
  // member 2 has a good vector, member 3 has none → only 2 folds; 3 counts as skipped
  const { deps, rec } = makeDeps(
    [group(1, [2, 3])],
    new Map<number, Float32Array | null>([[1, vecAt(0)], [2, vecAt(4)]]), // 3 absent ⇒ null
  );
  const r = await runQmDedupSlice(deps);
  expect(r).toEqual({ scanned: 1, merges: 1, skippedNoVector: 1, aborted: false });
  expect(rec.merges).toEqual([{ survivorId: 1, memberIds: [2], atEpoch: NOW }]);
});

test('runQmDedupSlice — fail-closed: no survivor vector skips the whole group, yields and continues', async () => {
  const groups = [group(1, [2]), group(10, [11])];
  const vectors = new Map<number, Float32Array | null>([
    // group 1: survivor 1 has NO vector ⇒ skip entirely
    [2, vecAt(0)],
    // group 10: survivor + member both good ⇒ folds
    [10, vecAt(0)], [11, vecAt(4)],
  ]);
  const { deps, rec } = makeDeps(groups, vectors);
  const r = await runQmDedupSlice(deps);
  expect(r.scanned).toBe(2);
  expect(r.merges).toBe(1);
  expect(r.skippedNoVector).toBe(1);   // the whole no-survivor-vector group counted once
  expect(rec.merges).toEqual([{ survivorId: 10, memberIds: [11], atEpoch: NOW }]);
  // the skipped group still yielded (heartbeat breathes)
  expect(rec.yields).toBeGreaterThanOrEqual(2);
});

test('runQmDedupSlice — protected member is NEVER auto-folded (skipped outright)', async () => {
  // Both members clear the cosine gate, but BOTH are protected ⇒ nothing folds.
  const { deps, rec } = makeDeps(
    [group(1, [2, 3])],
    new Map([[1, vecAt(0)], [2, vecAt(4)], [3, vecAt(5)]]),
    { memberIsProtected: (id) => id === 2 || id === 3 },
  );
  const r = await runQmDedupSlice(deps);
  expect(r).toEqual({ scanned: 1, merges: 0, skippedNoVector: 0, aborted: false });
  expect(rec.merges).toHaveLength(0);   // no merge proposed at all
});

test('runQmDedupSlice — [survivor, protected, normal]: folds ONLY the normal member', async () => {
  // 2 protected (drilled/pinned), 3 normal — both clear the cosine gate.
  const { deps, rec } = makeDeps(
    [group(1, [2, 3])],
    new Map([[1, vecAt(0)], [2, vecAt(4)], [3, vecAt(5)]]),
    { memberIsProtected: (id) => id === 2 },
  );
  const r = await runQmDedupSlice(deps);
  expect(r).toEqual({ scanned: 1, merges: 1, skippedNoVector: 0, aborted: false });
  // protected member 2 absent from the fold; only the normal member 3 folds
  expect(rec.merges).toEqual([{ survivorId: 1, memberIds: [3], atEpoch: NOW }]);
});

test('runQmDedupSlice — abort at the start: returns aborted, no merges', async () => {
  const { deps, rec } = makeDeps([group(1, [2])], new Map([[1, vecAt(0)], [2, vecAt(4)]]), {
    shouldAbort: () => true,
  });
  const r = await runQmDedupSlice(deps);
  expect(r.aborted).toBe(true);
  expect(r.scanned).toBe(0);
  expect(r.merges).toBe(0);
  expect(rec.merges).toHaveLength(0);
});

test('runQmDedupSlice — abort after the first group stops the second', async () => {
  let calls = 0;
  const groups = [group(1, [2]), group(10, [11])];
  const vectors = new Map([[1, vecAt(0)], [2, vecAt(4)], [10, vecAt(0)], [11, vecAt(4)]]);
  const { deps, rec } = makeDeps(groups, vectors, {
    // false for the first group's check, true for the second
    shouldAbort: () => calls++ >= 1,
  });
  const r = await runQmDedupSlice(deps);
  expect(r.aborted).toBe(true);
  expect(r.scanned).toBe(1);        // only the first group scanned
  expect(r.merges).toBe(1);
  expect(rec.merges).toEqual([{ survivorId: 1, memberIds: [2], atEpoch: NOW }]);
});

test('runQmDedupSlice — yields at least once per scanned group', async () => {
  const groups = [group(1, [2]), group(10, [11])];
  const vectors = new Map([[1, vecAt(0)], [2, vecAt(4)], [10, vecAt(0)], [11, vecAt(4)]]);
  const { deps, rec } = makeDeps(groups, vectors);
  await runQmDedupSlice(deps);
  expect(rec.yields).toBeGreaterThanOrEqual(2);
});

test('runQmDedupSlice — audit counts: 3-member group folds exactly the two ≥ threshold', async () => {
  // members: 2 @ 0.999 (in), 3 @ 0.995 (in), 4 @ 0.90 (out)
  const vectors = new Map([
    [1, vecAt(0)],
    [2, vecAt(2)],   // cos(2°) ≈ 0.9994
    [3, vecAt(5)],   // cos(5°) ≈ 0.9962
    [4, vecAt(26)],  // cos(26°) ≈ 0.899
  ]);
  const { deps, rec } = makeDeps([group(1, [2, 3, 4])], vectors);
  const r = await runQmDedupSlice(deps);
  expect(r).toEqual({ scanned: 1, merges: 2, skippedNoVector: 0, aborted: false });
  expect(rec.merges).toEqual([{ survivorId: 1, memberIds: [2, 3], atEpoch: NOW }]);
});

test('runQmDedupSlice — honest merge count: writer drops a member ⇒ res.merges reflects the archive', async () => {
  // The slice proposes [2, 3] but the writer (cross-scope filter) only archives 1.
  // Fix B: res.merges must follow the returned count, not foldable.length.
  const { deps, rec } = makeDeps(
    [group(1, [2, 3])],
    new Map([[1, vecAt(0)], [2, vecAt(4)], [3, vecAt(5)]]),
    { mergeGroup: (s, m, at) => { rec.merges.push({ survivorId: s, memberIds: m, atEpoch: at }); return 1; } },
  );
  const r = await runQmDedupSlice(deps);
  expect(r.merges).toBe(1);                                     // honest: writer archived 1, not 2
  expect(rec.merges).toEqual([{ survivorId: 1, memberIds: [2, 3], atEpoch: NOW }]);
});

test('runQmDedupSlice — skippedNoVector: survivor-less group + member-less member both counted, neither folds', async () => {
  // group A (survivor 1): survivor has NO vector ⇒ whole group skipped (skippedNoVector += 1).
  // group B (survivor 10): member 11 good (folds), member 12 has NO vector (skippedNoVector += 1).
  const groups = [group(1, [2]), group(10, [11, 12])];
  const vectors = new Map<number, Float32Array | null>([
    [2, vecAt(0)],                       // 1 absent ⇒ survivor null
    [10, vecAt(0)], [11, vecAt(4)],      // 12 absent ⇒ member null
  ]);
  const { deps, rec } = makeDeps(groups, vectors);
  const r = await runQmDedupSlice(deps);
  expect(r.scanned).toBe(2);
  expect(r.merges).toBe(1);                                     // only member 11 folds
  expect(r.skippedNoVector).toBe(2);                           // group A + member 12
  expect(rec.merges).toEqual([{ survivorId: 10, memberIds: [11], atEpoch: NOW }]);
});

test('runQmDedupSlice — intra-group heartbeat: yields + re-checks abort every 32 members', async () => {
  // One big same-scope group of 100 members, all clearing the cosine gate. The slice
  // must yield to the loop at least 3 extra times mid-group (at 32, 64, 96), plus the
  // end-of-group yield, so a huge group can't starve the heartbeat (Fix E).
  const members = Array.from({ length: 100 }, (_, i) => i + 2);
  const vectors = new Map<number, Float32Array | null>([[1, vecAt(0)]]);
  for (const id of members) vectors.set(id, vecAt(4)); // cos(4°) ≈ 0.9976 ≥ 0.98
  const { deps, rec } = makeDeps([group(1, members)], vectors);
  const r = await runQmDedupSlice(deps);
  expect(r.merges).toBe(100);
  expect(rec.yields).toBeGreaterThanOrEqual(4);                // ≥3 intra-group + 1 end-of-group
});

test('runQmDedupSlice — intra-group abort: ingest mid huge-group bails without folding the partial group', async () => {
  // shouldAbort flips true after the first intra-group yield (the 32-member checkpoint).
  // The slice must return aborted with NO merge recorded for the partial group (Fix E).
  let yields = 0;
  const members = Array.from({ length: 100 }, (_, i) => i + 2);
  const vectors = new Map<number, Float32Array | null>([[1, vecAt(0)]]);
  for (const id of members) vectors.set(id, vecAt(4));
  const { deps, rec } = makeDeps([group(1, members)], vectors, {
    yieldToLoop: async () => { yields++; },
    shouldAbort: () => yields >= 1,   // false at top-of-group, true after first intra-group yield
  });
  const r = await runQmDedupSlice(deps);
  expect(r.aborted).toBe(true);
  expect(r.merges).toBe(0);
  expect(rec.merges).toHaveLength(0); // partial group NOT folded
});
