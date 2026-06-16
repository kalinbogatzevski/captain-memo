import { test, expect } from 'bun:test';
import { restartCommand } from './restart.ts';
import type { ServiceManager } from '../../services/service-manager/types.ts';

function fakeSm() {
  const calls: Array<{ name: string; opts: unknown }> = [];
  const sm = {
    restart: async (name: string, opts: unknown) => { calls.push({ name, opts }); },
  } as unknown as ServiceManager;
  return { sm, calls };
}

test('default restart -> restartWorker with graceful=true, force=true; healthy -> 0', async () => {
  const { sm, calls } = fakeSm();
  const code = await restartCommand([], { sm, port: 39888, probe: async () => true, sleep: async () => {}, now: () => 0 });
  expect(code).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.name).toBe('captain-memo-worker');
  expect(calls[0]!.opts).toEqual({ graceful: true, port: 39888, force: true });
});

test('--force -> graceful=false', async () => {
  const { sm, calls } = fakeSm();
  const code = await restartCommand(['--force'], { sm, port: 39888, probe: async () => true, sleep: async () => {}, now: () => 0 });
  expect(code).toBe(0);
  expect(calls[0]!.opts).toEqual({ graceful: false, port: 39888, force: true });
});

test('never healthy -> returns 1', async () => {
  const { sm } = fakeSm();
  let t = 0;
  const code = await restartCommand([], { sm, port: 39888, probe: async () => false, sleep: async () => {}, now: () => { t += 5000; return t; } });
  expect(code).toBe(1);
});
