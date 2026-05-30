// src/shared/platform.ts — tiny cross-platform probes.
//
// This is the "C" half of the B+C design: trivial OS facts that don't warrant a
// full interface live here as plain helpers. The heavy, multi-step divergences
// (service supervision, embedder install) get real interfaces instead — see
// src/services/service-manager and src/services/embedder-installer.
import os from 'os';

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
