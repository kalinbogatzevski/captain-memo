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

// Every test pins `readInstance`. Unpinned it really fetches 127.0.0.1:<port>/stats, so the suite
// would probe — and judge — whatever worker happens to be live on the dev box running it.

test('default restart -> restartWorker with graceful=true, force=true; healthy -> 0', async () => {
  const { sm, calls } = fakeSm();
  const code = await restartCommand([], { sm, port: 39888, readInstance: async () => null, probe: async () => true, sleep: async () => {}, now: () => 0 });
  expect(code).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.name).toBe('captain-memo-worker');
  expect(calls[0]!.opts).toEqual({ graceful: true, port: 39888, force: true });
});

test('--force -> graceful=false', async () => {
  const { sm, calls } = fakeSm();
  const code = await restartCommand(['--force'], { sm, port: 39888, readInstance: async () => null, probe: async () => true, sleep: async () => {}, now: () => 0 });
  expect(code).toBe(0);
  expect(calls[0]!.opts).toEqual({ graceful: false, port: 39888, force: true });
});

test('never healthy -> returns 1', async () => {
  const { sm } = fakeSm();
  let t = 0;
  const code = await restartCommand([], { sm, port: 39888, readInstance: async () => null, probe: async () => false, sleep: async () => {}, now: () => { t += 5000; return t; } });
  expect(code).toBe(1);
});

// ─── A RESTART MUST CONFIRM A NEW PROCESS, NOT A REACHABLE ONE ───────────────────────────────
// REGRESSION: the poll accepted any `/health` 200, but `/health` answers {healthy:true} from ANY
// live process and carries no identity. An outgoing worker that has not finished exiting is
// therefore indistinguishable from a restarted one, and the command would print
// "✓ worker is healthy" and exit 0 over a restart that then failed — a green line above a dead
// service, which is the shape that hides an outage. Comparing `worker.started_at_epoch` removes the
// ambiguity rather than narrowing the race.
test('a still-listening OLD worker is not mistaken for a restarted one', async () => {
  const { sm } = fakeSm();
  let t = 0;
  const code = await restartCommand([], {
    sm, port: 39888,
    readInstance: async () => 1000,   // same stamp throughout — the old process never went away
    probe: async () => true,          // …and it answers /health perfectly happily
    sleep: async () => {}, now: () => { t += 5000; return t; },
  });
  expect(code).toBe(1);
});

test('a NEW instance stamp is what counts as restarted', async () => {
  const { sm } = fakeSm();
  let t = 0, n = 0;
  const code = await restartCommand([], {
    sm, port: 39888,
    // call 1 is the pre-restart read, call 2 is the old worker still up, call 3 is the new one.
    readInstance: async () => (++n <= 2 ? 1000 : 2000),
    probe: async () => false,
    sleep: async () => {}, now: () => { t += 1000; return t; },
  });
  expect(code).toBe(0);
});

test('with nothing running beforehand, any healthy worker counts', async () => {
  const { sm } = fakeSm();
  let t = 0;
  const code = await restartCommand([], {
    sm, port: 39888,
    readInstance: async () => null,   // /stats never answers (cold start, or still warming up)
    probe: async () => true,          // but /health does, and there is no old instance to confuse
    sleep: async () => {}, now: () => { t += 1000; return t; },
  });
  expect(code).toBe(0);
});
