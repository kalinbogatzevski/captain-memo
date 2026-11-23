import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientCeilingMs, CLIENT_READ_CEILING_MS, IN_FLIGHT_ON_TIMEOUT, inFlightHint, LONG_WRITE_DEADLINE_MS, LONG_WRITE_PATHS, REMEMBER_DEADLINE_MS } from '../../src/shared/worker-deadlines.ts';
import { callWorker, resetHealthCache, type WorkerCallError } from '../../src/shared/worker-call.ts';

test('the paths whose work survives a thread-RPC timeout are exactly the five writes with a CLI arm', () => {
  // Adding a path here means its callers' handling of the 202 in the same change (worker-deadlines.ts says which).
  expect([...IN_FLIGHT_ON_TIMEOUT].sort()).toEqual(['/capture/backfill', '/consolidate', '/promote/slice', '/reindex', '/remember']);
});

test('each in-flight path names ITS OWN check: nobody is sent to search_memory for a reindex or a pass', () => {
  expect(inFlightHint('/remember')).toMatch(/search_memory/);
  expect(inFlightHint('/reindex')).toMatch(/no progress readout/);
  expect(inFlightHint('/consolidate')).toMatch(/Housekeeping/);
  expect(inFlightHint('/promote/slice')).toMatch(/promote --report/);
  expect(inFlightHint('/capture/backfill')).toMatch(/capture status/);
  for (const p of ['/reindex', '/consolidate', '/promote/slice', '/capture/backfill']) expect(inFlightHint(p)).not.toMatch(/search_memory/);
  for (const p of IN_FLIGHT_ON_TIMEOUT) {
    expect(inFlightHint(p)).toMatch(/^Do NOT/);
    expect(inFlightHint(p)).not.toMatch(/—|failed|captain-memo status/);
  }
  expect(inFlightHint('http://127.0.0.1:39888/reindex?x=1')).toBe(inFlightHint('/reindex'));   // threaded-main passes the wire URL
});

test('threaded-main uses the shared set and its 202 carries the per-path hint (source pin: the worker is not booted here)', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/worker/threaded-main.ts'), 'utf8');
  expect(src).toMatch(/import \{ IN_FLIGHT_ON_TIMEOUT, inFlightHint, LONG_WRITE_DEADLINE_MS, LONG_WRITE_PATHS, REMEMBER_DEADLINE_MS, REMEMBER_PATHS, REQUEST_DEADLINE_MS \} from '\.\.\/shared\/worker-deadlines\.ts'/);
  expect(src).not.toMatch(/const (IN_FLIGHT_ON_TIMEOUT|LONG_WRITE_PATHS|REMEMBER_DEADLINE_MS|LONG_WRITE_DEADLINE_MS)\b/);   // one copy the clients share, not a local one that drifts
  expect(LONG_WRITE_PATHS.has('/capture/backfill')).toBe(true);   // #1011: the long writer deadline too, not only the 202
  const at = src.indexOf("status: 'write_in_flight'");
  expect(src.slice(at, at + 700)).toContain('hint: inFlightHint(wire.url)');
});

test('the client ceiling for a route is the worker\'s own ceiling for it plus a margin', () => {
  expect(clientCeilingMs('/reindex')).toBeGreaterThan(LONG_WRITE_DEADLINE_MS);
  expect(clientCeilingMs('/capture/backfill?x=1')).toBe(clientCeilingMs('/reindex'));
  expect(clientCeilingMs('/remember')).toBeGreaterThan(REMEMBER_DEADLINE_MS);
  expect(clientCeilingMs('/search/all')).toBe(CLIENT_READ_CEILING_MS);
});

test('callWorker: nothing listening => unreachable; a timed-out in-flight write is UNCONFIRMED, a timed-out read is a timeout', async () => {
  resetHealthCache();
  const probe = Bun.serve({ port: 0, fetch: () => new Response('x') }); const freePort = probe.port ?? 0; probe.stop(true);
  const dead = await callWorker(`http://127.0.0.1:${freePort}`, '/stats', {}, { preflightTimeoutMs: 500 }).catch((e) => e);
  expect((dead as WorkerCallError).kind).toBe('unreachable');
  expect((dead as WorkerCallError).message).toMatch(/nothing listening/);

  resetHealthCache();
  const slow = Bun.serve({ port: 0, fetch: (req) => new URL(req.url).pathname === '/health' ? Response.json({ healthy: true }) : new Promise<Response>(() => { /* never */ }) });
  const base = `http://127.0.0.1:${slow.port ?? 0}`;
  try {
    const w = await callWorker(base, '/remember', { method: 'POST', body: '{}' }, { ceilingMs: 300 }).catch((e) => e);
    expect((w as WorkerCallError).kind).toBe('unconfirmed');
    expect((w as WorkerCallError).message).toContain(inFlightHint('/remember'));
    expect((w as WorkerCallError).message).toMatch(/UNCONFIRMED, not failed/);
    const r = await callWorker(base, '/search/memory', { method: 'POST', body: '{}' }, { ceilingMs: 300 }).catch((e) => e);
    expect((r as WorkerCallError).kind).toBe('timeout');
    expect((await callWorker(base, '/health', {}, { ceilingMs: 1000 })).ok).toBe(true);
  } finally { slow.stop(true); }
});

test('callWorker: a listener that accepts and never answers /health fails the preflight in its bound, not the route ceiling', async () => {
  resetHealthCache();
  const hung = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => { /* never */ }) });
  try {
    const t0 = Date.now();
    const e = await callWorker(`http://127.0.0.1:${hung.port ?? 0}`, '/reindex', { method: 'POST', body: '{}' }, { preflightTimeoutMs: 300 }).catch((x) => x);
    expect((e as WorkerCallError).kind).toBe('unreachable');
    expect((e as WorkerCallError).message).toMatch(/does not answer/);
    expect(Date.now() - t0).toBeLessThan(3_000);   // not the 30 min reindex ceiling
  } finally { hung.stop(true); }
});

test('callWorker: a degraded (503) worker still takes calls: it answers, it is not an orphan', async () => {
  resetHealthCache();
  const s = Bun.serve({ port: 0, fetch: (req) => new URL(req.url).pathname === '/health' ? Response.json({ healthy: false }, { status: 503 }) : Response.json({ ok: 1 }) });
  try {
    const res = await callWorker(`http://127.0.0.1:${s.port ?? 0}`, '/stats', {}, { ceilingMs: 1000 });
    expect(await res.json()).toEqual({ ok: 1 });
  } finally { s.stop(true); }
});
