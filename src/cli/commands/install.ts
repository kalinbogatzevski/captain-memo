// captain-memo install — interactive plugin install wizard.
//
// Idempotent: re-running the wizard reconfigures rather than crashes.
// Asks: summarizer provider, embedder choice, memory paths to watch.
// Then installs: embedder sidecar (if chosen), worker systemd unit,
// /etc/captain-memo/worker.env, registers the plugin with Claude Code
// (~/.claude/plugins/captain-memo symlink). Re-execs under sudo where needed.

import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync, statSync, chmodSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const ETC_DIR = '/etc/captain-memo';
const ETC_WORKER_ENV = `${ETC_DIR}/worker.env`;
const SYSTEMD_DIR = '/etc/systemd/system';
const WORKER_UNIT_NAME = 'captain-memo-worker.service';
const EMBED_UNIT_NAME = 'captain-memo-embed.service';
const PLUGIN_LINK = join(homedir(), '.claude', 'plugins', 'captain-memo');

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

function whichBun(): string {
  const r = spawnSync('which', ['bun'], { encoding: 'utf-8' });
  if (r.status !== 0) fail('`bun` not found on PATH. Install bun (https://bun.com) first.');
  return r.stdout.trim();
}

function ensureSudo(): void {
  if (process.getuid && process.getuid() === 0) return;
  console.log();
  warn('This wizard needs sudo to install systemd units and /etc/captain-memo. Re-running with sudo...');
  // Re-exec under sudo, preserving env (but sudo strips most env by default — pass -E)
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

function writeWorkerEnv(cfg: WizardConfig, repoRoot: string): void {
  if (!existsSync(ETC_DIR)) mkdirSync(ETC_DIR, { recursive: true, mode: 0o755 });
  const lines: string[] = [
    '# Captain Memo worker — autogenerated by `captain-memo install`. Safe to hand-edit.',
    `CAPTAIN_MEMO_DATA_DIR=${join(homedir(), '.captain-memo')}`,
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

  writeFileSync(ETC_WORKER_ENV, lines.join('\n') + '\n', { mode: 0o644 });
  ok(`wrote ${ETC_WORKER_ENV}`);
}

function installEmbedder(repoRoot: string): void {
  const script = join(repoRoot, 'scripts/install-embedder.sh');
  if (!existsSync(script)) fail(`missing ${script}`);
  // We're already root; install-embedder.sh re-execs sudo if not, but invoke directly.
  const r = spawnSync('bash', [script], { stdio: 'inherit' });
  if (r.status !== 0) fail('embedder install failed; see output above');
  ok('embedder sidecar installed');
}

function installWorkerService(repoRoot: string, bunPath: string): void {
  const { user, group } = realUserAndGroup();
  const tplPath = join(repoRoot, 'services/worker/systemd/captain-memo-worker.service');
  let unit = readFileSync(tplPath, 'utf-8');
  unit = unit
    .replaceAll('__USER__', user)
    .replaceAll('__GROUP__', group)
    .replaceAll('__INSTALL_DIR__', repoRoot)
    .replaceAll('__BUN__', bunPath);
  writeFileSync(join(SYSTEMD_DIR, WORKER_UNIT_NAME), unit, { mode: 0o644 });
  ok(`wrote ${SYSTEMD_DIR}/${WORKER_UNIT_NAME}`);
  spawnSync('systemctl', ['daemon-reload'], { stdio: 'inherit' });
  spawnSync('systemctl', ['enable', WORKER_UNIT_NAME], { stdio: 'inherit' });
  spawnSync('systemctl', ['restart', WORKER_UNIT_NAME], { stdio: 'inherit' });
  ok(`worker service enabled + started (${WORKER_UNIT_NAME})`);
}

function registerPlugin(repoRoot: string): void {
  const { home, user, group } = realUserAndGroup();
  const pluginsDir = join(home, '.claude', 'plugins');
  const link = join(pluginsDir, 'captain-memo');
  spawnSync('mkdir', ['-p', pluginsDir], { stdio: 'inherit' });
  spawnSync('chown', [`${user}:${group}`, pluginsDir], { stdio: 'inherit' });
  if (existsSync(link)) {
    try { unlinkSync(link); } catch {/* may be a real dir; require manual remove */}
  }
  // Symlink the plugin source into ~/.claude/plugins/captain-memo
  symlinkSync(repoRoot, link);
  spawnSync('chown', ['-h', `${user}:${group}`, link], { stdio: 'inherit' });
  ok(`registered plugin: ${link} -> ${repoRoot}`);
}

function probeHealth(): void {
  const res = spawnSync('curl', ['-s', '-m', '3', 'http://127.0.0.1:39888/health'], { encoding: 'utf-8' });
  if (res.stdout.includes('"healthy":true')) ok('worker is responding on http://127.0.0.1:39888');
  else warn('worker not yet responding (initial indexing on a large corpus can take minutes — check `journalctl -u captain-memo-worker -f`)');
}

export async function installCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: captain-memo install [--non-interactive] [--reconfigure]

Interactively installs Captain Memo end-to-end:
  - Optional embedder sidecar (voyage-4-nano via FastAPI on :8124)
  - Worker systemd service (HTTP search + observation pipeline on :39888)
  - Claude Code plugin registration (~/.claude/plugins/captain-memo symlink)
  - /etc/captain-memo/worker.env with your chosen summarizer + embedder

Re-running reconfigures. To remove everything: captain-memo uninstall`);
    return 0;
  }

  ensureSudo();

  const bunPath = whichBun();
  info(`bun: ${bunPath}`);
  info(`source: ${REPO_ROOT}`);

  // Load existing config (if any) so re-runs can use prior answers as defaults.
  let existing: Partial<WizardConfig> | undefined;
  if (existsSync(ETC_WORKER_ENV)) {
    info(`detected existing config: ${ETC_WORKER_ENV}`);
    if (askYesNo('Reconfigure (re-ask all questions)?', true)) existing = {};
    else { info('keeping current config; re-running setup steps only.'); }
  }

  const cfg = gatherConfig(existing);

  console.log();
  header('Summary');
  info(`summarizer:  ${cfg.summarizer} (model=${cfg.summarizerModel})`);
  info(`embedder:    ${cfg.embedder} ${cfg.embedder === 'local-sidecar' ? '' : `(${cfg.embedderEndpoint})`}`);
  info(`watch:       ${cfg.watchMemory || '(none)'}`);
  console.log();
  if (!askYesNo('Proceed with install?', true)) {
    info('aborted; nothing changed.');
    return 0;
  }

  // 1. embedder
  if (cfg.embedder === 'local-sidecar') {
    header('Installing embedder sidecar');
    installEmbedder(REPO_ROOT);
  }

  // 2. /etc/captain-memo/worker.env
  header('Writing worker config');
  writeWorkerEnv(cfg, REPO_ROOT);

  // 3. worker systemd
  header('Installing worker service');
  installWorkerService(REPO_ROOT, bunPath);

  // 4. claude code plugin
  header('Registering Claude Code plugin');
  registerPlugin(REPO_ROOT);

  // 5. health
  header('Health probe');
  probeHealth();

  console.log();
  ok('Captain Memo installed.');
  console.log();
  info('What now:');
  info('  • Restart any open Claude Code sessions for plugin hooks to take effect.');
  info('  • Check status:  captain-memo doctor');
  info('  • View config:   captain-memo config show');
  info('  • Roll back:     captain-memo uninstall');
  return 0;
}
