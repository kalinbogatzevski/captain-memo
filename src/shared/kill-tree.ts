// src/shared/kill-tree.ts — kill a subprocess AND its descendants.
//
// Why a tree kill, not proc.kill(): on win32 Bun.spawn puts the child in a kill-on-close job, but that
// job covers the DIRECT child only. A shim (Git\cmd\git.exe, an npm .cmd) spawns the real program as a
// grandchild, which survives proc.kill() holding whatever handles it inherited. In one field case a
// `git fetch` that had blocked on Git Credential Manager's hidden GUI left git.exe alive after the
// worker was killed, still holding the worker's listen socket: the kernel accepted connections nobody
// served and the worker wedged for hours. taskkill /T is the tree kill Windows offers; POSIX gets
// SIGKILL, or a process-group kill when the child was spawned detached.
//
// Never throws, never awaits: callers use it from timeout handlers.
import { spawnSync as nodeSpawnSync } from 'node:child_process';

export interface KillTreeDeps {
  platform?: NodeJS.Platform;
  spawnSync?: (argv: string[], opts: { stdio: 'ignore'; windowsHide: boolean; timeout: number }) => { exitCode?: number | null; status?: number | null };
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
}

/** The exact argv used on win32 — exported so tests pin it. */
export function killTreeArgv(pid: number): string[] {
  return ['taskkill', '/PID', String(pid), '/T', '/F'];
}

/** Returns true when a kill was issued (not whether anything died: a tree that already exited is fine). */
export function killTree(proc: { pid?: number; detached?: boolean }, deps: KillTreeDeps = {}): boolean {
  const pid = proc?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === 'win32') {
      const spawnSync = deps.spawnSync ?? ((argv, opts) => nodeSpawnSync(argv[0]!, argv.slice(1), opts));
      // A nonzero exit ("process not found") means the tree is already gone — that is success too.
      spawnSync(killTreeArgv(pid), { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
      return true;
    }
    const kill = deps.kill ?? ((p, s) => process.kill(p, s));
    // A detached child leads its own process group: a negative pid signals the whole group.
    kill(proc.detached ? -pid : pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}
