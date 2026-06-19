// tests/unit/supersede.test.ts
import { test, expect } from 'bun:test';
import { runQmSupersedeSlice, applySupersedeDemotion, type QmSupersedeDeps } from '../../src/worker/supersede.ts';
import { DEFAULT_QM_CONFIG, type QmConfig } from '../../src/worker/qm.ts';
import type { SupersedeCandidate } from '../../src/worker/observations-store.ts';

const NOW = 1000;

function vecAt(angleDeg: number): Float32Array {
  const r = (angleDeg * Math.PI) / 180;
  return new Float32Array([Math.cos(r), Math.sin(r), 0, 0]);
}

function cand(olderId: number, newerId: number): SupersedeCandidate {
  return { older: { id: olderId, version: 'v1.0.0' }, newer: { id: newerId, version: 'v2.0.0' }, entityKey: 'x' };
}

function makeDeps(
  candidates: SupersedeCandidate[],
  vectors: Map<number, Float32Array | null>,
  over: Partial<QmSupersedeDeps> = {},
): { deps: QmSupersedeDeps; links: Array<{ older: number; newer: number }> } {
  const links: Array<{ older: number; newer: number }> = [];
  const cfg: QmConfig = { ...DEFAULT_QM_CONFIG, enabled: true, supersedeEnabled: true, dedupCosineThreshold: 0.98 };
  const deps: QmSupersedeDeps = {
    candidates: () => candidates,
    representativeVector: (id) => (vectors.has(id) ? vectors.get(id)! : null),
    isProtected: () => false,
    linkSupersede: (older, newer) => { links.push({ older, newer }); },
    shouldAbort: () => false,
    cfg,
    now: () => NOW,
    yieldToLoop: async () => {},
    ...over,
  };
  return { deps, links };
}

test('runQmSupersedeSlice — off by default (supersedeEnabled=false consults nothing)', async () => {
  let consulted = false;
  const { deps, links } = makeDeps([cand(1, 2)], new Map(), {
    cfg: { ...DEFAULT_QM_CONFIG, enabled: true, supersedeEnabled: false },
    candidates: () => { consulted = true; return []; },
  });
  const r = await runQmSupersedeSlice(deps);
  expect(r).toEqual({ scanned: 0, linked: 0, skippedNoVector: 0, aborted: false });
  expect(consulted).toBe(false);
  expect(links).toHaveLength(0);
});

test('runQmSupersedeSlice — links a high-cosine pair', async () => {
  const { deps, links } = makeDeps([cand(1, 2)], new Map([[1, vecAt(0)], [2, vecAt(2)]])); // cos≈0.999
  const r = await runQmSupersedeSlice(deps);
  expect(r.linked).toBe(1);
  expect(links).toEqual([{ older: 1, newer: 2 }]);
});

test('runQmSupersedeSlice — skips below the cosine threshold (different facts)', async () => {
  const { deps, links } = makeDeps([cand(1, 2)], new Map([[1, vecAt(0)], [2, vecAt(20)]])); // cos≈0.94 < 0.98
  const r = await runQmSupersedeSlice(deps);
  expect(r.linked).toBe(0);
  expect(links).toHaveLength(0);
});

test('runQmSupersedeSlice — skips protected older rows and fails closed on missing vectors', async () => {
  const protectedRun = makeDeps([cand(1, 2)], new Map([[1, vecAt(0)], [2, vecAt(0)]]), { isProtected: (id) => id === 1 });
  expect((await runQmSupersedeSlice(protectedRun.deps)).linked).toBe(0);

  const noVec = makeDeps([cand(3, 4)], new Map([[3, vecAt(0)]])); // 4 missing
  const r = await runQmSupersedeSlice(noVec.deps);
  expect(r.linked).toBe(0);
  expect(r.skippedNoVector).toBe(1);
});

test('applySupersedeDemotion — penalizes superseded hits and re-sorts; inert at penalty 1', () => {
  const items = [
    { score: 1.0, metadata: { observation_id: 1 } },
    { score: 0.9, metadata: { observation_id: 2 } },
  ];
  const out = applySupersedeDemotion(items, new Set([1]), 0.5);
  expect(out[0]!.metadata.observation_id).toBe(2); // 0.9 now beats 1.0*0.5=0.5
  expect(out[1]!.score).toBeCloseTo(0.5);
  // inert paths return the original array reference
  expect(applySupersedeDemotion(items, new Set([1]), 1)).toBe(items);
  expect(applySupersedeDemotion(items, new Set(), 0.5)).toBe(items);
});
