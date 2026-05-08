// captain-memo uninstall — clean removal of all installed pieces.
//
// Auto-detects user-mode and system-mode installs. Removes whichever (or both)
// it finds. Does NOT delete ~/.captain-memo (your data) by default — pass
// --purge for that.

import { existsSync, unlinkSync, lstatSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

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

function removePlugin(): void {
  header('Unregistering Claude Code plugin');
  const link = join(realHome(), '.claude', 'plugins', 'captain-memo');
  let exists = false;
  try { lstatSync(link); exists = true; } catch { /* not present */ }
  if (exists) {
    try {
      unlinkSync(link);
      ok(`removed ${link}`);
    } catch (e) {
      warn(`could not remove ${link}: ${(e as Error).message}`);
    }
  } else {
    info(`(no plugin symlink found at ${link})`);
  }
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

  const found = detectInstalls();
  if (!found.user && !found.system) {
    info('No Captain Memo install detected. Nothing to do.');
    return 0;
  }

  if (found.user && !systemOnly) removeUserMode();
  if (found.system && !userOnly) removeSystemMode();

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
