// probeWorkerAlive — what the UserPromptSubmit self-heal asks before a destructive reclaim. /health answers 503
// while the writer thread's heartbeat is >5 s old, which is a BUSY worker (2026-10-13: 13 stalls in 8 minutes,
// longest 16 s); the old probe read that 503 as "down", restarted a live worker, and the restart re-opened the
// startup indexing burst that stalls it again.
import { test, expect } from 'bun:test';
import { probeWorkerAlive, WORKER_WEDGED_AFTER_MS } from '../../src/shared/worker-health-probe.ts';
import { healthFromHeartbeat } from '../../src/worker/health-heartbeat.ts';

function fakeHealth(res: () => Response) {
  return Bun.serve({ port: 0, fetch: () => res() });
}
// The 503 body exactly as the worker builds it (threaded-main.ts /health), so a change to the degraded text is caught here.
function stalledFor(ms: number, instance: unknown = 4242) {
  const v = healthFromHeartbeat({ lastBeatMs: 1_000_000, busyOp: 'http /observation/enqueue' }, 1_000_000 + ms);
  return Response.json({ healthy: false, degraded: v.degraded, instance }, { status: 503 });
}

test('a serving worker is alive', async () => {
  const srv = fakeHealth(() => Response.json({ healthy: true, instance: 1 }));
  try { expect(await probeWorkerAlive(srv.port!, 1000)).toBe(true); } finally { srv.stop(true); }
});

test('a busy worker (503, writer stalled 5.6 s) is alive: it must not be restarted', async () => {
  const srv = fakeHealth(() => stalledFor(5_591));
  try { expect(await probeWorkerAlive(srv.port!, 1000)).toBe(true); } finally { srv.stop(true); }
});

test('the longest stall seen in the field (63.5 s) is still alive', async () => {
  const srv = fakeHealth(() => stalledFor(63_500));
  try { expect(await probeWorkerAlive(srv.port!, 1000)).toBe(true); } finally { srv.stop(true); }
});

test('an engine unresponsive past the wedge limit is not alive: reclaim as before', async () => {
  const srv = fakeHealth(() => stalledFor(WORKER_WEDGED_AFTER_MS + 1));
  try { expect(await probeWorkerAlive(srv.port!, 1000)).toBe(false); } finally { srv.stop(true); }
});

test('a 503 with no `instance` (older worker, or not ours) is not called alive', async () => {
  const srv = fakeHealth(() => Response.json({ healthy: false, degraded: 'engine unresponsive 6000ms (idle)' }, { status: 503 }));
  try { expect(await probeWorkerAlive(srv.port!, 1000)).toBe(false); } finally { srv.stop(true); }
});

test('nothing listening is not alive', async () => {
  const srv = Bun.serve({ port: 0, fetch: () => new Response('') }); const port = srv.port!; srv.stop(true);
  expect(await probeWorkerAlive(port, 500)).toBe(false);
});
