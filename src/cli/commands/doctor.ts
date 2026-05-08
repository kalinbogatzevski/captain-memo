// captain-memo doctor — health probe across all moving parts.
//
// Reports PASS / WARN / FAIL for each component and prints a one-line
// remediation hint when something's wrong. Read-only — never changes state.

import { existsSync, readFileSync, lstatSync, readlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

type Status = 'PASS' | 'WARN' | 'FAIL';

interface Check {
  name: string;
  status: Status;
  detail: string;
  remedy?: string;
}

const checks: Check[] = [];

function record(c: Check): void { checks.push(c); }

function svcActive(name: string): boolean {
  const r = spawnSync('systemctl', ['is-active', name], { encoding: 'utf-8' });
  return r.stdout.trim() === 'active';
}

function svcExists(name: string): boolean {
  const r = spawnSync('systemctl', ['list-unit-files', name], { encoding: 'utf-8' });
  return r.stdout.includes(name);
}

function curlJson(url: string, timeoutMs = 3000): { ok: boolean; body: unknown } {
  const r = spawnSync('curl', ['-s', '-m', String(timeoutMs / 1000), url], { encoding: 'utf-8' });
  if (r.status !== 0 || !r.stdout) return { ok: false, body: null };
  try { return { ok: true, body: JSON.parse(r.stdout) }; }
  catch { return { ok: false, body: r.stdout }; }
}

function checkEmbedder(): void {
  if (!svcExists('captain-memo-embed.service')) {
    record({ name: 'embedder service', status: 'WARN', detail: 'not installed (using external embedder?)',
             remedy: 'captain-memo install   (pick "local sidecar")' });
    return;
  }
  if (!svcActive('captain-memo-embed.service')) {
    record({ name: 'embedder service', status: 'FAIL', detail: 'systemd unit installed but not running',
             remedy: 'sudo systemctl start captain-memo-embed' });
    return;
  }
  const h = curlJson('http://127.0.0.1:8124/health');
  if (h.ok && (h.body as { healthy?: boolean }).healthy) {
    const b = h.body as { model?: string; dim?: number };
    record({ name: 'embedder service', status: 'PASS', detail: `${b.model} dim=${b.dim} on :8124` });
  } else {
    record({ name: 'embedder service', status: 'FAIL', detail: 'systemd active but /health not responding',
             remedy: 'journalctl -u captain-memo-embed -n 30 --no-pager' });
  }
}

function checkWorker(): void {
  if (!svcExists('captain-memo-worker.service')) {
    record({ name: 'worker service', status: 'FAIL', detail: 'not installed',
             remedy: 'captain-memo install' });
    return;
  }
  if (!svcActive('captain-memo-worker.service')) {
    record({ name: 'worker service', status: 'FAIL', detail: 'systemd unit installed but not running',
             remedy: 'sudo systemctl start captain-memo-worker' });
    return;
  }
  const h = curlJson('http://127.0.0.1:39888/health');
  if (h.ok && (h.body as { healthy?: boolean }).healthy) {
    const s = curlJson('http://127.0.0.1:39888/stats');
    if (s.ok) {
      const b = s.body as { total_chunks?: number; by_channel?: Record<string, number>; project_id?: string };
      record({ name: 'worker service', status: 'PASS',
               detail: `:39888 healthy · ${b.total_chunks} chunks · project=${b.project_id}` });
    } else {
      record({ name: 'worker service', status: 'WARN', detail: ':39888 healthy but /stats failed' });
    }
  } else {
    record({ name: 'worker service', status: 'FAIL', detail: 'systemd active but /health not responding',
             remedy: 'journalctl -u captain-memo-worker -n 30 --no-pager   (initial indexing on a large corpus can take minutes)' });
  }
}

function checkConfig(): void {
  const path = '/etc/captain-memo/worker.env';
  if (!existsSync(path)) {
    record({ name: 'worker config', status: 'FAIL', detail: `${path} missing`,
             remedy: 'captain-memo install' });
    return;
  }
  const content = readFileSync(path, 'utf-8');
  const provider = (content.match(/CAPTAIN_MEMO_SUMMARIZER_PROVIDER=(.+)/) ?? [])[1] ?? '?';
  const model = (content.match(/CAPTAIN_MEMO_SUMMARIZER_MODEL=(.+)/) ?? [])[1] ?? '?';
  const watch = (content.match(/CAPTAIN_MEMO_WATCH_MEMORY=(.+)/) ?? [])[1] ?? '(none)';
  record({ name: 'worker config', status: 'PASS',
           detail: `summarizer=${provider} model=${model} watch=${watch.slice(0, 60)}${watch.length > 60 ? '…' : ''}` });
}

function checkPluginRegistration(): void {
  const link = join(homedir(), '.claude', 'plugins', 'captain-memo');
  let stat;
  try { stat = lstatSync(link); }
  catch {
    record({ name: 'plugin registration', status: 'FAIL', detail: `${link} missing`,
             remedy: 'captain-memo install' });
    return;
  }
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(link);
    if (existsSync(target)) {
      record({ name: 'plugin registration', status: 'PASS', detail: `~/.claude/plugins/captain-memo -> ${target}` });
    } else {
      record({ name: 'plugin registration', status: 'FAIL', detail: `symlink target missing: ${target}`,
               remedy: 'captain-memo uninstall && captain-memo install' });
    }
  } else if (stat.isDirectory()) {
    record({ name: 'plugin registration', status: 'PASS', detail: `~/.claude/plugins/captain-memo (real directory)` });
  } else {
    record({ name: 'plugin registration', status: 'WARN', detail: `unexpected file type at ${link}` });
  }
}

