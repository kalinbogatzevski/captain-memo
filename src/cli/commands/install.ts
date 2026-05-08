// captain-memo install — interactive plugin install wizard.
//
// DEFAULT MODE (user, NO sudo):
//   Embedder install:  ~/.captain-memo/embed/  (Python venv + voyage-4-nano)
//   Worker systemd:    ~/.config/systemd/user/captain-memo-worker.service
//   Config:            ~/.config/captain-memo/worker.env
//   Plugin symlink:    ~/.claude/plugins/captain-memo
//   Run with:          systemctl --user start captain-memo-worker
//
// WITH --system (multi-user / headless / persists across logouts cleanly):
//   Embedder:          /opt/captain-memo-embed/
//   Worker systemd:    /etc/systemd/system/captain-memo-worker.service
//   Config:            /etc/captain-memo/worker.env
//   Plugin symlink:    ~/.claude/plugins/captain-memo  (still per-user)
//   Re-execs sudo if not already root.
//
// Idempotent: re-running reconfigures rather than crashes.

import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync, statSync, chmodSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { printMiniBanner } from '../banner.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const WORKER_UNIT_NAME = 'captain-memo-worker.service';
const EMBED_UNIT_NAME = 'captain-memo-embed.service';
const PLUGIN_LINK = join(homedir(), '.claude', 'plugins', 'captain-memo');

type InstallMode = 'user' | 'system';

interface ModePaths {
  mode: InstallMode;
  installDir: string;       // where the embedder + worker config live
  systemdDir: string;       // where service files go
  envFile: string;          // worker.env path
  systemctl: string[];      // ['systemctl'] or ['systemctl', '--user']
  unitTemplate: string;     // path to the worker unit file template
}

function resolvePaths(mode: InstallMode): ModePaths {
  if (mode === 'system') {
    return {
      mode: 'system',
      installDir: '/opt/captain-memo-embed',
      systemdDir: '/etc/systemd/system',
      envFile: '/etc/captain-memo/worker.env',
      systemctl: ['systemctl'],
      unitTemplate: join(REPO_ROOT, 'services/worker/systemd/captain-memo-worker.service'),
    };
  }
  return {
    mode: 'user',
    installDir: join(homedir(), '.captain-memo/embed'),
    systemdDir: join(homedir(), '.config/systemd/user'),
    envFile: join(homedir(), '.config/captain-memo/worker.env'),
    systemctl: ['systemctl', '--user'],
    unitTemplate: join(REPO_ROOT, 'services/worker/systemd/captain-memo-worker.user.service'),
  };
}

type SummarizerProvider = 'claude-code' | 'anthropic' | 'openai-compatible' | 'skip';
type EmbedderProvider = 'local-sidecar' | 'openai-compatible' | 'skip';
type WatchPaths = 'all-projects' | 'user-global' | 'custom' | 'skip';

interface WizardConfig {
  summarizer: SummarizerProvider;
  anthropicApiKey?: string;
  summarizerOpenaiEndpoint?: string;
  summarizerOpenaiKey?: string;
  summarizerModel: string;
  embedder: EmbedderProvider;
  embedderEndpoint: string;
  embedderModel: string;
  embeddingDimension: number;
  watchMemory: string;
  hookTimeoutMs: number;
}

function header(text: string): void {
  console.log();
  console.log(`\x1b[1;36m${text}\x1b[0m`);
  console.log('─'.repeat(text.length));
}

function info(text: string): void { console.log(`  ${text}`); }
function ok(text: string): void { console.log(`  \x1b[32m✓\x1b[0m ${text}`); }
function warn(text: string): void { console.log(`  \x1b[33m!\x1b[0m ${text}`); }
function fail(text: string): never {
  console.log(`  \x1b[31m✗\x1b[0m ${text}`);
  process.exit(1);
}

