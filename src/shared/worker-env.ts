// src/shared/worker-env.ts — in-process loader for worker.env.
//
// On Linux the systemd unit injects worker.env via `EnvironmentFile=`. There is
// no equivalent on Windows (Scheduled Task) or macOS (launchd plists are awkward
// for secrets), so the daemon must load it itself. Calling loadWorkerEnv() at the
// top of the worker / MCP / CLI bootstrap makes secrets reach the process on EVERY
// platform, and de-risks the eventual macOS port for free.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, chmodSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname } from 'path';
import { WORKER_ENV_PATH } from './paths.ts';

/** Candidate worker.env locations, in precedence order (first existing wins per key,
 *  but every file is read so a later file can supply keys an earlier one omitted). */
/** worker.env holds the user's API keys and settings; nothing that rewrites or removes it may lose them.
 *  A single rolling copy beside the file: `uninstall` keeps it, `install` restores from it when the
 *  file itself is gone (so a re-install after an uninstall asks no questions), and every rewrite
 *  copies first. One `.bak`, overwritten each time: the last good state, not a history. */
export function workerEnvBackupPath(path: string = WORKER_ENV_PATH): string { return path + '.bak'; }

/** Owner-only on the file that holds the keys: 0600 on POSIX; on Windows, where a mode is meaningless,
 *  strip the inherited NTFS ACL and grant the current user alone (the same icacls lock the installer
 *  puts on worker.env). Best-effort: a failed lock never fails the copy that protects the settings. */
export function lockWorkerEnvFile(path: string): boolean {
  try {
    if (process.platform === 'win32') {
      const user = process.env.USERNAME ?? process.env.USER ?? '';
      if (!user) return false;
      return spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' }).status === 0;
    }
    chmodSync(path, 0o600);
    return true;
  } catch { return false; }
}

/** Copy the live file to its `.bak` (no-op when there is nothing to copy). Returns the backup path or null. */
export function backupWorkerEnv(path: string = WORKER_ENV_PATH): string | null {
  if (!existsSync(path)) return null;
  const bak = workerEnvBackupPath(path);
  copyFileSync(path, bak);
  lockWorkerEnvFile(bak);
  return bak;
}

/** Move the live file to its `.bak` (uninstall: the settings leave with the service, but not for good). A
 *  rename keeps the file's own permissions, so the lock the installer applied travels with it. */
export function retireWorkerEnv(path: string = WORKER_ENV_PATH): string | null {
  if (!existsSync(path)) return null;
  const bak = workerEnvBackupPath(path);
  renameSync(path, bak);
  return bak;
}

/** When the live file is missing but a `.bak` exists, bring it back. Returns the backup it came from, or null. */
export function restoreWorkerEnvBackup(path: string = WORKER_ENV_PATH): string | null {
  const bak = workerEnvBackupPath(path);
  if (existsSync(path) || !existsSync(bak)) return null;
  copyFileSync(bak, path);
  lockWorkerEnvFile(path);
  return bak;
}

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
 * Upsert a single `KEY=VALUE` line in the primary worker.env (CONFIG_DIR/worker.env),
 * preserving every other line. Rewrites the key in place if present, appends otherwise.
 * Creates the file (and its dir) when missing. Used by `reindex --redim` to persist the
 * new embedding dimension before restarting the worker.
 */
export function setWorkerEnvVar(key: string, value: string, path: string = workerEnvPath()): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const entry = `${key}=${value}`;
  const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = entry;
  else {
    // Drop a single trailing empty line before appending so we don't accrete blanks.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push(entry);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n');
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
