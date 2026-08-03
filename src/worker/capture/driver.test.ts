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
    describe: () => '/x',
    discover: () => refs,
    extract: (ref) => [ev(ref.sessionId)],
  };
}

function tmpState(): CaptureState {
  return new CaptureState(join(mkdtempSync(join(tmpdir(), 'cm-cap-')), 'capture-state.db'));
}

test('backfill guard: first tick seeds the cutoff and ingests nothing pre-existing', async () => {
  const state = tmpState();
  const ref: SessionRef = { sessionId: 's1', path: '/x', marker: 'm1', mtimeEpoch: 100 };
  const enq: RawObservationEvent[] = [];
  // now = 100s → cutoff seeded at 100; ref.mtimeEpoch (100) is NOT > cutoff → skipped
  const r = await runCaptureTick({ sources: [fakeSource([ref])], state, enqueue: (e) => enq.push(e), now: () => 100_000 });
  expect(r.ingested).toBe(0);
  expect(enq).toHaveLength(0);
});

test('ingests a session newer than the cutoff, exactly once (dedup on unchanged marker)', async () => {
  const state = tmpState();
  state.ensureCutoff('codex', 100); // pretend capture was enabled earlier, cutoff=100
  const ref: SessionRef = { sessionId: 's2', path: '/x', marker: 'm1', mtimeEpoch: 150 };
  const enq: RawObservationEvent[] = [];
  const tick = async () => await runCaptureTick({ sources: [fakeSource([ref])], state, enqueue: (e) => enq.push(e), now: () => 200_000 });

  expect((await tick()).ingested).toBe(1);
  expect(enq).toHaveLength(1);
  expect(enq[0]!.session_id).toBe('s2');

  // second tick, same marker → deduped
  expect((await tick()).ingested).toBe(0);
  expect(enq).toHaveLength(1);
});

test('a source that becomes available only on a LATER tick seeds its cutoff then — no bulk backfill', async () => {
  // Regression for the boot-frozen-capture fix: sources are no longer filtered by availability at boot, so
  // a tool first used AFTER the worker started must (a) be skipped while absent, (b) seed its cutoff the
  // first tick it IS available so its pre-existing history is NOT bulk-ingested, (c) capture new sessions after.
  const state = tmpState();
  let avail = false;
  let refs: SessionRef[] = [{ sessionId: 'old', path: '/x', marker: 'm', mtimeEpoch: 100 }]; // predates the tick
  const src: CaptureSource = {
    id: 'codex', available: () => avail, enabled: () => true, describe: () => '/x', discover: () => refs, extract: (r) => [ev(r.sessionId)],
  };
  const enq: RawObservationEvent[] = [];
  const tick = async () => await runCaptureTick({ sources: [src], state, enqueue: (e) => enq.push(e), now: () => 500_000 });

  expect((await tick()).ingested).toBe(0);              // absent → skipped before ensureCutoff (no cutoff seeded)
  avail = true;                                  // tool's data dir appears post-boot
  expect((await tick()).ingested).toBe(0);              // cutoff seeded at 500 now → pre-existing 'old' (100) skipped
  expect(enq).toHaveLength(0);
  refs = [{ sessionId: 'new', path: '/x', marker: 'm2', mtimeEpoch: 600 }]; // a session AFTER it appeared
  expect((await tick()).ingested).toBe(1);
  expect(enq.map((e) => e.session_id)).toEqual(['new']);
});

// CONTRACT CHANGED (deliberately): a changed marker means the file is RE-EXAMINED, not that its whole
// contents are re-enqueued. This fake source returns the same single event both times — the marker moved
// but no new turn exists — so the correct outcome is now zero new events. Re-enqueuing on every marker
// change is what made a growing session cost N(N+1)/2 summarizer calls.
test('a changed marker re-examines the session but enqueues only genuinely new events', async () => {
  const state = tmpState();
  state.ensureCutoff('codex', 100);
  const enq: RawObservationEvent[] = [];
  const run = async (marker: string) => await runCaptureTick({
    sources: [fakeSource([{ sessionId: 's3', path: '/x', marker, mtimeEpoch: 150 }])],
    state, enqueue: (e) => enq.push(e), now: () => 200_000,
  });
  expect((await run('m1')).ingested).toBe(1);  // first sight: the one event is new
  expect((await run('m1')).ingested).toBe(0);  // marker unchanged → not even opened
  expect((await run('m2')).ingested).toBe(0);  // marker moved, but the file still holds that one event
  expect(enq).toHaveLength(1);         // …so it is enqueued exactly once, not once per tick
});

