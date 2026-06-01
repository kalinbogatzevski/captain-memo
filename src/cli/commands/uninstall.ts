// captain-memo uninstall — clean removal of all installed pieces.
//
// Auto-detects user-mode and system-mode installs. Removes whichever (or both)
// it finds. Does NOT delete ~/.captain-memo (your data) by default — pass
// --purge for that.

import { existsSync, unlinkSync, lstatSync, rmSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { isWindows } from '../../shared/platform.ts';
import { WORKER_ENV_PATH, CONFIG_DIR, DATA_DIR } from '../../shared/paths.ts';
import { getServiceManager } from '../../services/service-manager/index.ts';
import { getEmbedderInstaller } from '../../services/embedder-installer/index.ts';

const WORKER_UNIT = 'captain-memo-worker.service';
const EMBED_UNIT = 'captain-memo-embed.service';

// User-mode locations
const USER_SYSTEMD_DIR = join(homedir(), '.config/systemd/user');
const USER_ETC_FILE = join(homedir(), '.config/captain-memo/worker.env');
const USER_EMBED_DIR = join(homedir(), '.captain-memo/embed');

// System-mode locations
const SYS_SYSTEMD_DIR = '/etc/systemd/system';
const SYS_ETC_DIR = '/etc/captain-memo';
const SYS_EMBED_DIR = '/opt/captain-memo-embed';

function header(s: string): void { console.log(`\n\x1b[1;36m${s}\x1b[0m\n${'─'.repeat(s.length)}`); }
function ok(s: string): void   { console.log(`  \x1b[32m✓\x1b[0m ${s}`); }
function info(s: string): void { console.log(`  ${s}`); }
function warn(s: string): void { console.log(`  \x1b[33m!\x1b[0m ${s}`); }

function realHome(): string {
  const u = process.env.SUDO_USER ?? process.env.USER ?? '';
  if (!u) return homedir();
  const r = spawnSync('getent', ['passwd', u], { encoding: 'utf-8' });
  return (r.stdout.split(':')[5] ?? homedir()).trim();
}

function detectInstalls(): { user: boolean; system: boolean } {
  return {
    user: existsSync(join(USER_SYSTEMD_DIR, WORKER_UNIT)) ||
          existsSync(join(USER_SYSTEMD_DIR, EMBED_UNIT)) ||
          existsSync(USER_EMBED_DIR),
    system: existsSync(join(SYS_SYSTEMD_DIR, WORKER_UNIT)) ||
            existsSync(join(SYS_SYSTEMD_DIR, EMBED_UNIT)) ||
            existsSync(SYS_EMBED_DIR),
  };
}

function removeUserMode(): void {
  header('Removing user-mode install');
  for (const u of [WORKER_UNIT, EMBED_UNIT]) {
    spawnSync('systemctl', ['--user', 'stop', u], { stdio: 'ignore' });
    spawnSync('systemctl', ['--user', 'disable', u], { stdio: 'ignore' });
    const path = join(USER_SYSTEMD_DIR, u);
    if (existsSync(path)) { unlinkSync(path); ok(`removed ${path}`); }
  }
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  if (existsSync(USER_ETC_FILE)) { unlinkSync(USER_ETC_FILE); ok(`removed ${USER_ETC_FILE}`); }
  if (existsSync(USER_EMBED_DIR)) { rmSync(USER_EMBED_DIR, { recursive: true, force: true }); ok(`removed ${USER_EMBED_DIR}`); }
}

function removeSystemMode(): void {
  if (process.getuid && process.getuid() !== 0) {
    warn('System-mode install detected but not running as root.');
    info('Re-running with sudo to remove it...');
    const r = spawnSync('sudo', ['-E', process.execPath, ...process.argv.slice(1), '--system-only'], { stdio: 'inherit' });
    if (r.status !== 0) warn('system-mode removal aborted');
    return;
  }
  header('Removing system-mode install');
  for (const u of [WORKER_UNIT, EMBED_UNIT]) {
    spawnSync('systemctl', ['stop', u], { stdio: 'ignore' });
    spawnSync('systemctl', ['disable', u], { stdio: 'ignore' });
    const path = join(SYS_SYSTEMD_DIR, u);
    if (existsSync(path)) { unlinkSync(path); ok(`removed ${path}`); }
  }
  spawnSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
  if (existsSync(SYS_ETC_DIR)) { rmSync(SYS_ETC_DIR, { recursive: true, force: true }); ok(`removed ${SYS_ETC_DIR}`); }
  if (existsSync(SYS_EMBED_DIR)) { rmSync(SYS_EMBED_DIR, { recursive: true, force: true }); ok(`removed ${SYS_EMBED_DIR}`); }
  spawnSync('userdel', ['captain-memo-embed'], { stdio: 'ignore' });
}

function removeCliShim(): void {
  const candidates = [
    '/usr/local/bin/captain-memo',
    join(realHome(), '.local/bin/captain-memo'),
  ];
  for (const link of candidates) {
    let exists = false;
    try { lstatSync(link); exists = true; } catch { /* not present */ }
    if (exists) {
      try { unlinkSync(link); ok(`removed CLI shim ${link}`); } catch { /* fine */ }
    }
  }
}

function removePlugin(): void {
  header('Unregistering Claude Code plugin');

  const runAsUser = (cmd: string, args: string[]) => {
    const sudoUser = process.env.SUDO_USER;
    if (sudoUser && process.getuid && process.getuid() === 0) {
      return spawnSync('sudo', ['-u', sudoUser, '-E', cmd, ...args], { stdio: 'inherit' });
    }
    return spawnSync(cmd, args, { stdio: 'inherit' });
  };

  // Capture exit codes so we don't lie with `ok(...)` if both calls fail.
  const r1 = runAsUser('claude', ['plugin', 'uninstall', 'captain-memo@captain-memo']);
  const r2 = runAsUser('claude', ['plugin', 'marketplace', 'remove', 'captain-memo']);

  // Also clean up any leftover symlink from the older install method.
  const link = join(realHome(), '.claude', 'plugins', 'captain-memo');
  let exists = false;
  try { lstatSync(link); exists = true; } catch { /* not present */ }
  if (exists) {
    try { unlinkSync(link); ok(`removed legacy symlink ${link}`); } catch { /* fine */ }
  }
  if (r1.status !== 0 && r2.status !== 0) {
    warn(`'claude plugin uninstall' AND 'marketplace remove' both failed`);
    info('Run manually: claude plugin uninstall captain-memo@captain-memo');
  } else {
    ok('plugin unregistered');
  }
}

// Windows removal — Scheduled Tasks instead of systemd, no sudo/userdel, NTFS
// CLI shim instead of a symlink. Best-effort on every step so one failure
// (e.g. a task already gone) never blocks the rest of the teardown.
async function removeWindows(purge: boolean): Promise<void> {
  const sm = getServiceManager();

  header('Removing Captain Memo (Windows)');

  // Worker Scheduled Task. remove() unregisters; tolerate "already gone".
  try { await sm.remove('captain-memo-worker'); ok('removed worker Scheduled Task'); }
  catch { warn('could not remove worker Scheduled Task (may not exist)'); }

  // Watchdog Scheduled Task (autonomous zombie recovery; installed alongside the
  // worker since v0.2.15). Tolerate "already gone" on older installs.
  try { await sm.remove('captain-memo-watchdog'); ok('removed watchdog Scheduled Task'); }
  catch { warn('could not remove watchdog Scheduled Task (may not exist)'); }

  // Embedder (local-sidecar only). Present if its task is registered or the
  // install dir survives. ServiceManager owns the task; EmbedderInstaller.remove
  // only deletes the dir — so call both.
  const embedDir = join(DATA_DIR, 'embed');
  let embedTaskPresent = false;
  try { embedTaskPresent = (await sm.status('captain-memo-embed')) !== 'not-installed'; }
  catch { /* treat as absent */ }
  if (embedTaskPresent || existsSync(embedDir)) {
    try { await sm.remove('captain-memo-embed'); ok('removed embed Scheduled Task'); }
    catch { warn('could not remove embed Scheduled Task (may not exist)'); }
    if (existsSync(embedDir)) {
      try { await getEmbedderInstaller().remove(embedDir); ok(`removed ${embedDir}`); }
      catch { warn(`could not remove ${embedDir}`); }
    }
  }

  // worker.env (API keys) and the config dir if it's now empty.
  if (existsSync(WORKER_ENV_PATH)) {
    try { unlinkSync(WORKER_ENV_PATH); ok(`removed ${WORKER_ENV_PATH}`); }
    catch { warn(`could not remove ${WORKER_ENV_PATH}`); }
  }
  if (existsSync(CONFIG_DIR)) {
    try {
      if (readdirSync(CONFIG_DIR).length === 0) { rmSync(CONFIG_DIR, { recursive: true, force: true }); ok(`removed ${CONFIG_DIR}`); }
      else info(`(left ${CONFIG_DIR} — not empty)`);
    } catch { warn(`could not inspect ${CONFIG_DIR}`); }
  }

  // CLI shim dir (%LOCALAPPDATA%\captain-memo\bin). Mirrors the install-side
  // user-writable PATH dir; we drop the whole bin folder we created.
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const shimDir = join(localAppData, 'captain-memo', 'bin');
  if (existsSync(shimDir)) {
    try { rmSync(shimDir, { recursive: true, force: true }); ok(`removed CLI shim dir ${shimDir}`); }
    catch { warn(`could not remove ${shimDir}`); }
  }

  removePlugin();

  if (purge) {
    header('Purging data');
    if (existsSync(DATA_DIR)) {
      try { rmSync(DATA_DIR, { recursive: true, force: true }); ok(`removed ${DATA_DIR}`); }
      catch { warn(`could not remove ${DATA_DIR}`); }
    }
  } else {
    info(`(your indexed data at ${DATA_DIR} is preserved; pass --purge to remove it too)`);
  }

  console.log();
  ok('Captain Memo uninstalled.');
  info('Restart any open Claude Code sessions to drop the plugin entirely.');
}

export async function uninstallCommand(args: string[]): Promise<number> {
  const purge = args.includes('--purge');
  const userOnly = args.includes('--user');
  const systemOnly = args.includes('--system') || args.includes('--system-only');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: captain-memo uninstall [--user|--system] [--purge]

Auto-detects user-mode and/or system-mode installs and removes whatever it
finds. Restrict to one with --user or --system.

Without --purge: ~/.captain-memo/ (your indexed data) is preserved.
With    --purge: also deletes ~/.captain-memo/ entirely.`);
    return 0;
  }

  // Windows has no systemd/sudo/userdel — fork to the Scheduled-Task teardown.
  // The --user/--system distinction is Linux-only (Windows is always user-scope).
  if (isWindows) {
    await removeWindows(purge);
    return 0;
  }

  const found = detectInstalls();
  if (!found.user && !found.system) {
    info('No Captain Memo install detected. Nothing to do.');
    return 0;
  }

  if (found.user && !systemOnly) removeUserMode();
  if (found.system && !userOnly) removeSystemMode();

  removeCliShim();
  removePlugin();

  if (purge) {
    header('Purging data');
    const dataDir = join(realHome(), '.captain-memo');
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
      ok(`removed ${dataDir}`);
    }
  } else {
    info(`(your indexed data at ~/.captain-memo/ is preserved; pass --purge to remove it too)`);
  }

  console.log();
  ok('Captain Memo uninstalled.');
  info('Restart any open Claude Code sessions to drop the plugin entirely.');
  return 0;
}
