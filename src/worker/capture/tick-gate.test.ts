// One capture tick at a time: the interval, the boot tick and POST /capture/backfill (index.ts) all go through this gate.
// POST /capture/backfill used to start its own tick on top of a running one, so two ticks extracted and queued the same session.
import { test, expect } from 'bun:test';
import { createTickGate } from './driver.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

test('the interval skips while a tick runs, and runs again once it is done', async () => {
  const gate = createTickGate();
  const running = deferred();
  const log: string[] = [];
  const first = gate.interval(async () => { log.push('first'); await running.promise; return 'a'; });
  expect(first).not.toBeNull();
  expect(gate.interval(async () => { log.push('second'); return 'b'; })).toBeNull();   // skipped, not queued
  expect(log).toEqual(['first']);

  running.resolve();
  expect(await first).toBe('a');
  await settle();
  expect(gate.pending()).toBeNull();
  expect(await gate.interval(async () => 'c')).toBe('c');
});

test('a backfill waits for the running interval tick instead of starting on top of it', async () => {
  const gate = createTickGate();
  const running = deferred();
  const log: string[] = [];
  const tick = gate.interval(async () => { log.push('tick:start'); await running.promise; log.push('tick:end'); });
  const backfill = gate.backfill(async () => { log.push('backfill:start'); return 'done'; });
  await settle();
  expect(log).toEqual(['tick:start']);   // the backfill has not started

  running.resolve();
  expect(await backfill).toBe('done');   // and returns its own result
  await tick;
  expect(log).toEqual(['tick:start', 'tick:end', 'backfill:start']);
});

test('while a backfill waits or runs the interval is skipped, even after the tick it waited for has finished', async () => {
  const gate = createTickGate();
  const tickDone = deferred();
  const backfillDone = deferred();
  const tick = gate.interval(async () => { await tickDone.promise; });
  const backfill = gate.backfill(async () => { await backfillDone.promise; });

  expect(gate.interval(async () => 'x')).toBeNull();   // a backfill is queued behind the tick
  tickDone.resolve();
  await tick;
  await settle();                                      // the tick is over; the backfill is running
  expect(gate.interval(async () => 'x')).toBeNull();   // the older tick finishing must not free the gate the backfill holds
  expect(gate.pending()).not.toBeNull();

  backfillDone.resolve();
  await backfill;
  await settle();
  expect(gate.pending()).toBeNull();
  expect(await gate.interval(async () => 'free')).toBe('free');
});

test('two backfills run one after the other, in the order they were asked', async () => {
  const gate = createTickGate();
  const firstDone = deferred();
  const log: string[] = [];
  const one = gate.backfill(async () => { log.push('one:start'); await firstDone.promise; log.push('one:end'); });
  const two = gate.backfill(async () => { log.push('two:start'); log.push('two:end'); });
  await settle();
  expect(log).toEqual(['one:start']);
  firstDone.resolve();
  await Promise.all([one, two]);
  expect(log).toEqual(['one:start', 'one:end', 'two:start', 'two:end']);
});

test('a backfill that throws reaches its caller and does not wedge the gate', async () => {
  const gate = createTickGate();
  await expect(gate.backfill(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  await settle();
  expect(gate.pending()).toBeNull();
  expect(await gate.interval(async () => 'next')).toBe('next');
  await expect(gate.backfill(async () => 'after')).resolves.toBe('after');
});
