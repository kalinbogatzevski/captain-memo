import { test, expect } from 'bun:test';
import { runTideSweepSlice, type TideSweepDeps } from '../../src/worker/tide-sweep.ts';
import { DEFAULT_TIDE_CONFIG, type TideConfig, type TideState, type TideRow } from '../../src/worker/tide.ts';

const NOW = 1_800_000_000;
const DAY = 86_400;
type Cand = TideRow & { id: number; tide_state: TideState };

function cand(over: Partial<Cand>): Cand {
  return {
    id: 1, tide_state: 'active',
    created_at_epoch: NOW - 400 * DAY, last_surfaced_at: NOW - 400 * DAY,
    stability_days: 7, from_drill: 0, is_anchored: false, ...over,
  };
}

function makeDeps(rows: Cand[], over: Partial<TideSweepDeps> = {}) {
  const flips: Array<{ id: number; state: TideState }> = [];
  const counters = { yields: 0 };
  const cfg: TideConfig = { ...DEFAULT_TIDE_CONFIG, enabled: true, tieringEnabled: true };
  const deps: TideSweepDeps = {
    candidates: () => rows,
    setTideState: (id, state) => { flips.push({ id, state }); },
    shouldAbort: () => false,
    cfg,
    now: () => NOW,
    yieldToLoop: async () => { counters.yields++; },
    ...over,
  };
  return { deps, flips, counters };
}

test('runTideSweepSlice — no-op when tiering disabled', async () => {
  const { deps, flips } = makeDeps([cand({})], { cfg: { ...DEFAULT_TIDE_CONFIG, enabled: true, tieringEnabled: false } });
  const r = await runTideSweepSlice(deps);
  expect(r).toEqual({ scanned: 0, ebbed: 0, archived: 0, aborted: false });
  expect(flips).toHaveLength(0);
});

test('runTideSweepSlice — no-op when the Tide re-rank itself is disabled', async () => {
  const { deps } = makeDeps([cand({})], { cfg: { ...DEFAULT_TIDE_CONFIG, enabled: false, tieringEnabled: true } });
  expect((await runTideSweepSlice(deps)).scanned).toBe(0);
});

test('runTideSweepSlice — aborts before scanning if ingest is already queued', async () => {
  const { deps, flips } = makeDeps([cand({})], { shouldAbort: () => true });
  const r = await runTideSweepSlice(deps);
  expect(r.aborted).toBe(true);
  expect(r.scanned).toBe(0);
  expect(flips).toHaveLength(0);
});

test('runTideSweepSlice — ebbs an old, low-buoyancy active row to dormant', async () => {
  // stability 7, age 400d ⇒ buoyancy ≈ 0.10 < 0.30; age > 90 ⇒ ebb
  const { deps, flips } = makeDeps([cand({ id: 5, tide_state: 'active', last_surfaced_at: NOW - 400 * DAY })]);
  const r = await runTideSweepSlice(deps);
  expect(r.scanned).toBe(1);
  expect(r.ebbed).toBe(1);
  expect(flips).toEqual([{ id: 5, state: 'dormant' }]);
});

test('runTideSweepSlice — archives a dormant row past the archive gates', async () => {
  // stability 7, age 1000d ⇒ buoyancy ≈ 0.045 < 0.05; age > 180 ⇒ archive
  const { deps, flips } = makeDeps([cand({ id: 9, tide_state: 'dormant', last_surfaced_at: NOW - 1000 * DAY })]);
  const r = await runTideSweepSlice(deps);
  expect(r.archived).toBe(1);
  expect(flips).toEqual([{ id: 9, state: 'archived' }]);
});

test('runTideSweepSlice — leaves afloat / drilled / anchored rows untouched', async () => {
  const rows = [
    cand({ id: 1, last_surfaced_at: NOW - 1 * DAY }),                      // afloat → buoyancy gate
    cand({ id: 2, from_drill: 2, last_surfaced_at: NOW - 400 * DAY }),     // drilled → protected
    cand({ id: 3, is_anchored: true, last_surfaced_at: NOW - 400 * DAY }), // anchored → protected
  ];
  const { deps, flips } = makeDeps(rows);
  const r = await runTideSweepSlice(deps);
  expect(r.scanned).toBe(3);
  expect(r.ebbed).toBe(0);
  expect(flips).toHaveLength(0);
});

test('runTideSweepSlice — aborts mid-slice the moment ingest arrives (heartbeat preempt)', async () => {
  const rows = [
    cand({ id: 1, last_surfaced_at: NOW - 400 * DAY }),
    cand({ id: 2, last_surfaced_at: NOW - 400 * DAY }),
    cand({ id: 3, last_surfaced_at: NOW - 400 * DAY }),
  ];
  let yielded = 0;
  const { deps, flips } = makeDeps(rows, {
    yieldToLoop: async () => { yielded++; },
    shouldAbort: () => yielded >= 1,   // abort right after the first row yields
  });
  const r = await runTideSweepSlice(deps);
  expect(r.aborted).toBe(true);
  expect(r.scanned).toBe(1);                       // processed row 1, preempted before row 2
  expect(flips).toEqual([{ id: 1, state: 'dormant' }]);
  expect(yielded).toBe(1);                         // yielded to the event loop exactly once
});
