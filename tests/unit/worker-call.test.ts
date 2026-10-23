import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IN_FLIGHT_ON_TIMEOUT, inFlightHint } from '../../src/shared/worker-deadlines.ts';

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
  expect(src).toContain("import { IN_FLIGHT_ON_TIMEOUT, inFlightHint } from '../shared/worker-deadlines.ts'");
  expect(src).not.toMatch(/const IN_FLIGHT_ON_TIMEOUT/);          // one set, not a local copy that can drift from the CLI's
  expect(src).toMatch(/const LONG_WRITE_PATHS = new Set\(\[[^\]]*'\/capture\/backfill'/);   // #1011: the long writer deadline too, not only the 202
  const at = src.indexOf("status: 'write_in_flight'");
  expect(src.slice(at, at + 700)).toContain('hint: inFlightHint(wire.url)');
});
