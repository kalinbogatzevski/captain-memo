// tests/unit/shared/worker-health.test.ts
import { test, expect } from 'bun:test';
import { ensureWorkerHealthy, type EnsureDeps } from '../../../src/shared/worker-health.ts';

function deps(over: Partial<EnsureDeps> & { version: string | null }): EnsureDeps & { _calls: string[] } {
  const calls: string[] = [];
  const d = {
    diskVersion: '0.2.14',
    probeVersion: async () => over.version,
    acquireLock: () => true,
    releaseLock: () => { calls.push('release'); },
    start: async () => { calls.push('start'); },
    restart: async () => { calls.push('restart'); },
    waitHealthy: async () => true,
    ...over,
    _calls: calls,
  } as EnsureDeps & { _calls: string[] };
  return d;
}

test('healthy + current → no action', async () => {
  const d = deps({ version: '0.2.14' });
  const out = await ensureWorkerHealthy(d);
  expect(out.action).toBe('none');
  expect(d._calls).toEqual([]);
});

test('unreachable → starts the worker', async () => {
  const d = deps({ version: null });
  const out = await ensureWorkerHealthy(d);
  expect(out).toMatchObject({ action: 'started', reason: 'unreachable', healthy: true });
  expect(d._calls).toEqual(['start', 'release']);
});

test('stale → graceful restart', async () => {
  const d = deps({ version: '0.2.0' });
  const out = await ensureWorkerHealthy(d);
  expect(out).toMatchObject({ action: 'restarted', reason: 'stale', fromVersion: '0.2.0', toVersion: '0.2.14' });
  expect(d._calls).toEqual(['restart', 'release']);
});

test('lock held by another session → skipped, no start/restart', async () => {
  const d = deps({ version: null, acquireLock: () => false });
  const out = await ensureWorkerHealthy(d);
  expect(out).toMatchObject({ action: 'skipped', reason: 'lock-held' });
  expect(d._calls).toEqual([]); // never touched start/restart/release
});

test('start failure is reported, lock still released', async () => {
  const d = deps({ version: null, start: async () => { throw new Error('no systemctl'); } });
  const out = await ensureWorkerHealthy(d);
  expect(out).toMatchObject({ action: 'failed', reason: 'unreachable' });
  expect(d._calls).toEqual(['release']);
});