function checkPluginManifest(): void {
  const link = join(homedir(), '.claude', 'plugins', 'captain-memo');
  const manifest = join(link, '.claude-plugin', 'plugin.json');
  const hooks = join(link, 'hooks', 'hooks.json');
  if (!existsSync(manifest)) {
    record({ name: 'plugin manifest', status: 'FAIL', detail: `${manifest} missing` });
    return;
  }
  if (!existsSync(hooks)) {
    record({ name: 'plugin hooks', status: 'WARN', detail: `${hooks} missing — sessions won't fire hooks`,
             remedy: 'captain-memo install (re-syncs the plugin source)' });
    return;
  }
  record({ name: 'plugin manifest', status: 'PASS', detail: 'plugin.json + hooks.json present' });
}

function statusIcon(s: Status): string {
  return s === 'PASS' ? '\x1b[32m✓\x1b[0m' : s === 'WARN' ? '\x1b[33m!\x1b[0m' : '\x1b[31m✗\x1b[0m';
}

export async function doctorCommand(_args: string[]): Promise<number> {
  console.log('\n\x1b[1;36mCaptain Memo doctor\x1b[0m\n───────────────────');

  checkEmbedder();
  checkWorker();
  checkConfig();
  checkPluginRegistration();
  checkPluginManifest();

  for (const c of checks) {
    console.log(`  ${statusIcon(c.status)} ${c.name.padEnd(22)} ${c.detail}`);
    if (c.remedy && c.status !== 'PASS') console.log(`      \x1b[2m→ ${c.remedy}\x1b[0m`);
  }

  const fails = checks.filter(c => c.status === 'FAIL').length;
  const warns = checks.filter(c => c.status === 'WARN').length;
  console.log();
  if (fails === 0 && warns === 0) {
    console.log('  \x1b[32mAll systems healthy. Restart Claude Code sessions to use new hooks.\x1b[0m');
  } else {
    console.log(`  ${fails} fail${fails === 1 ? '' : 's'}, ${warns} warn${warns === 1 ? '' : 's'} — see remediation hints above.`);
  }
  return fails > 0 ? 1 : 0;
}