// QUADRATIC RE-INGEST. `marker` is `mtime:size`, so it changes on every append to a live session, and
// extract() has no cursor — it returns the WHOLE session each time. A session that grows to N turns
// therefore enqueues 1+2+…+N = N(N+1)/2 events instead of N, and every one of those is a summarizer LLM
// call. Observed on a light OSS user: codex alone at 8 950 observations (97.8% of the corpus) with
// 30 564 more queued and 12.1 M tokens distilled.
function growingSource(turnsByTick: number[]): { src: CaptureSource; tick: () => void } {
  let i = 0;
  const src: CaptureSource = {
    id: 'codex',
    available: () => true,
    enabled: () => true,
    describe: () => '/x',
    // marker changes every tick, exactly as mtime:size does when the file grows
    discover: () => [{ sessionId: 's1', path: '/x/s1.jsonl', marker: `m${i}`, mtimeEpoch: 1000 + i }],
    extract: () => Array.from({ length: turnsByTick[i]! }, () => ev('s1')),   // the WHOLE session, every time
  };
  return { src, tick: () => { i++; } };
}

test('a growing session enqueues only its NEW turns, not the whole file again', async () => {
  const state = tmpState();
  state.ensureCutoff('codex', 0);            // capture already enabled — no backfill guard
  const enqueued: RawObservationEvent[] = [];
  const { src, tick } = growingSource([2, 3, 5, 8]);

  for (let t = 0; t < 4; t++) {
    await runCaptureTick({ sources: [src], state, enqueue: (e) => enqueued.push(e), log: () => {} });
    await tick();
  }

  // 8 real turns ⇒ 8 events. The old behaviour enqueued 2+3+5+8 = 18.
  expect(enqueued.length).toBe(8);
});

test('a session REWRITTEN shorter re-ingests from scratch rather than silently skipping', async () => {
  const state = tmpState();
  state.ensureCutoff('codex', 0);
  const enqueued: RawObservationEvent[] = [];
  const { src, tick } = growingSource([5, 2]);   // truncated/rotated between ticks

  await runCaptureTick({ sources: [src], state, enqueue: (e) => enqueued.push(e), log: () => {} });
  expect(enqueued.length).toBe(5);
  await tick();
  await runCaptureTick({ sources: [src], state, enqueue: (e) => enqueued.push(e), log: () => {} });
  expect(enqueued.length).toBe(7);   // 5 + the 2 from the rewritten file, not 0
});

// The tick used to be synchronous, so a minute's worth of live session files was parsed in one
// unbroken block on the engine thread. Measured on a real install: 2,486 ms to re-extract every
// session (codex alone 1,670 ms of it), during which the worker could serve nothing — which is
// how /stats came to time out while /health answered in 1 ms. The CPU is affordable; monopolising
// the thread to spend it is not.
test('yields between sessions so a long tick cannot monopolise the engine thread', async () => {
  const state = tmpState();
  state.ensureCutoff('codex', 100);
  const refs: SessionRef[] = [
    { sessionId: 's1', path: '/x', marker: 'm1', mtimeEpoch: 200 },
    { sessionId: 's2', path: '/y', marker: 'm2', mtimeEpoch: 200 },
    { sessionId: 's3', path: '/z', marker: 'm3', mtimeEpoch: 200 },
  ];
  const order: string[] = [];
  const src: CaptureSource = {
    ...fakeSource(refs),
    extract: (ref) => { order.push(`extract:${ref.sessionId}`); return [ev(ref.sessionId)]; },
  };
  const r = await runCaptureTick({
    sources: [src], state, enqueue: () => {}, now: () => 300_000,
    yieldToLoop: async () => { order.push('yield'); },
  });
  expect(r.ingested).toBe(3);
  // A yield must fall between consecutive extracts, not merely somewhere in the tick.
  expect(order).toEqual([
    'extract:s1', 'yield',
    'extract:s2', 'yield',
    'extract:s3', 'yield',
  ]);
});

test('still works with no yieldToLoop supplied', async () => {
  const state = tmpState();
  state.ensureCutoff('codex', 100);
  const ref: SessionRef = { sessionId: 's1', path: '/x', marker: 'm1', mtimeEpoch: 200 };
  const enq: RawObservationEvent[] = [];
  const r = await runCaptureTick({
    sources: [fakeSource([ref])], state, enqueue: (e) => enq.push(e), now: () => 300_000,
  });
  expect(r.ingested).toBe(1);
  expect(enq).toHaveLength(1);
});
