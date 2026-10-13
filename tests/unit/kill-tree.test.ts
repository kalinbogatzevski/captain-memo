// tests/unit/kill-tree.test.ts
//
// Killing a subprocess must take its DESCENDANTS with it. On win32 Bun.spawn puts the child in a
// kill-on-close job, but that job covers the DIRECT child only: a shim (Git\cmd\git.exe, an npm .cmd)
// spawns the real program as a grandchild, which survives proc.kill() holding whatever handles it
// inherited — in one field case that was the worker's listen socket, and the worker wedged for hours.
// taskkill /T is the tree kill Windows offers; POSIX gets SIGKILL (or a process-group kill when the
// child was spawned detached).
import { test, expect } from 'bun:test';
import { killTree, killTreeArgv } from '../../src/shared/kill-tree.ts';

function fake(): { calls: unknown[]; spawnSync: (argv: string[], opts: unknown) => { exitCode: number }; kill: (pid: number, sig: string | number) => void; killed: [number, string | number][] } {
  const calls: unknown[] = []; const killed: [number, string | number][] = [];
  return {
    calls, killed,
    spawnSync: (argv, opts) => { calls.push([argv, opts]); return { exitCode: 128 }; },   // 128: "process not found" — must be tolerated
    kill: (pid, sig) => { killed.push([pid, sig]); },
  };
}

test('win32: taskkill /PID <pid> /T /F, hidden, and a "not found" exit is fine', () => {
  const f = fake();
  const r = killTree({ pid: 4242 }, { platform: 'win32', spawnSync: f.spawnSync, kill: f.kill });
  expect(r).toBe(true);
  expect(f.calls).toHaveLength(1);
  const [argv, opts] = f.calls[0] as [string[], Record<string, unknown>];
  expect(argv).toEqual(['taskkill', '/PID', '4242', '/T', '/F']);
  expect(opts.windowsHide).toBe(true);
  expect(f.killed).toHaveLength(0);
  expect(killTreeArgv(7)).toEqual(['taskkill', '/PID', '7', '/T', '/F']);
});

test('posix: SIGKILL the child; the process GROUP when it was spawned detached', () => {
  const f = fake();
  expect(killTree({ pid: 55 }, { platform: 'linux', spawnSync: f.spawnSync, kill: f.kill })).toBe(true);
  expect(f.killed).toEqual([[55, 'SIGKILL']]);
  expect(f.calls).toHaveLength(0);
  const g = fake();
  killTree({ pid: 56, detached: true }, { platform: 'darwin', spawnSync: g.spawnSync, kill: g.kill });
  expect(g.killed).toEqual([[-56, 'SIGKILL']]);
});

test('never throws: a dead pid, a throwing kill, no pid at all', () => {
  const f = fake();
  expect(killTree({ pid: 1 }, { platform: 'linux', spawnSync: f.spawnSync, kill: () => { throw new Error('ESRCH'); } })).toBe(false);
  expect(killTree({ pid: undefined as unknown as number }, { platform: 'win32', spawnSync: f.spawnSync, kill: f.kill })).toBe(false);
  expect(killTree({ pid: 3 }, { platform: 'win32', spawnSync: () => { throw new Error('no taskkill'); }, kill: f.kill })).toBe(false);
});
