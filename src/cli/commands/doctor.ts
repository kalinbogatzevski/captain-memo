// captain-memo doctor — health probe across all moving parts.
//
// Reports PASS / WARN / FAIL for each component and prints a one-line
// remediation hint when something's wrong. Read-only — never changes state.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

// Lookup a single key from worker.env (user-mode first, then system-mode).
function readWorkerEnvVar(key: string): string | null {
  const candidates = [
    join(homedir(), '.config', 'captain-memo', 'worker.env'),
    '/etc/captain-memo/worker.env',
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const m = readFileSync(path, 'utf-8').match(new RegExp(`^${key}=(.+)$`, 'm'));
    if (m) return m[1] ?? null;
  }
  return null;
}

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
  // Try user-level first, then system. Either being active means we're up.
  const userR = spawnSync('systemctl', ['--user', 'is-active', name], { encoding: 'utf-8' });
  if (userR.stdout.trim() === 'active') return true;
  const sysR = spawnSync('systemctl', ['is-active', name], { encoding: 'utf-8' });
  return sysR.stdout.trim() === 'active';
}

function svcExists(name: string): boolean {
  const userR = spawnSync('systemctl', ['--user', 'list-unit-files', name], { encoding: 'utf-8' });
  if (userR.stdout.includes(name)) return true;
  const sysR = spawnSync('systemctl', ['list-unit-files', name], { encoding: 'utf-8' });
  return sysR.stdout.includes(name);
}

function svcMode(name: string): 'user' | 'system' | null {
  const userR = spawnSync('systemctl', ['--user', 'list-unit-files', name], { encoding: 'utf-8' });
  if (userR.stdout.includes(name)) return 'user';
  const sysR = spawnSync('systemctl', ['list-unit-files', name], { encoding: 'utf-8' });
  if (sysR.stdout.includes(name)) return 'system';
  return null;
}

function curlJson(url: string, timeoutMs = 3000): { ok: boolean; body: unknown } {
  const r = spawnSync('curl', ['-s', '-m', String(timeoutMs / 1000), url], { encoding: 'utf-8' });
  if (r.status !== 0 || !r.stdout) return { ok: false, body: null };
  try { return { ok: true, body: JSON.parse(r.stdout) }; }
  catch { return { ok: false, body: r.stdout }; }
}

function checkEmbedder(): void {
  // Read worker.env to figure out what backend the user actually picked.
  // Hosted Voyage / OpenAI / aelita endpoints are normal — not warnings.
  const endpoint = readWorkerEnvVar('CAPTAIN_MEMO_EMBEDDER_ENDPOINT') ?? '';
  const isLocal = endpoint.startsWith('http://127.0.0.1:8124')
               || endpoint.startsWith('http://localhost:8124');
  if (!isLocal) {
    const host = endpoint.replace(/^https?:\/\//, '').split('/')[0] || '?';
    record({ name: 'embedder backend', status: 'PASS', detail: `external endpoint @ ${host}` });
    return;
  }
  if (!svcExists('captain-memo-embed.service')) {
    record({ name: 'embedder service', status: 'FAIL', detail: 'worker.env points at local sidecar but the service is not installed',
             remedy: 'captain-memo install   (pick "local sidecar"), or change CAPTAIN_MEMO_EMBEDDER_ENDPOINT to a hosted backend' });
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
      const b = s.body as {
        total_chunks?: number; project_id?: string;
        indexing?: { status?: string; done?: number; total?: number; percent?: number; errors?: number };
        observations?: { total?: number };
      };
      const idx = b.indexing;
      if (idx?.status === 'indexing') {
        record({ name: 'worker service', status: 'PASS',
                 detail: `:39888 ready · indexing ${idx.done}/${idx.total} (${idx.percent}%) · ${b.total_chunks} chunks so far` });
      } else if (idx?.status === 'error') {
        record({ name: 'worker service', status: 'WARN',
                 detail: `:39888 reachable but indexing reported error (chunks=${b.total_chunks})`,
                 remedy: 'journalctl -u captain-memo-worker -n 30 --no-pager' });
      } else {
        record({ name: 'worker service', status: 'PASS',
                 detail: `:39888 healthy · ${b.total_chunks} chunks · ${b.observations?.total ?? 0} observations · project=${b.project_id}` });
      }
    } else {
      record({ name: 'worker service', status: 'WARN', detail: ':39888 healthy but /stats failed' });
    }
  } else {
    record({ name: 'worker service', status: 'FAIL', detail: 'systemd active but /health not responding',
             remedy: 'journalctl -u captain-memo-worker -n 30 --no-pager' });
  }
}

function checkConfig(): void {
  // Look for worker.env in both user-mode and system-mode locations.
  const userPath = join(homedir(), '.config/captain-memo/worker.env');
  const sysPath = '/etc/captain-memo/worker.env';
  const path = existsSync(userPath) ? userPath : existsSync(sysPath) ? sysPath : null;
  if (!path) {
    record({ name: 'worker config', status: 'FAIL', detail: `not found at ${userPath} or ${sysPath}`,
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
  // Plugins are registered with Claude Code's marketplace, not as a symlink
  // under ~/.claude/plugins/. Ask `claude plugin list` for the truth.
  const r = spawnSync('claude', ['plugin', 'list'], { encoding: 'utf-8', timeout: 5000 });
  if (r.status !== 0) {
    record({ name: 'plugin registration', status: 'WARN', detail: `'claude plugin list' returned exit ${r.status}; can't verify`,
             remedy: 'ensure `claude` is on PATH; or run `claude plugin install captain-memo@captain-memo` manually' });
    return;
  }
  // Look for our plugin slug + the enabled status. Exact format from claude CLI:
  //   ❯ captain-memo@captain-memo
  //     Status: ✔ enabled
  const out = (r.stdout ?? '');
  const ourLine = out.split('\n').find(l => l.includes('captain-memo@captain-memo'));
  if (!ourLine) {
    record({ name: 'plugin registration', status: 'FAIL', detail: 'captain-memo@captain-memo not in `claude plugin list`',
             remedy: 'captain-memo install   (re-runs the marketplace registration)' });
    return;
  }
  // Status icon may be on the same line OR below it; check both
  const enabled = /enabled/i.test(out.slice(out.indexOf(ourLine), out.indexOf(ourLine) + 200));
  if (enabled) {
    record({ name: 'plugin registration', status: 'PASS', detail: 'captain-memo@captain-memo · enabled' });
  } else {
    record({ name: 'plugin registration', status: 'WARN', detail: 'captain-memo@captain-memo registered but not enabled',
             remedy: 'claude plugin enable captain-memo@captain-memo' });
  }
}

function checkPluginManifest(): void {
  // Manifest lives in the repo's plugin/ subdir (not in ~/.claude/plugins/...).
  // Check that the source files Claude Code reads via marketplace are present
  // and parseable.
  const repoRoot = join(import.meta.dir, '../../..');
  const manifest = join(repoRoot, 'plugin', '.claude-plugin', 'plugin.json');
  const hooks = join(repoRoot, 'plugin', 'hooks', 'hooks.json');
  if (!existsSync(manifest)) {
    record({ name: 'plugin manifest', status: 'FAIL', detail: `${manifest} missing` });
    return;
  }
  if (!existsSync(hooks)) {
    record({ name: 'plugin hooks', status: 'WARN', detail: `${hooks} missing — sessions won't fire hooks`,
             remedy: 'reinstall the captain-memo repo (the file is checked in)' });
    return;
  }
  record({ name: 'plugin manifest', status: 'PASS', detail: 'plugin.json + hooks.json present in repo' });
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
