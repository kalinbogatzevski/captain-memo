// captain-memo uninstall — clean removal of all installed pieces.
//
// Stops + removes systemd units, /etc/captain-memo, ~/.claude/plugins/captain-memo
// symlink, and the captain-memo-embed user. Does NOT delete ~/.captain-memo
// (your data) by default — pass --purge for that.

import { existsSync, unlinkSync, lstatSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

const ETC_DIR = '/etc/captain-memo';
const SYSTEMD_DIR = '/etc/systemd/system';
const WORKER_UNIT = 'captain-memo-worker.service';
const EMBED_UNIT = 'captain-memo-embed.service';

function header(s: string): void { console.log(`\n\x1b[1;36m${s}\x1b[0m\n${'─'.repeat(s.length)}`); }
function ok(s: string): void   { console.log(`  \x1b[32m✓\x1b[0m ${s}`); }
function info(s: string): void { console.log(`  ${s}`); }
function warn(s: string): void { console.log(`  \x1b[33m!\x1b[0m ${s}`); }

function ensureSudo(): void {
  if (process.getuid && process.getuid() === 0) return;
  console.log();
  warn('Re-running with sudo (needed to stop systemd units and remove /etc/captain-memo)...');
  const r = spawnSync('sudo', ['-E', process.execPath, ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function realHome(): string {
  const u = process.env.SUDO_USER ?? process.env.USER ?? '';
  if (!u) return homedir();
  const r = spawnSync('getent', ['passwd', u], { encoding: 'utf-8' });
  return (r.stdout.split(':')[5] ?? homedir()).trim();
}

export async function uninstallCommand(args: string[]): Promise<number> {
  const purge = args.includes('--purge');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: captain-memo uninstall [--purge]

Stops and removes:
  - captain-memo-worker.service (systemd)
  - captain-memo-embed.service  (systemd) + /opt/captain-memo-embed
  - /etc/captain-memo/
  - ~/.claude/plugins/captain-memo symlink
  - captain-memo-embed system user

Without --purge: leaves ~/.captain-memo/ (your indexed data) intact.
With    --purge: also deletes ~/.captain-memo/ entirely.`);
    return 0;
  }

  ensureSudo();

  // 1. worker service
  header('Stopping worker service');
  spawnSync('systemctl', ['stop', WORKER_UNIT], { stdio: 'inherit' });
  spawnSync('systemctl', ['disable', WORKER_UNIT], { stdio: 'inherit' });
  const wUnit = join(SYSTEMD_DIR, WORKER_UNIT);
  if (existsSync(wUnit)) { unlinkSync(wUnit); ok(`removed ${wUnit}`); }

  // 2. embedder service via the install script's --uninstall path
  header('Removing embedder sidecar');
  const repoRoot = process.cwd().replace(/\/scripts$/, '');
  const embedScript = join(repoRoot, 'scripts/install-embedder.sh');
  if (existsSync(embedScript)) {
    spawnSync('bash', [embedScript, '--uninstall'], { stdio: 'inherit' });
  } else {
    spawnSync('systemctl', ['stop', EMBED_UNIT], { stdio: 'inherit' });
    spawnSync('systemctl', ['disable', EMBED_UNIT], { stdio: 'inherit' });
    const eUnit = join(SYSTEMD_DIR, EMBED_UNIT);
    if (existsSync(eUnit)) { unlinkSync(eUnit); ok(`removed ${eUnit}`); }
    if (existsSync('/opt/captain-memo-embed')) {
      rmSync('/opt/captain-memo-embed', { recursive: true, force: true });
      ok('removed /opt/captain-memo-embed');
    }
    spawnSync('userdel', ['captain-memo-embed'], { stdio: 'ignore' });
  }
  spawnSync('systemctl', ['daemon-reload'], { stdio: 'inherit' });

  // 3. /etc/captain-memo
  header('Removing config');
  if (existsSync(ETC_DIR)) {
    rmSync(ETC_DIR, { recursive: true, force: true });
    ok(`removed ${ETC_DIR}`);
  }

  // 4. plugin symlink
  header('Unregistering Claude Code plugin');
  const link = join(realHome(), '.claude', 'plugins', 'captain-memo');
  if (existsSync(link) || (() => { try { lstatSync(link); return true; } catch { return false; } })()) {
    try {
      unlinkSync(link);
      ok(`removed ${link}`);
    } catch (e) {
      warn(`could not remove ${link}: ${(e as Error).message}`);
    }
  }

  // 5. data dir (only with --purge)
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
