// src/shared/platform.ts — tiny cross-platform probes.
//
// This is the "C" half of the B+C design: trivial OS facts that don't warrant a
// full interface live here as plain helpers. The heavy, multi-step divergences
// (service supervision, embedder install) get real interfaces instead — see
// src/services/service-manager and src/services/embedder-installer.
import os from 'os';
import { spawnSync } from 'child_process';

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

/** Total physical RAM in GiB. */
export function totalMemGb(): number {
  return os.totalmem() / 2 ** 30;
}

/** Logical CPU count. */
export function cpuCount(): number {
  return os.cpus().length;
}

/** Free disk space at `path` in GiB. Best-effort: returns Infinity when the
 *  platform/runtime can't answer, so callers treat it as "skip the check"
 *  rather than failing a hosted install that never touches local disk. */
export async function diskFreeGb(path: string): Promise<number> {
  try {
    const { statfs } = await import('fs');
    return await new Promise<number>((resolve) => {
      // statfs is available in Node ≥18.15 and Bun. bavail/bsize are POSIX-ish
      // but Bun also fills them on Windows.
      (statfs as unknown as (p: string, cb: (e: unknown, s: { bavail: number; bsize: number }) => void) => void)(
        path,
        (err, stats) => {
          if (err || !stats) return resolve(Infinity);
          resolve((stats.bavail * stats.bsize) / 2 ** 30);
        },
      );
    });
  } catch {
    return Infinity;
  }
}

/** Absolute path to the Bun executable to bake into a service definition.
 *  process.execPath is the exact Bun currently running (most reliable for a
 *  Scheduled Task / systemd unit); Bun.which is the PATH fallback. */
export function whichBun(): string {
  const bun = (globalThis as { Bun?: { which?: (cmd: string) => string | null } }).Bun;
  return bun?.which?.('bun') ?? process.execPath;
}

/**
 * Home directory of a named user, without assuming `getent`.
 *
 * `getent` is a glibc tool. macOS has no usable one (there is a shell shim, but it does
 * not answer `passwd`), so `getent passwd $USER` returned empty there and the install
 * wizard resolved every path against "" — reported from the field on macOS 2026-07-28.
 *
 * The subprocess is only ever needed to resolve a DIFFERENT user than the one running
 * (the `sudo` install case, where SUDO_USER names the real owner). For the current user
 * the runtime already knows the answer, so the common path shells out to nothing at all.
 */
export function homeOf(user?: string): string {
  const me = (() => { try { return os.userInfo().username; } catch { return process.env.USER ?? ''; } })();
  if (!user || user === me) return os.homedir();

  // Another user: ask the platform's directory service.
  if (isMac) {
    // dscl is the macOS equivalent; output is "NFSHomeDirectory: /Users/name".
    const r = spawnSync('dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], { encoding: 'utf-8' });
    const home = r.status === 0 ? (r.stdout.split(':')[1] ?? '').trim() : '';
    return home || `/Users/${user}`;
  }
  if (!isWindows) {
    const r = spawnSync('getent', ['passwd', user], { encoding: 'utf-8' });
    const home = r.status === 0 ? (r.stdout.split(':')[5] ?? '').trim() : '';
    if (home) return home;
    // getent absent or the user is not in passwd (LDAP misconfig, container): the
    // conventional layout beats returning an empty string that silently poisons paths.
    return `/home/${user}`;
  }
  return os.homedir();
}
