// tests/unit/shared/worker-watchdog.test.ts — pure policy for the autonomous
// watchdog (a SEPARATE Scheduled Task whose 5-min trigger fires this): probe the
// worker, and if it is unreachable (dead OR zombie) reclaim+restart it under the
// shared heal lock. This is the only recovery path that survives a zombie holding
// the worker task "Running" (IgnoreNew blocks the worker task's own relaunch).
import { test, expect } from 'bun:test';
import { runWorkerWatchdog, type WatchdogDeps } from '../../../src/shared/worker-watchdog.ts';

function deps(over: Partial<WatchdogDeps> & { healthy: boolean }): WatchdogDeps & { _calls: string[] } {
  const calls: string[] = [];
  const d = {
    probeHealthy: async () => over.healthy,
    acquireLock: () => { calls.push('acquire'); return true; },
    releaseLock: () => { calls.push('release'); },
    reclaim: async () => { calls.push('reclaim'); },
    waitHealthy: async () => true,
    ...over,
    _calls: calls,
  } as WatchdogDeps & { _calls: string[] };
  return d;
}

test('worker healthy → no action, never touches the lock or reclaim', async () => {
  const d = deps({ healthy: true });
  const out = await runWorkerWatchdog(d);
  expect(out).toEqual({ action: 'none', reason: 'healthy' });
  expect(d._calls).toEqual([]);
});

test('unreachable → reclaims under the lock and reports it came back', async () => {
  const d = deps({ healthy: false });
  const out = await runWorkerWatchdog(d);
  expect(out).toMatchObject({ action: 'reclaimed', healthy: true });
  // lock acquired, reclaim run, lock released — in order.
  expect(d._calls).toEqual(['acquire', 'reclaim', 'release']);
});

test('another healer holds the lock → skipped, never reclaims', async () => {
  const d = deps({ healthy: false, acquireLock: () => false });
  const out = await runWorkerWatchdog(d);
  expect(out).toEqual({ action: 'skipped', reason: 'lock-held' });
  expect(d._calls).toEqual([]); // never reclaimed, never released a lock it didn't take
});

test('reclaim throws → failed, lock still released', async () => {
  const d = deps({ healthy: false, reclaim: async () => { throw new Error('kill boom'); } });
  const out = await runWorkerWatchdog(d);
  expect(out).toMatchObject({ action: 'failed', error: 'kill boom' });
  expect(d._calls).toEqual(['acquire', 'release']);
});

test('reclaim ran but worker still down → reclaimed with healthy:false (so the caller can log it)', async () => {
  const d = deps({ healthy: false, waitHealthy: async () => false });
  const out = await runWorkerWatchdog(d);
  expect(out).toMatchObject({ action: 'reclaimed', healthy: false });
});
