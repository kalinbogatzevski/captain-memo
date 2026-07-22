import { test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptureState } from './state.ts';
import { runCaptureTick } from './driver.ts';
import type { CaptureSource, SessionRef } from './types.ts';
import type { RawObservationEvent } from '../../shared/types.ts';

function ev(session: string): RawObservationEvent {
  return {
    session_id: session, project_id: 'p', prompt_number: 1, tool_name: 't',
    tool_input_summary: '', tool_result_summary: '', files_read: [], files_modified: [],
    ts_epoch: 0, origin_agent: 'codex',
  };
}

function fakeSource(refs: SessionRef[]): CaptureSource {
  return {
    id: 'codex',
    available: () => true,
    enabled: () => true,
    discover: () => refs,
    extract: (ref) => [ev(ref.sessionId)],
  };
}

function tmpState(): CaptureState {
  return new CaptureState(join(mkdtempSync(join(tmpdir(), 'cm-cap-')), 'capture-state.db'));
}

test('backfill guard: first tick seeds the cutoff and ingests nothing pre-existing', () => {
  const state = tmpState();
  const ref: SessionRef = { sessionId: 's1', path: '/x', marker: 'm1', mtimeEpoch: 100 };
  const enq: RawObservationEvent[] = [];
  // now = 100s → cutoff seeded at 100; ref.mtimeEpoch (100) is NOT > cutoff → skipped
  const r = runCaptureTick({ sources: [fakeSource([ref])], state, enqueue: (e) => enq.push(e), now: () => 100_000 });
  expect(r.ingested).toBe(0);
  expect(enq).toHaveLength(0);
});

test('ingests a session newer than the cutoff, exactly once (dedup on unchanged marker)', () => {
  const state = tmpState();
  state.ensureCutoff('codex', 100); // pretend capture was enabled earlier, cutoff=100
  const ref: SessionRef = { sessionId: 's2', path: '/x', marker: 'm1', mtimeEpoch: 150 };
  const enq: RawObservationEvent[] = [];
  const tick = () => runCaptureTick({ sources: [fakeSource([ref])], state, enqueue: (e) => enq.push(e), now: () => 200_000 });

  expect(tick().ingested).toBe(1);
  expect(enq).toHaveLength(1);
  expect(enq[0]!.session_id).toBe('s2');

  // second tick, same marker → deduped
  expect(tick().ingested).toBe(0);
  expect(enq).toHaveLength(1);
});

test('a source that becomes available only on a LATER tick seeds its cutoff then — no bulk backfill', () => {
  // Regression for the boot-frozen-capture fix: sources are no longer filtered by availability at boot, so
  // a tool first used AFTER the worker started must (a) be skipped while absent, (b) seed its cutoff the
  // first tick it IS available so its pre-existing history is NOT bulk-ingested, (c) capture new sessions after.
  const state = tmpState();
  let avail = false;
  let refs: SessionRef[] = [{ sessionId: 'old', path: '/x', marker: 'm', mtimeEpoch: 100 }]; // predates the tick
  const src: CaptureSource = {
    id: 'codex', available: () => avail, enabled: () => true, discover: () => refs, extract: (r) => [ev(r.sessionId)],
  };
  const enq: RawObservationEvent[] = [];
  const tick = () => runCaptureTick({ sources: [src], state, enqueue: (e) => enq.push(e), now: () => 500_000 });

  expect(tick().ingested).toBe(0);              // absent → skipped before ensureCutoff (no cutoff seeded)
  avail = true;                                  // tool's data dir appears post-boot
  expect(tick().ingested).toBe(0);              // cutoff seeded at 500 now → pre-existing 'old' (100) skipped
  expect(enq).toHaveLength(0);
  refs = [{ sessionId: 'new', path: '/x', marker: 'm2', mtimeEpoch: 600 }]; // a session AFTER it appeared
  expect(tick().ingested).toBe(1);
  expect(enq.map((e) => e.session_id)).toEqual(['new']);
});

test('a grown session (changed marker) is re-ingested', () => {
  const state = tmpState();
  state.ensureCutoff('codex', 100);
  const enq: RawObservationEvent[] = [];
  const run = (marker: string) => runCaptureTick({
    sources: [fakeSource([{ sessionId: 's3', path: '/x', marker, mtimeEpoch: 150 }])],
    state, enqueue: (e) => enq.push(e), now: () => 200_000,
  });
  expect(run('m1').ingested).toBe(1);
  expect(run('m1').ingested).toBe(0); // unchanged
  expect(run('m2').ingested).toBe(1); // grew → re-ingested
  expect(enq).toHaveLength(2);
});
