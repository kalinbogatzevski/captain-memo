// src/shared/worker-env.ts — in-process loader for worker.env.
//
// On Linux the systemd unit injects worker.env via `EnvironmentFile=`. There is
// no equivalent on Windows (Scheduled Task) or macOS (launchd plists are awkward
// for secrets), so the daemon must load it itself. Calling loadWorkerEnv() at the
// top of the worker / MCP / CLI bootstrap makes secrets reach the process on EVERY
// platform, and de-risks the eventual macOS port for free.
import { existsSync, readFileSync } from 'fs';
import { WORKER_ENV_PATH } from './paths.ts';

/** Candidate worker.env locations, in precedence order (first existing wins per key,
 *  but every file is read so a later file can supply keys an earlier one omitted). */
export function workerEnvPaths(): string[] {
  const paths = [WORKER_ENV_PATH];
  // System-mode install location (Linux only — there is no /etc on Windows).
  if (process.platform !== 'win32') paths.push('/etc/captain-memo/worker.env');
  return paths;
}

/** Primary worker.env path (CONFIG_DIR/worker.env). */
export function workerEnvPath(): string {
  return WORKER_ENV_PATH;
}

/**
 * Parse systemd-EnvironmentFile-style `KEY=VALUE` files and seed process.env.
 *
 * Rules:
 *  - Blank lines and `#` comments are ignored.
 *  - Surrounding single/double quotes on the value are stripped.
 *  - A variable already present in process.env is NEVER overwritten, so an
 *    explicit shell `export`, a systemd `EnvironmentFile`, or a parent process's
 *    environment always take precedence over the file. This makes the call safe
 *    to run unconditionally on all platforms (a no-op where systemd already set it).
 *
 * Idempotent.
 */
export function loadWorkerEnv(): void {
  for (const p of workerEnvPaths()) {
    if (!existsSync(p)) continue;
    let text: string;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue; // unreadable (perms) — skip rather than crash the daemon
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!key || key in process.env) continue;
      let val = line.slice(eq + 1).trim();
      if (
        val.length >= 2 &&
        ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}
