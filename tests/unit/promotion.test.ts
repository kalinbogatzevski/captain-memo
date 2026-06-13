import { test, expect } from 'bun:test';
import { runPromotionSlice, type PromotionDeps } from '../../src/worker/promotion.ts';
import { DEFAULT_PROMOTION_CONFIG, type PromotionConfig } from '../../src/worker/promotion-config.ts';
import type { Observation } from '../../src/shared/types.ts';
import type { WriteMemoryResult } from '../../src/worker/memory-writer.ts';

const NOW = 1000;

function obs(id: number, over: Partial<Observation> = {}): Observation {
  return {
    id, session_id: 's', project_id: 'default', prompt_number: 1,
    type: 'decision', title: `obs-${id}`, narrative: `narrative ${id}`,
    facts: [`fact ${id}`], concepts: ['c'], files_read: [], files_modified: [],
    created_at_epoch: 1_700_000_000, branch: null, work_tokens: null, stored_tokens: null,
    retrieval_count: 0, last_retrieved_at: null,
    from_auto: 0, from_search: 1, from_drill: 0,
    last_surfaced_at: null, last_surfaced_source: null,
    archived: false, archived_into_theme_id: null, theme_member_ids: null,
    stability_days: null, tide_state: 'active', tide_state_changed_at: null, is_anchored: false,
    ...over,
  } as Observation;
}

interface Rec {
  writes: Array<{ sourceObservationId?: number | undefined; type: string; cwd?: string | undefined; targetDirOverride?: string | undefined }>;
  promoted: number[];
  judgeCalls: number;
}

function makeDeps(
  candidates: Observation[],
  promote: number[],
  over: Partial<PromotionDeps> = {},
): { deps: PromotionDeps; rec: Rec } {
  const rec: Rec = { writes: [], promoted: [], judgeCalls: 0 };
  const cfg: PromotionConfig = { ...DEFAULT_PROMOTION_CONFIG, enabled: true, maxPerRun: 5 };
  const deps: PromotionDeps = {
    candidates: () => candidates,
    judge: async (rows) => {
      rec.judgeCalls++;
      return rows
        .filter(r => promote.includes(r.id))
        .map(r => ({ sourceObservationId: r.id, type: 'decision',
          name: `n-${r.id}`, description: `d-${r.id}`, body: `b-${r.id}` }));
    },
    writeMemory: async (input) => {
      rec.writes.push({ sourceObservationId: input.sourceObservationId, type: input.type,
        cwd: input.projectContext.cwd, targetDirOverride: input.targetDirOverride });
      return { ok: true, path: `/mem/n-${input.sourceObservationId}.md`,
        action: 'created', doc_id: `doc-${input.sourceObservationId}` } as WriteMemoryResult;
    },
    markPromoted: (id) => { rec.promoted.push(id); },
    cfg,
    now: () => NOW,
    log: () => {},
    ...over,
  };
  return { deps, rec };
}

test('runPromotionSlice — off by default: enabled=false consults no candidates', async () => {
  let consulted = false;
  const { deps, rec } = makeDeps([obs(1)], [1], {
    cfg: { ...DEFAULT_PROMOTION_CONFIG, enabled: false },
    candidates: () => { consulted = true; return [obs(1)]; },
  });
  const r = await runPromotionSlice(deps);
  expect(r).toEqual({ scanned: 0, promoted: 0, skipped: 0, errored: 0 });
  expect(consulted).toBe(false);
  expect(rec.judgeCalls).toBe(0);
  expect(rec.writes).toHaveLength(0);
  expect(rec.promoted).toHaveLength(0);
});

test('runPromotionSlice — promotes judged survivors: writes with sourceObservationId + NO cwd, marks promoted', async () => {
  const { deps, rec } = makeDeps([obs(1), obs(2)], [1]);
  const r = await runPromotionSlice(deps);
  expect(r).toEqual({ scanned: 2, promoted: 1, skipped: 1, errored: 0 });
  expect(rec.writes).toEqual([
    { sourceObservationId: 1, type: 'decision', cwd: undefined, targetDirOverride: undefined },
  ]);
  expect(rec.promoted).toEqual([1]);
});

test('runPromotionSlice — idempotency: a promoted row is excluded next run (candidates filter), no re-promote', async () => {
  const all = [obs(1), obs(2)];
  let promotedIds: number[] = [];
  const { deps, rec } = makeDeps(all, [1, 2], {
    candidates: () => all.filter(o => !promotedIds.includes(o.id)),
    markPromoted: (id) => { promotedIds.push(id); rec.promoted.push(id); },
  });
  const first = await runPromotionSlice(deps);
  expect(first.promoted).toBe(2);
  expect(rec.promoted).toEqual([1, 2]);
  const second = await runPromotionSlice(deps);
  expect(second).toEqual({ scanned: 0, promoted: 0, skipped: 0, errored: 0 });
  expect(rec.writes).toHaveLength(2);
});

test('runPromotionSlice — max-per-run cap: only N written, the rest skipped + left unmarked', async () => {
  const rows = [obs(1), obs(2), obs(3)];
  const { deps, rec } = makeDeps(rows, [1, 2, 3], {
    cfg: { ...DEFAULT_PROMOTION_CONFIG, enabled: true, maxPerRun: 2 },
  });
  const r = await runPromotionSlice(deps);
  expect(r.promoted).toBe(2);
  expect(r.skipped).toBe(1);
  expect(rec.writes).toHaveLength(2);
  expect(rec.promoted).toEqual([1, 2]);
});

test('runPromotionSlice — soft write failure: ok:false counts errored, row left unmarked', async () => {
  const { deps, rec } = makeDeps([obs(1)], [1], {
    writeMemory: async () => ({ ok: false, reason: 'disk full' } as WriteMemoryResult),
  });
  const r = await runPromotionSlice(deps);
  expect(r).toEqual({ scanned: 1, promoted: 0, skipped: 0, errored: 1 });
  expect(rec.promoted).toHaveLength(0);
});