function ask(question: string, options: { value: string; label: string; recommended?: boolean }[], defaultIdx = 0): string {
  console.log();
  console.log(`\x1b[1m${question}\x1b[0m`);
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]!;
    const tag = opt.recommended ? ' \x1b[36m(recommended)\x1b[0m' : '';
    console.log(`  [${i + 1}] ${opt.label}${tag}`);
  }
  while (true) {
    const raw = prompt(`Choose [1-${options.length}, default ${defaultIdx + 1}]: `);
    const trimmed = (raw ?? '').trim();
    const idx = trimmed === '' ? defaultIdx : Number(trimmed) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
      return options[idx]!.value;
    }
    console.log('  Please enter a number from the list.');
  }
}

function askText(question: string, defaultValue?: string): string {
  console.log();
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const raw = prompt(`\x1b[1m${question}\x1b[0m${suffix}: `);
  const trimmed = (raw ?? '').trim();
  return trimmed === '' ? (defaultValue ?? '') : trimmed;
}

function askYesNo(question: string, defaultYes = true): boolean {
  console.log();
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const raw = prompt(`\x1b[1m${question}\x1b[0m ${suffix} `);
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed === '') return defaultYes;
  return trimmed === 'y' || trimmed === 'yes';
}

interface PreflightResult {
  name: string;
  status: 'OK' | 'WARN' | 'FAIL';
  detail: string;
  remedy?: string;
}

function preflight(opts: { wantLocalEmbedder: boolean }): PreflightResult[] {
  const out: PreflightResult[] = [];

  // OS
  const osRes = spawnSync('uname', ['-s'], { encoding: 'utf-8' });
  const os = osRes.stdout.trim();
  if (os === 'Linux') out.push({ name: 'OS', status: 'OK', detail: 'Linux' });
  else out.push({ name: 'OS', status: 'FAIL', detail: `${os} (Linux required for systemd-based install)`,
                  remedy: 'macOS / Windows support not yet implemented' });

  // systemd
  const systemctl = spawnSync('which', ['systemctl'], { encoding: 'utf-8' });
  if (systemctl.status === 0) out.push({ name: 'systemd', status: 'OK', detail: 'systemctl on PATH' });
  else out.push({ name: 'systemd', status: 'FAIL', detail: 'systemctl not found',
                  remedy: 'install on a systemd-based distro (Debian/Ubuntu/Fedora/Arch/etc.)' });

  // Python (only relevant if installing local embedder)
  if (opts.wantLocalEmbedder) {
    const pyRes = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
    const pyOut = (pyRes.stdout || pyRes.stderr).trim();
    const m = pyOut.match(/Python (\d+)\.(\d+)/);
    if (m) {
      const major = Number(m[1]);
      const minor = Number(m[2]);
      if (major >= 3 && minor >= 11) {
        out.push({ name: 'Python', status: 'OK', detail: pyOut });
      } else {
        out.push({ name: 'Python', status: 'FAIL', detail: `${pyOut} (3.11+ required for local embedder)`,
                   remedy: 'apt install python3.11-venv python3.11   (or pick a non-local embedder)' });
      }
    } else {
      out.push({ name: 'Python', status: 'FAIL', detail: 'python3 not found',
                 remedy: 'apt install python3 python3-venv python3-pip   (needed only for local embedder)' });
    }
  }

  // CPU instruction set (informational; numpy<2 path works without AVX2)
  const cpu = readFileSync('/proc/cpuinfo', 'utf-8');
  const flags = (cpu.match(/^flags\s*:\s*(.+)/m) ?? [])[1] ?? '';
  const hasAVX2 = /\bavx2\b/.test(flags);
  const hasSSE4 = /\bsse4_2\b/.test(flags);
  if (hasAVX2) {
    out.push({ name: 'CPU', status: 'OK', detail: 'x86_64 with AVX2 (fast path)' });
  } else if (hasSSE4) {
    out.push({ name: 'CPU', status: 'WARN', detail: 'x86_64 with SSE4.2 but no AVX2 (slower embedder, ~10x)',
               remedy: 'embedder still works (uses numpy<2). For best speed run on AVX2-capable hardware (most CPUs since ~2014).' });
  } else {
    out.push({ name: 'CPU', status: 'WARN', detail: 'old x86_64 (no AVX2/SSE4) — embedder will be very slow' });
  }

  // RAM
  const meminfo = readFileSync('/proc/meminfo', 'utf-8');
  const memTotalKb = Number((meminfo.match(/^MemTotal:\s+(\d+)\s+kB/m) ?? [])[1] ?? '0');
  const memTotalGb = memTotalKb / 1024 / 1024;
  if (memTotalGb >= 4) {
    out.push({ name: 'RAM', status: 'OK', detail: `${memTotalGb.toFixed(1)} GB` });
  } else if (memTotalGb >= 2) {
    out.push({ name: 'RAM', status: 'WARN', detail: `${memTotalGb.toFixed(1)} GB (4 GB+ recommended; embedder + worker peak ~3 GB)` });
  } else {
    out.push({ name: 'RAM', status: 'FAIL', detail: `${memTotalGb.toFixed(1)} GB (insufficient for local embedder)`,
               remedy: 'use a remote embedder (provider=openai-compatible) or upgrade RAM' });
  }

  // Disk in /opt (target dir for embedder venv + model)
  if (opts.wantLocalEmbedder) {
    const dfRes = spawnSync('df', ['-BM', '/opt'], { encoding: 'utf-8' });
    const dfMatch = dfRes.stdout.match(/(\d+)M\s+(\d+)M\s+(\d+)M/);
    const availMb = Number(dfMatch?.[3] ?? 0);
    const availGb = availMb / 1024;
    if (availGb >= 5) out.push({ name: 'Disk (/opt)', status: 'OK', detail: `${availGb.toFixed(1)} GB free` });
    else if (availGb >= 3) out.push({ name: 'Disk (/opt)', status: 'WARN', detail: `${availGb.toFixed(1)} GB free (5 GB+ recommended; embedder venv + model = ~3.3 GB)` });
    else out.push({ name: 'Disk (/opt)', status: 'FAIL', detail: `${availGb.toFixed(1)} GB free (need ≥3 GB for local embedder)`,
                    remedy: 'free up disk in /opt or pick a remote embedder' });
  }

  // Bun (already checked in whichBun, but report it cleanly)
  try {
    const bun = whichBun();
    out.push({ name: 'bun', status: 'OK', detail: bun });
  } catch { /* whichBun fails inside its own path; we'll catch this in the main flow */ }

  // Network (if local embedder, we'll need PyPI + HuggingFace)
  if (opts.wantLocalEmbedder) {
    const net = spawnSync('curl', ['-s', '-m', '3', '-o', '/dev/null', '-w', '%{http_code}', 'https://pypi.org/'], { encoding: 'utf-8' });
    const code = Number(net.stdout || '0');
    if (code >= 200 && code < 400) out.push({ name: 'Network', status: 'OK', detail: 'pypi.org reachable' });
    else out.push({ name: 'Network', status: 'WARN', detail: `pypi.org returned HTTP ${code} (will retry during pip install)` });
  }

  return out;
}

