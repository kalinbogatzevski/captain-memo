// tests/unit/shared/worker-control.test.ts — restartWorker must RECLAIM (force-stop,
// guaranteeing the process is dead) before starting, so a zombie worker (process
// alive, HTTP server dead) is replaced instead of being no-op'd by a bare start()
// under Windows Scheduled-Task MultipleInstancesPolicy=IgnoreNew (field 2026-06-01).
import { test, expect } from 'bun:test';
import { restartWorker } from '../../../src/shared/worker-control.ts';
import type { ServiceManager, StopOptions } from '../../../src/services/service-manager/types.ts';

function fakeSm() {
  const calls: string[] = [];
  const sm: ServiceManager = {
    install: async () => {},
    remove: async () => {},
    start: async (n: string) => { calls.push(`start:${n}`); },
    stop: async (n: string, o?: StopOptions) => {
      calls.push(`stop:${n}:graceful=${!!o?.graceful}:force=${!!o?.force}:port=${o?.port ?? ''}`);
    },
    restart: async (n: string, o?: StopOptions) => {
      calls.push(`restart:${n}:graceful=${!!o?.graceful}:force=${!!o?.force}:port=${o?.port ?? ''}`);
    },
    status: async () => 'running',
    isActive: async () => true,
    enable: async () => {},
    disable: async () => {},
  };
  return { sm, calls };
}

test('restartWorker delegates to sm.restart (atomic stop+start in one supervisor job)', async () => {
  const { sm, calls } = fakeSm();
  await restartWorker(sm, 'captain-memo-worker', { port: 39888 });
  expect(calls).toEqual([
    'restart:captain-memo-worker:graceful=false:force=true:port=39888',
  ]);
});

test('restartWorker defaults graceful=false (a broken worker will not answer /shutdown)', async () => {
  const { sm, calls } = fakeSm();
  await restartWorker(sm, 'captain-memo-worker', { port: 39888 });
  expect(calls[0]).toContain('graceful=false');
  expect(calls[0]).toContain('force=true');
});

test('restartWorker passes graceful=true through for a healthy-but-stale worker', async () => {
  const { sm, calls } = fakeSm();
  await restartWorker(sm, 'captain-memo-worker', { port: 39888, graceful: true });
  expect(calls).toEqual([
    'restart:captain-memo-worker:graceful=true:force=true:port=39888',
  ]);
});

test('restartWorker always demands force=true so the zombie is actually killed', async () => {
  const { sm, calls } = fakeSm();
  await restartWorker(sm, 'captain-memo-worker', { port: 39888, graceful: true });
  expect(calls[0]).toContain('force=true');
});