function printPreflight(results: PreflightResult[]): boolean {
  console.log();
  console.log('\x1b[1mPre-flight checks\x1b[0m');
  for (const r of results) {
    const icon = r.status === 'OK' ? '\x1b[32m✓\x1b[0m'
               : r.status === 'WARN' ? '\x1b[33m!\x1b[0m'
               : '\x1b[31m✗\x1b[0m';
    console.log(`  ${icon} ${r.name.padEnd(13)} ${r.detail}`);
    if (r.remedy && r.status !== 'OK') console.log(`      \x1b[2m→ ${r.remedy}\x1b[0m`);
  }
  const fails = results.filter(r => r.status === 'FAIL').length;
  return fails === 0;
}

function whichBun(): string {
  // Prefer PATH; sudo often strips it, so also probe SUDO_USER's local install.
  const r = spawnSync('which', ['bun'], { encoding: 'utf-8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();

  const candidates: string[] = [];
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser) {
    const userHome = (spawnSync('getent', ['passwd', sudoUser], { encoding: 'utf-8' })
      .stdout.split(':')[5] ?? '').trim();
    if (userHome) candidates.push(`${userHome}/.bun/bin/bun`);
  }
  candidates.push('/usr/local/bin/bun', '/usr/bin/bun', '/opt/bun/bin/bun');

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  fail(`\`bun\` not found. Tried: PATH, ${candidates.join(', ')}.\n  Install bun (https://bun.com) first, then re-run.`);
}

function ensureSudoFor(mode: InstallMode): void {
  if (mode === 'user') {
    if (process.getuid && process.getuid() === 0) {
      fail('--user mode shouldn\'t run as root (would install into root\'s home).\n  Run as your normal user, OR pass --system for the multi-user install.');
    }
    return;
  }
  // mode === 'system'
  if (process.getuid && process.getuid() === 0) return;
  console.log();
  warn('--system mode needs sudo. Re-running...');
  const r = spawnSync('sudo', ['-E', process.execPath, ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function realUserAndGroup(): { user: string; group: string; home: string } {
  const u = process.env.SUDO_USER ?? process.env.USER ?? '';
  if (!u) fail('Cannot determine the real user (SUDO_USER unset).');
  const home = spawnSync('getent', ['passwd', u], { encoding: 'utf-8' }).stdout.split(':')[5] ?? '';
  // group = primary group of user
  const groupId = spawnSync('id', ['-gn', u], { encoding: 'utf-8' }).stdout.trim();
  return { user: u, group: groupId || u, home: home.trim() };
}

function gatherConfig(existing?: Partial<WizardConfig>): WizardConfig {
  header('Captain Memo install wizard');
  info('A few questions, then I install everything in one go.');

  // ----- summarizer -----
  const summarizer = ask(
    'Which summarizer should I use to compress session events into observations?',
    [
      { value: 'claude-code', label: 'Claude Code Max/Pro plan (no API key needed)', recommended: true },
      { value: 'anthropic', label: 'Anthropic API (paid, low latency, needs ANTHROPIC_API_KEY)' },
      { value: 'openai-compatible', label: 'OpenAI / Ollama / OpenRouter / etc. (any /v1/chat/completions)' },
      { value: 'skip', label: "Skip — events queue but don't summarize" },
    ],
  ) as SummarizerProvider;

  let anthropicApiKey: string | undefined;
  let summarizerOpenaiEndpoint: string | undefined;
  let summarizerOpenaiKey: string | undefined;
  let summarizerModel = 'claude-haiku-4-5';
  if (summarizer === 'anthropic') {
    anthropicApiKey = askText('Anthropic API key (sk-ant-...)', existing?.anthropicApiKey);
    summarizerModel = askText('Summarizer model', 'claude-haiku-4-5');
  } else if (summarizer === 'openai-compatible') {
    summarizerOpenaiEndpoint = askText('OpenAI-compatible endpoint URL', existing?.summarizerOpenaiEndpoint ?? 'http://localhost:11434/v1/chat/completions');
    summarizerOpenaiKey = askText('API key (leave blank for local servers)', existing?.summarizerOpenaiKey ?? '');
    summarizerModel = askText('Summarizer model', existing?.summarizerModel ?? 'qwen2.5:14b-instruct');
  }

  // ----- embedder -----
  const embedder = ask(
    'Which embedder should I use for vector search?',
    [
      { value: 'local-sidecar', label: 'Local voyage-4-nano sidecar (best quality, runs on CPU, ~3GB install)', recommended: true },
      { value: 'openai-compatible', label: 'External /v1/embeddings (Ollama / OpenAI / Voyage cloud / etc.)' },
      { value: 'skip', label: 'Skip — keyword-only retrieval (works without any embedder)' },
    ],
  ) as EmbedderProvider;

  let embedderEndpoint = 'http://127.0.0.1:8124/v1/embeddings';
  let embedderModel = 'voyageai/voyage-4-nano';
  let embeddingDimension = 2048;
  if (embedder === 'openai-compatible') {
    embedderEndpoint = askText('Embedder endpoint URL', existing?.embedderEndpoint ?? 'http://localhost:11434/v1/embeddings');
    embedderModel = askText('Embedder model', existing?.embedderModel ?? 'nomic-embed-text');
    embeddingDimension = Number(askText('Embedding dimension', String(existing?.embeddingDimension ?? 768)));
  } else if (embedder === 'skip') {
    embeddingDimension = 8; // dummy for the vec0 table
  }

  // ----- watch paths -----
  const watchChoice = ask(
    'Which directories should the worker watch for memory files?',
    [
      { value: 'all-projects', label: 'All Claude project memories (~/.claude/projects/*/memory/*.md)', recommended: true },
      { value: 'user-global', label: 'User-global only (~/.claude/memory/*.md)' },
      { value: 'custom', label: 'Custom paths (I prompt for them)' },
      { value: 'skip', label: 'Skip watching — observations only' },
    ],
  ) as WatchPaths;
  const { home } = realUserAndGroup();
  let watchMemory = '';
  if (watchChoice === 'all-projects') watchMemory = join(home, '.claude/projects/*/memory/*.md');
  else if (watchChoice === 'user-global') watchMemory = join(home, '.claude/memory/*.md');
  else if (watchChoice === 'custom') watchMemory = askText('Comma-separated glob patterns', existing?.watchMemory ?? join(home, '.claude/memory/*.md'));

  return {
    summarizer,
    ...(anthropicApiKey !== undefined && { anthropicApiKey }),
    ...(summarizerOpenaiEndpoint !== undefined && { summarizerOpenaiEndpoint }),
    ...(summarizerOpenaiKey !== undefined && summarizerOpenaiKey !== '' && { summarizerOpenaiKey }),
    summarizerModel,
    embedder,
    embedderEndpoint,
    embedderModel,
    embeddingDimension,
    watchMemory,
    hookTimeoutMs: 2000, // generous default; user can tune later
  };
}

function writeWorkerEnv(cfg: WizardConfig, paths: ModePaths): void {
  const dir = dirname(paths.envFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
  const dataDir = paths.mode === 'user'
    ? join(homedir(), '.captain-memo')
    : join(homedir(), '.captain-memo'); // same for both — data lives in the user's home
  const lines: string[] = [
    '# Captain Memo worker — autogenerated by `captain-memo install`. Safe to hand-edit.',
    `CAPTAIN_MEMO_DATA_DIR=${dataDir}`,
    `CAPTAIN_MEMO_PROJECT_ID=default`,
    `CAPTAIN_MEMO_WORKER_PORT=39888`,
    `CAPTAIN_MEMO_HOOK_TIMEOUT_MS=${cfg.hookTimeoutMs}`,
    `CAPTAIN_MEMO_SUMMARIZER_PROVIDER=${cfg.summarizer === 'skip' ? 'anthropic' : cfg.summarizer}`,
    `CAPTAIN_MEMO_SUMMARIZER_MODEL=${cfg.summarizerModel}`,
  ];
  if (cfg.summarizer === 'anthropic' && cfg.anthropicApiKey) {
    lines.push(`ANTHROPIC_API_KEY=${cfg.anthropicApiKey}`);
  }
  if (cfg.summarizer === 'openai-compatible') {
    lines.push(`CAPTAIN_MEMO_OPENAI_ENDPOINT=${cfg.summarizerOpenaiEndpoint}`);
    if (cfg.summarizerOpenaiKey) lines.push(`CAPTAIN_MEMO_OPENAI_API_KEY=${cfg.summarizerOpenaiKey}`);
  }
  if (cfg.embedder === 'skip') {
    lines.push(`CAPTAIN_MEMO_SKIP_EMBED=1`);
  } else {
    lines.push(`CAPTAIN_MEMO_EMBEDDER_ENDPOINT=${cfg.embedderEndpoint}`);
    lines.push(`CAPTAIN_MEMO_EMBEDDER_MODEL=${cfg.embedderModel}`);
    lines.push(`CAPTAIN_MEMO_EMBEDDING_DIM=${cfg.embeddingDimension}`);
  }
  if (cfg.watchMemory) lines.push(`CAPTAIN_MEMO_WATCH_MEMORY=${cfg.watchMemory}`);

  writeFileSync(paths.envFile, lines.join('\n') + '\n', { mode: 0o644 });
  ok(`wrote ${paths.envFile}`);
}

function installEmbedder(paths: ModePaths): void {
  const script = join(REPO_ROOT, 'scripts/install-embedder.sh');
  if (!existsSync(script)) fail(`missing ${script}`);
  const flag = paths.mode === 'user' ? '--user' : '--system';
  const r = spawnSync('bash', [script, flag], { stdio: 'inherit' });
  if (r.status !== 0) fail('embedder install failed; see output above');
  ok('embedder sidecar installed');
}

function installWorkerService(paths: ModePaths, bunPath: string): void {
  let unit = readFileSync(paths.unitTemplate, 'utf-8')
    .replaceAll('__INSTALL_DIR__', REPO_ROOT)
    .replaceAll('__BUN__', bunPath)
    .replaceAll('__ENV_FILE__', paths.envFile);
  if (paths.mode === 'system') {
    const { user, group } = realUserAndGroup();
    unit = unit.replaceAll('__USER__', user).replaceAll('__GROUP__', group);
  }
  if (!existsSync(paths.systemdDir)) mkdirSync(paths.systemdDir, { recursive: true });
  writeFileSync(join(paths.systemdDir, WORKER_UNIT_NAME), unit, { mode: 0o644 });
  ok(`wrote ${paths.systemdDir}/${WORKER_UNIT_NAME}`);
  spawnSync(paths.systemctl[0]!, [...paths.systemctl.slice(1), 'daemon-reload'], { stdio: 'inherit' });
  spawnSync(paths.systemctl[0]!, [...paths.systemctl.slice(1), 'enable', WORKER_UNIT_NAME], { stdio: 'inherit' });
  spawnSync(paths.systemctl[0]!, [...paths.systemctl.slice(1), 'restart', WORKER_UNIT_NAME], { stdio: 'inherit' });
  ok(`worker service enabled + started (${paths.mode === 'user' ? 'systemctl --user' : 'systemctl'} ${WORKER_UNIT_NAME})`);
}

function registerPlugin(mode: InstallMode): void {
  // Run `claude plugin marketplace add <repo> && claude plugin install captain-memo@captain-memo`
  // — that's how Claude Code actually picks up the plugin (manifest, hooks,
  // MCP server, slash commands). The earlier symlink-into-~/.claude/plugins/
  // approach didn't register the plugin in Claude Code's internal catalog.
  //
  // In user mode we just run `claude` directly. In system mode, the wizard is
  // running as root — we drop privileges to SUDO_USER so claude reads/writes
  // the user's settings, not root's.
  const runAsUser = (cmd: string, args: string[]) => {
    if (mode === 'system' && process.env.SUDO_USER) {
      return spawnSync('sudo', ['-u', process.env.SUDO_USER, '-E', cmd, ...args], { stdio: 'inherit' });
    }
    return spawnSync(cmd, args, { stdio: 'inherit' });
  };

  // Idempotent — if the marketplace already exists, claude prints a notice and exits 0.
  const r1 = runAsUser('claude', ['plugin', 'marketplace', 'add', REPO_ROOT]);
  if (r1.status !== 0) {
    warn(`'claude plugin marketplace add' failed (exit ${r1.status})`);
    info('You can register manually later:');
    info(`  claude plugin marketplace add ${REPO_ROOT}`);
    info(`  claude plugin install captain-memo@captain-memo`);
    return;
  }

  const r2 = runAsUser('claude', ['plugin', 'install', 'captain-memo@captain-memo']);
  if (r2.status !== 0) {
    warn(`'claude plugin install' failed (exit ${r2.status})`);
    info('You can install manually later: claude plugin install captain-memo@captain-memo');
    return;
  }
  ok('plugin registered with Claude Code (captain-memo@captain-memo · enabled · scope: user)');
}

function probeHealth(): void {
  const res = spawnSync('curl', ['-s', '-m', '3', 'http://127.0.0.1:39888/health'], { encoding: 'utf-8' });
  if (res.stdout.includes('"healthy":true')) ok('worker is responding on http://127.0.0.1:39888');
  else warn('worker not yet responding (initial indexing on a large corpus can take minutes — check `journalctl -u captain-memo-worker -f`)');
}

export async function installCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: captain-memo install [--user|--system]

DEFAULT: --user (no sudo)
  Embedder:    ~/.captain-memo/embed/  (Python venv + voyage-4-nano)
  Systemd:     ~/.config/systemd/user/captain-memo-{worker,embed}.service
  Config:      ~/.config/captain-memo/worker.env
  Plugin:      ~/.claude/plugins/captain-memo

WITH --system (sudo): for headless servers / multi-user / always-on boxes.
  Installs to /opt + /etc + /etc/systemd/system. Survives any user logout.

Both modes: idempotent re-runs reconfigure. To remove: captain-memo uninstall`);
    return 0;
  }

  printMiniBanner();

  // Mode: explicit flag wins; otherwise auto-detect (root → ask, non-root → user)
  let mode: InstallMode;
  if (args.includes('--system')) mode = 'system';
  else if (args.includes('--user')) mode = 'user';
  else if (process.getuid && process.getuid() === 0) {
    // Running as root without an explicit flag — ask once.
    console.log('\n\x1b[1;36mCaptain Memo install wizard\x1b[0m\n───────────────────────────');
    mode = ask('Install as user-level (recommended for personal use) or system-wide (headless server / multi-user)?', [
      { value: 'user', label: 'User-level — installs to ~/.captain-memo/, no further sudo needed', recommended: true },
      { value: 'system', label: 'System-wide — installs to /opt + /etc, runs as a system daemon' },
    ]) as InstallMode;
    // If user picked 'user' while running as root, we can't proceed (would install to /root/.captain-memo).
    if (mode === 'user' && process.getuid() === 0) {
      fail('You ran with sudo but picked user-level install. Re-run WITHOUT sudo for user-level install.');
    }
  } else {
    mode = 'user';
  }

  ensureSudoFor(mode);
  const paths = resolvePaths(mode);

  const bunPath = whichBun();
  info(`mode:   ${mode}`);
  info(`bun:    ${bunPath}`);
  info(`source: ${REPO_ROOT}`);

  let existing: Partial<WizardConfig> | undefined;
  if (existsSync(paths.envFile)) {
    info(`detected existing config: ${paths.envFile}`);
    if (askYesNo('Reconfigure (re-ask all questions)?', true)) existing = {};
    else info('keeping current config; re-running setup steps only.');
  }

  const cfg = gatherConfig(existing);

  console.log();
  header('Summary');
  info(`mode:        ${mode}`);
  info(`summarizer:  ${cfg.summarizer} (model=${cfg.summarizerModel})`);
  info(`embedder:    ${cfg.embedder} ${cfg.embedder === 'local-sidecar' ? '' : `(${cfg.embedderEndpoint})`}`);
  info(`watch:       ${cfg.watchMemory || '(none)'}`);

  const pf = preflight({ wantLocalEmbedder: cfg.embedder === 'local-sidecar' });
  const pfOk = printPreflight(pf);
  if (!pfOk) {
    console.log();
    if (!askYesNo('Some checks failed. Continue anyway?', false)) {
      info('aborted.');
      return 1;
    }
  }

  console.log();
  if (!askYesNo('Proceed with install?', true)) {
    info('aborted; nothing changed.');
    return 0;
  }

  if (cfg.embedder === 'local-sidecar') {
    header('Installing embedder sidecar');
    installEmbedder(paths);
  }

  header('Writing worker config');
  writeWorkerEnv(cfg, paths);

  header('Installing worker service');
  installWorkerService(paths, bunPath);

  header('Registering Claude Code plugin');
  registerPlugin(mode);

  header('Health probe');
  probeHealth();

  console.log();
  ok('Captain Memo installed.');
  console.log();
  info('What now:');
  info('  • Restart any open Claude Code sessions for plugin hooks to take effect.');
  info('  • Check status:  captain-memo doctor');
  info('  • View config:   captain-memo config show');
  info('  • Roll back:     captain-memo uninstall' + (mode === 'system' ? ' --system' : ''));
  if (mode === 'user') {
    console.log();
    info('Tip: to keep services running after you log out, enable lingering ONCE:');
    info('     sudo loginctl enable-linger $USER');
  }
  return 0;
}
