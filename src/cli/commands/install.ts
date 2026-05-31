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
// Idempotent: re-running PRESERVES existing config (flags/env override) rather than resetting to defaults or crashing.

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync, statSync, chmodSync, readdirSync, copyFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { printMiniBanner } from '../banner.ts';
import { isWindows, totalMemGb, diskFreeGb, whichBun as probeBun } from '../../shared/platform.ts';
import { WORKER_ENV_PATH, CONFIG_DIR, LOGS_DIR, DATA_DIR, DEFAULT_WORKER_PORT } from '../../shared/paths.ts';
import { getServiceManager } from '../../services/service-manager/index.ts';
import { grantPluginToolPermissions } from './install-hooks.ts';
import { getEmbedderInstaller } from '../../services/embedder-installer/index.ts';

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

// 'claude-oauth' is a runtime-valid provider offered by the wizard prompt (and a
// documented --summarizer value) even though writeWorkerEnv just passes the
// string straight through; keep it in the union so flag parsing is type-checked.
type SummarizerProvider = 'claude-oauth' | 'claude-code' | 'anthropic' | 'openai-compatible' | 'skip';
type EmbedderProvider = 'voyage-hosted' | 'local-sidecar' | 'openai-compatible' | 'skip';
type WatchPaths = 'all-projects' | 'user-global' | 'custom' | 'skip';

// Parsed CLI flags + env fallbacks that let the wizard run headless (no TTY /
// CI / worker spawning the installer). Every field is optional — an absent
// field falls back to env, then interactive prompt (TTY only), then default.
interface InstallOptions {
  // Accept defaults for anything unspecified and NEVER prompt.
  yes: boolean;
  // True when we must not call prompt() at all: --yes was passed OR stdin is
  // not a TTY (a piped/headless invocation would hang on prompt()).
  nonInteractive: boolean;
  embedder?: EmbedderProvider;
  voyageKey?: string;
  voyageModel?: string;
  embeddingDim?: number;
  summarizer?: SummarizerProvider;
  openaiEndpoint?: string;
  openaiKey?: string;
  // Raw --watch value: 'all-projects' | 'none' | <glob/path>. 'none' → skip.
  watch?: string;
  // Skip adding captain-memo's MCP tools to the user's settings `permissions.allow`.
  noGrantPermissions?: boolean;
}

const SUMMARIZER_VALUES: readonly SummarizerProvider[] = ['claude-oauth', 'anthropic', 'claude-code', 'openai-compatible', 'skip'];
const EMBEDDER_VALUES: readonly EmbedderProvider[] = ['voyage-hosted', 'local-sidecar', 'openai-compatible', 'skip'];

// Pull the value following a flag (`--flag value`). Returns undefined if the
// flag is absent; fails loudly if the flag is present but the value is missing
// (next token is another flag or end of args) so typos surface immediately.
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('-')) {
    fail(`${flag} requires a value (e.g. \`${flag} <value>\`).`);
  }
  return v;
}

function parseEnum<T extends string>(raw: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (raw === undefined) return undefined;
  if (!allowed.includes(raw as T)) {
    fail(`invalid value for ${flag}: '${raw}'. Allowed: ${allowed.join(' | ')}.`);
  }
  return raw as T;
}

function parseIntFlag(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    fail(`invalid value for ${flag}: '${raw}'. Expected a positive integer.`);
  }
  return n;
}

// Build InstallOptions from argv + CAPTAIN_MEMO_* env. Precedence baked in here
// is flag > env; the prompt-vs-default fallback happens later in gatherConfig.
// Exported so flag parsing can be unit-tested without running a real install.
export function parseInstallOptions(args: string[], env: NodeJS.ProcessEnv = process.env): InstallOptions {
  const yes = args.includes('--yes') || args.includes('-y');
  // stdin can be undefined in odd runtimes; treat "no isTTY" as non-interactive.
  const isTTY = Boolean(process.stdin && (process.stdin as { isTTY?: boolean }).isTTY);
  const nonInteractive = yes || !isTTY;

  const embedder = parseEnum(
    flagValue(args, '--embedder') ?? env.CAPTAIN_MEMO_EMBEDDER,
    EMBEDDER_VALUES,
    '--embedder',
  );
  const summarizer = parseEnum(
    flagValue(args, '--summarizer') ?? env.CAPTAIN_MEMO_SUMMARIZER_PROVIDER,
    SUMMARIZER_VALUES,
    '--summarizer',
  );
  const embeddingDim = parseIntFlag(
    flagValue(args, '--embedding-dim') ?? env.CAPTAIN_MEMO_EMBEDDING_DIM,
    '--embedding-dim',
  );

  const opts: InstallOptions = { yes, nonInteractive };
  if (embedder !== undefined) opts.embedder = embedder;
  if (summarizer !== undefined) opts.summarizer = summarizer;
  if (embeddingDim !== undefined) opts.embeddingDim = embeddingDim;

  const voyageKey = flagValue(args, '--voyage-key') ?? env.CAPTAIN_MEMO_EMBEDDER_API_KEY;
  if (voyageKey !== undefined) opts.voyageKey = voyageKey;
  const voyageModel = flagValue(args, '--voyage-model') ?? env.CAPTAIN_MEMO_EMBEDDER_MODEL;
  if (voyageModel !== undefined) opts.voyageModel = voyageModel;
  const openaiEndpoint = flagValue(args, '--openai-endpoint') ?? env.CAPTAIN_MEMO_OPENAI_ENDPOINT;
  if (openaiEndpoint !== undefined) opts.openaiEndpoint = openaiEndpoint;
  const openaiKey = flagValue(args, '--openai-key') ?? env.CAPTAIN_MEMO_OPENAI_API_KEY;
  if (openaiKey !== undefined) opts.openaiKey = openaiKey;
  const watch = flagValue(args, '--watch') ?? env.CAPTAIN_MEMO_WATCH_MEMORY;
  if (watch !== undefined) opts.watch = watch;

  if (args.includes('--no-grant-permissions')) opts.noGrantPermissions = true;

  return opts;
}

interface WizardConfig {
  summarizer: SummarizerProvider;
  anthropicApiKey?: string;
  summarizerOpenaiEndpoint?: string;
  summarizerOpenaiKey?: string;
  summarizerModel: string;
  embedder: EmbedderProvider;
  embedderEndpoint: string;
  embedderModel: string;
  embedderApiKey?: string;
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

// --- non-interactive resolvers -------------------------------------------
// Each resolver returns the pre-supplied value when one exists (from flag/env,
// already merged in parseInstallOptions). Otherwise it prompts ONLY when
// interactive; in non-interactive mode it returns the default without touching
// prompt() (which would hang on a non-TTY stdin).

// Choice: pre-supplied wins; else prompt (interactive) / default value (headless).
function resolveChoice<T extends string>(
  preset: T | undefined,
  nonInteractive: boolean,
  question: string,
  options: { value: string; label: string; recommended?: boolean }[],
  defaultIdx = 0,
): T {
  if (preset !== undefined) return preset;
  if (nonInteractive) return options[defaultIdx]!.value as T;
  return ask(question, options, defaultIdx) as T;
}

// Free text: pre-supplied wins; else prompt (interactive) / default (headless).
function resolveText(
  preset: string | undefined,
  nonInteractive: boolean,
  question: string,
  defaultValue: string,
): string {
  if (preset !== undefined) return preset;
  if (nonInteractive) return defaultValue;
  return askText(question, defaultValue);
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

  // The remaining hardware checks (CPU SIMD, RAM, disk for the venv,
  // outbound network for PyPI/HuggingFace) only matter for the local
  // embedder. With a hosted backend, the embedding actually happens on
  // someone else's GPUs — local CPU/RAM/disk are irrelevant. Gate so we
  // don't scare hosted-path users with warnings that don't apply.
  if (!opts.wantLocalEmbedder) {
    return out;
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
  // Windows has no getent/id and no concept of a unix primary group; gatherConfig()
  // only needs `home` (to build the default watch globs). Resolve it natively and
  // never shell out to POSIX tools.
  if (isWindows) {
    const u = process.env.USERNAME ?? process.env.USER ?? '';
    return { user: u, group: u, home: homedir() };
  }
  const u = process.env.SUDO_USER ?? process.env.USER ?? '';
  if (!u) fail('Cannot determine the real user (SUDO_USER unset).');
  const home = spawnSync('getent', ['passwd', u], { encoding: 'utf-8' }).stdout.split(':')[5] ?? '';
  // group = primary group of user
  const groupId = spawnSync('id', ['-gn', u], { encoding: 'utf-8' }).stdout.trim();
  return { user: u, group: groupId || u, home: home.trim() };
}

// Reverse of workerEnvLines(): parse an existing worker.env back into a partial
// WizardConfig so a re-install / upgrade PRESERVES the user's settings (API keys,
// models, endpoints, summarizer, watch paths) instead of rewriting from defaults.
// Only keys actually present are returned — anything missing stays undefined so
// gatherConfig falls back to flag → env → default. This is what stops `install
// --yes` from silently dropping the API key (and summarizer/watch) on upgrade.
export function loadExistingConfig(envPath: string): Partial<WizardConfig> {
  if (!existsSync(envPath)) return {};
  const map: Record<string, string> = {};
  try {
    for (const raw of readFileSync(envPath, 'utf-8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // Strip matching surrounding quotes (length>=2 so a lone quote isn't eaten).
      if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) val = val.slice(1, -1);
      map[key] = val;
    }
  } catch (e) {
    // Best-effort: an unreadable worker.env must not abort the upgrade with a raw
    // stack trace — degrade to "no existing values" (flags/env/defaults still apply).
    warn(`could not read existing ${envPath} (${(e as Error).message}); proceeding without preserving its values`);
    return {};
  }

  // Is this actually a captain-memo worker.env? The "skip" choices are encoded as
  // the ABSENCE of a line (workerEnvLines omits the provider line for summarizer=skip
  // and the watch line for watch=skip — and the worker treats an unknown provider as
  // "fall back to default", so we must NOT write a literal `=skip`). So on one of our
  // files, a missing provider/watch line means the user chose skip — infer it back.
  const isOurs = Object.keys(map).some((k) => k.startsWith('CAPTAIN_MEMO_'));

  const cfg: Partial<WizardConfig> = {};
  // ----- embedder (provider inferred from endpoint/model; not stored directly) -----
  const endpoint = map['CAPTAIN_MEMO_EMBEDDER_ENDPOINT'];
  // Only a LOOPBACK :8124 is our local sidecar — a remote host on :8124 is a normal
  // openai-compatible endpoint and must not be misclassified (which would drop it).
  const isLocalSidecar = !!endpoint && (endpoint.includes('127.0.0.1:8124') || endpoint.includes('localhost:8124'));
  if (map['CAPTAIN_MEMO_SKIP_EMBED'] === '1') cfg.embedder = 'skip';
  else if (endpoint?.includes('voyageai.com')) cfg.embedder = 'voyage-hosted';
  else if (isLocalSidecar || map['CAPTAIN_MEMO_EMBEDDER_MODEL']?.includes('voyage-4-nano')) cfg.embedder = 'local-sidecar';
  else if (endpoint) cfg.embedder = 'openai-compatible';
  if (endpoint) cfg.embedderEndpoint = endpoint;
  if (map['CAPTAIN_MEMO_EMBEDDER_MODEL']) cfg.embedderModel = map['CAPTAIN_MEMO_EMBEDDER_MODEL'];
  if (map['CAPTAIN_MEMO_EMBEDDER_API_KEY']) cfg.embedderApiKey = map['CAPTAIN_MEMO_EMBEDDER_API_KEY'];
  const dim = Number(map['CAPTAIN_MEMO_EMBEDDING_DIM']);
  if (map['CAPTAIN_MEMO_EMBEDDING_DIM'] && Number.isFinite(dim)) cfg.embeddingDimension = dim;
  // ----- summarizer (skip == no provider line on one of our files) -----
  if (map['CAPTAIN_MEMO_SUMMARIZER_PROVIDER']) cfg.summarizer = map['CAPTAIN_MEMO_SUMMARIZER_PROVIDER'] as SummarizerProvider;
  else if (isOurs) cfg.summarizer = 'skip';
  if (map['CAPTAIN_MEMO_SUMMARIZER_MODEL']) cfg.summarizerModel = map['CAPTAIN_MEMO_SUMMARIZER_MODEL'];
  if (map['ANTHROPIC_API_KEY']) cfg.anthropicApiKey = map['ANTHROPIC_API_KEY'];
  if (map['CAPTAIN_MEMO_OPENAI_ENDPOINT']) cfg.summarizerOpenaiEndpoint = map['CAPTAIN_MEMO_OPENAI_ENDPOINT'];
  if (map['CAPTAIN_MEMO_OPENAI_API_KEY']) cfg.summarizerOpenaiKey = map['CAPTAIN_MEMO_OPENAI_API_KEY'];
  // ----- watch (skip == no watch line on one of our files; '' is the skip choice) -----
  if (map['CAPTAIN_MEMO_WATCH_MEMORY']) cfg.watchMemory = map['CAPTAIN_MEMO_WATCH_MEMORY'];
  else if (isOurs) cfg.watchMemory = '';
  const hto = Number(map['CAPTAIN_MEMO_HOOK_TIMEOUT_MS']);
  if (map['CAPTAIN_MEMO_HOOK_TIMEOUT_MS'] && Number.isFinite(hto)) cfg.hookTimeoutMs = hto;
  // NOTE: CAPTAIN_MEMO_DATA_DIR / PROJECT_ID / WORKER_PORT are intentionally NOT
  // preserved — they are fixed/computed, not WizardConfig fields. A hand-edited
  // DATA_DIR is reset to the standard location on re-install (rare; documented).
  return cfg;
}

export function gatherConfig(existing?: Partial<WizardConfig>, opts?: InstallOptions): WizardConfig {
  // Default to interactive (TTY) behaviour when no options were threaded
  // through — preserves the original prompt-everything path exactly.
  const nonInteractive = opts?.nonInteractive ?? false;
  header('Captain Memo install wizard');
  if (nonInteractive) info('Non-interactive mode — using flags/env/defaults (no prompts).');
  else info('A few questions, then I install everything in one go.');

  // ----- summarizer -----
  const summarizer = resolveChoice<SummarizerProvider>(
    opts?.summarizer ?? (nonInteractive ? existing?.summarizer : undefined),
    nonInteractive,
    'Which summarizer should I use to compress session events into observations?',
    [
      { value: 'claude-oauth', label: 'Claude Max plan via OAuth (~700 ms/call, no API key, requires `claude login`)', recommended: true },
      { value: 'anthropic', label: 'Anthropic API (paid, sub-second, needs ANTHROPIC_API_KEY)' },
      { value: 'claude-code', label: 'Claude Code subprocess (`claude -p`) — slower but works without OAuth file' },
      { value: 'openai-compatible', label: 'OpenAI / Ollama / OpenRouter / etc. (any /v1/chat/completions)' },
      { value: 'skip', label: "Skip — events queue but don't summarize" },
    ],
  );

  let anthropicApiKey: string | undefined;
  let summarizerOpenaiEndpoint: string | undefined;
  let summarizerOpenaiKey: string | undefined;
  let summarizerModel = 'claude-haiku-4-5';
  if (summarizer === 'anthropic') {
    // No dedicated key flag; fall back to existing config then ANTHROPIC_API_KEY
    // env (used as the prompt default interactively, returned directly headless).
    const anthropicDefault = existing?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    anthropicApiKey = resolveText(undefined, nonInteractive, 'Anthropic API key (sk-ant-...)', anthropicDefault);
    summarizerModel = resolveText(undefined, nonInteractive, 'Summarizer model', (existing?.summarizer === 'anthropic' ? existing?.summarizerModel : undefined) ?? 'claude-haiku-4-5');
  } else if (summarizer === 'openai-compatible') {
    summarizerOpenaiEndpoint = resolveText(opts?.openaiEndpoint, nonInteractive, 'OpenAI-compatible endpoint URL', existing?.summarizerOpenaiEndpoint ?? 'http://localhost:11434/v1/chat/completions');
    summarizerOpenaiKey = resolveText(opts?.openaiKey, nonInteractive, 'API key (leave blank for local servers)', existing?.summarizerOpenaiKey ?? '');
    summarizerModel = resolveText(undefined, nonInteractive, 'Summarizer model', existing?.summarizerModel ?? 'qwen2.5:14b-instruct');
  }

  // ----- embedder -----
  const embedder = resolveChoice<EmbedderProvider>(
    opts?.embedder ?? (nonInteractive ? existing?.embedder : undefined),
    nonInteractive,
    'Which embedder should I use for vector search?',
    [
      { value: 'voyage-hosted', label: 'Voyage hosted API (fast on any hardware, ~$0.30/year typical use, needs free API key)', recommended: true },
      { value: 'local-sidecar', label: 'Local voyage-4-nano sidecar (private, free, but ~6 GB install + needs AVX2 CPU)' },
      { value: 'openai-compatible', label: 'External /v1/embeddings (Ollama / OpenAI / OpenRouter / your own)' },
      { value: 'skip', label: 'Skip — keyword-only retrieval (works without any embedder)' },
    ],
  );

  let embedderEndpoint = 'http://127.0.0.1:8124/v1/embeddings';
  let embedderModel = 'voyageai/voyage-4-nano';
  let embedderApiKey: string | undefined;
  let embeddingDimension = 2048;
  if (embedder === 'voyage-hosted') {
    embedderEndpoint = 'https://api.voyageai.com/v1/embeddings';
    embedderModel = resolveText(
      opts?.voyageModel,
      nonInteractive,
      'Voyage model (voyage-4-lite recommended — fast, cheap, 1024-dim)',
      existing?.embedderModel?.startsWith('voyage-') ? existing.embedderModel : 'voyage-4-lite',
    );
    embeddingDimension = opts?.embeddingDim ?? Number(resolveText(undefined, nonInteractive, 'Embedding dimension (voyage-4-lite default 1024)', String(existing?.embeddingDimension ?? 1024)));
    embedderApiKey = resolveText(
      opts?.voyageKey,
      nonInteractive,
      'Voyage API key (get one free at https://dash.voyageai.com — paste it here, or leave blank to set via worker.env later)',
      existing?.embedderApiKey ?? '',
    );
    if (!embedderApiKey) {
      // A keyless hosted-Voyage worker.env can't actually embed — the worker
      // will fail every call until a key lands. Loud, explicit warning matters
      // most in non-interactive installs where nobody is reading prompts.
      if (nonInteractive) {
        warn('hosted Voyage selected but NO API key (no --voyage-key / CAPTAIN_MEMO_EMBEDDER_API_KEY) — worker.env will be keyless and the embedder WILL fail until you add CAPTAIN_MEMO_EMBEDDER_API_KEY and restart the worker.');
      } else {
        console.log('  (no key entered — worker.env will be written without one; add it manually before starting)');
      }
    }
  } else if (embedder === 'openai-compatible') {
    embedderEndpoint = resolveText(opts?.openaiEndpoint, nonInteractive, 'Embedder endpoint URL', existing?.embedderEndpoint ?? 'http://localhost:11434/v1/embeddings');
    embedderModel = resolveText(opts?.voyageModel, nonInteractive, 'Embedder model', existing?.embedderModel ?? 'nomic-embed-text');
    embeddingDimension = opts?.embeddingDim ?? Number(resolveText(undefined, nonInteractive, 'Embedding dimension', String(existing?.embeddingDimension ?? 768)));
    embedderApiKey = resolveText(opts?.openaiKey, nonInteractive, 'API key (leave blank for local servers like Ollama)', existing?.embedderApiKey ?? '');
  } else if (embedder === 'skip') {
    embeddingDimension = 8; // dummy for the vec0 table
  }

  // ----- watch paths -----
  // --watch carries either a keyword ('all-projects'/'none') or a literal
  // glob/path. Map keyword → choice; anything else is treated as a custom path.
  const { home } = realUserAndGroup();
  const allProjectsGlob = join(home, '.claude/projects/*/memory/*.md');
  const userGlobalGlob = join(home, '.claude/memory/*.md');
  let watchChoice: WatchPaths;
  let watchPreset: string | undefined;
  if (opts?.watch !== undefined) {
    if (opts.watch === 'all-projects') watchChoice = 'all-projects';
    else if (opts.watch === 'none') watchChoice = 'skip';
    else { watchChoice = 'custom'; watchPreset = opts.watch; }
  } else {
    // Preserve the prior choice on a non-interactive re-install (derive it from the
    // existing watch glob) so `--yes` doesn't reset skip/custom/user-global to the
    // recommended 'all-projects'. '' is the skip choice (see loadExistingConfig).
    const ew = existing?.watchMemory;
    let existingChoice: WatchPaths | undefined;
    if (ew === undefined) existingChoice = undefined;
    else if (ew === '') existingChoice = 'skip';
    else if (ew === allProjectsGlob) existingChoice = 'all-projects';
    else if (ew === userGlobalGlob) existingChoice = 'user-global';
    else existingChoice = 'custom';
    if (existingChoice === 'custom') watchPreset = ew;
    watchChoice = resolveChoice<WatchPaths>(
      nonInteractive ? existingChoice : undefined,
      nonInteractive,
      'Which directories should the worker watch for memory files?',
      [
        { value: 'all-projects', label: 'All Claude project memories (~/.claude/projects/*/memory/*.md)', recommended: true },
        { value: 'user-global', label: 'User-global only (~/.claude/memory/*.md)' },
        { value: 'custom', label: 'Custom paths (I prompt for them)' },
        { value: 'skip', label: 'Skip watching — observations only' },
      ],
    );
  }
  let watchMemory = '';
  if (watchChoice === 'all-projects') watchMemory = allProjectsGlob;
  else if (watchChoice === 'user-global') watchMemory = userGlobalGlob;
  else if (watchChoice === 'custom') watchMemory = resolveText(watchPreset, nonInteractive, 'Comma-separated glob patterns', existing?.watchMemory ?? userGlobalGlob);

  return {
    summarizer,
    ...(anthropicApiKey !== undefined && { anthropicApiKey }),
    ...(summarizerOpenaiEndpoint !== undefined && { summarizerOpenaiEndpoint }),
    ...(summarizerOpenaiKey !== undefined && summarizerOpenaiKey !== '' && { summarizerOpenaiKey }),
    summarizerModel,
    embedder,
    embedderEndpoint,
    embedderModel,
    ...(embedderApiKey !== undefined && embedderApiKey !== '' && { embedderApiKey }),
    embeddingDimension,
    watchMemory,
    hookTimeoutMs: existing?.hookTimeoutMs ?? 2000, // preserve a tuned value; generous default otherwise
  };
}

// Build the worker.env file body (key=value lines) for a given data dir. Shared
// by the Linux writeWorkerEnv() and the Windows installWindows() path so both
// emit byte-for-byte identical content from the same config.
function workerEnvLines(cfg: WizardConfig, dataDir: string): string[] {
  const lines: string[] = [
    '# Captain Memo worker — autogenerated by `captain-memo install`. Safe to hand-edit.',
    `CAPTAIN_MEMO_DATA_DIR=${dataDir}`,
    `CAPTAIN_MEMO_PROJECT_ID=default`,
    `CAPTAIN_MEMO_WORKER_PORT=39888`,
    `CAPTAIN_MEMO_HOOK_TIMEOUT_MS=${cfg.hookTimeoutMs}`,
  ];
  if (cfg.summarizer === 'skip') {
    // User explicitly opted out of summarization. Don't lie to the worker by
    // writing 'anthropic' — it would log "summarizer disabled" anyway because
    // ANTHROPIC_API_KEY isn't set, but the user's intent should be honored
    // explicitly. The worker silently drops queue events when no provider
    // resolves, which matches the "skip" semantic; document it in worker.env.
    lines.push(`# Summarizer disabled by install wizard — observations queue but no summary chunk is produced.`);
    lines.push(`# Re-enable later by replacing this block with one of: claude-code | anthropic | openai-compatible.`);
  } else {
    lines.push(`CAPTAIN_MEMO_SUMMARIZER_PROVIDER=${cfg.summarizer}`);
    lines.push(`CAPTAIN_MEMO_SUMMARIZER_MODEL=${cfg.summarizerModel}`);
    if (cfg.summarizer === 'anthropic' && cfg.anthropicApiKey) {
      lines.push(`ANTHROPIC_API_KEY=${cfg.anthropicApiKey}`);
    }
    if (cfg.summarizer === 'openai-compatible') {
      lines.push(`CAPTAIN_MEMO_OPENAI_ENDPOINT=${cfg.summarizerOpenaiEndpoint}`);
      if (cfg.summarizerOpenaiKey) lines.push(`CAPTAIN_MEMO_OPENAI_API_KEY=${cfg.summarizerOpenaiKey}`);
    }
  }
  if (cfg.embedder === 'skip') {
    lines.push(`CAPTAIN_MEMO_SKIP_EMBED=1`);
  } else {
    lines.push(`CAPTAIN_MEMO_EMBEDDER_ENDPOINT=${cfg.embedderEndpoint}`);
    lines.push(`CAPTAIN_MEMO_EMBEDDER_MODEL=${cfg.embedderModel}`);
    lines.push(`CAPTAIN_MEMO_EMBEDDING_DIM=${cfg.embeddingDimension}`);
    if (cfg.embedderApiKey) {
      lines.push(`CAPTAIN_MEMO_EMBEDDER_API_KEY=${cfg.embedderApiKey}`);
    }
  }
  if (cfg.watchMemory) lines.push(`CAPTAIN_MEMO_WATCH_MEMORY=${cfg.watchMemory}`);
  return lines;
}

function writeWorkerEnv(cfg: WizardConfig, paths: ModePaths): void {
  const dir = dirname(paths.envFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
  const dataDir = paths.mode === 'user'
    ? join(homedir(), '.captain-memo')
    : join(homedir(), '.captain-memo'); // same for both — data lives in the user's home
  const lines = workerEnvLines(cfg, dataDir);

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

function installCliShim(mode: InstallMode): void {
  // System mode: /usr/local/bin (universal PATH).
  // User mode:   ~/.local/bin (on PATH on every modern Linux desktop via
  //              ~/.profile; we still warn if the user has an unusual setup).
  const linkDir = mode === 'system'
    ? '/usr/local/bin'
    : join(homedir(), '.local/bin');
  const linkPath = join(linkDir, 'captain-memo');
  const target = join(REPO_ROOT, 'bin/captain-memo');

  if (!existsSync(linkDir)) mkdirSync(linkDir, { recursive: true });

  // Idempotent — drop any existing entry (regular file, symlink, or broken link)
  // before re-linking so re-running the wizard never fails on EEXIST.
  try { lstatSync(linkPath); unlinkSync(linkPath); } catch { /* not present */ }

  symlinkSync(target, linkPath);
  ok(`linked ${linkPath} → ${target}`);

  if (mode === 'user') {
    const pathParts = (process.env.PATH ?? '').split(':');
    if (!pathParts.includes(linkDir)) {
      warn(`${linkDir} is not on your PATH; add this to ~/.bashrc or ~/.zshrc:`);
      info(`  export PATH="$HOME/.local/bin:$PATH"`);
    }
  }
}

/** The exact `claude` command sequence registerPlugin() runs, as arg arrays.
 *  Pure + exported so the cache-refresh contract is unit-testable without
 *  spawning `claude`: the remove MUST precede the add (that's the whole fix —
 *  a bare `add` is a no-op on an existing entry, so the cache stays frozen),
 *  and the remove is scoped to `user` so it never wipes a project/local-scoped
 *  marketplace declaration the user set up deliberately. */
export function pluginRegistrationSteps(repoRoot: string): string[][] {
  return [
    ['plugin', 'marketplace', 'remove', 'captain-memo', '--scope', 'user'],
    ['plugin', 'marketplace', 'add', repoRoot],
    ['plugin', 'install', 'captain-memo@captain-memo'],
  ];
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
  const runAsUser = (cmd: string, args: string[], opts: { quiet?: boolean } = {}) => {
    // quiet → capture output instead of inheriting the terminal. Used for the
    // best-effort marketplace-remove below, whose "marketplace not found" on a
    // fresh install is expected and shouldn't alarm the user.
    const stdio = opts.quiet ? 'pipe' : 'inherit';
    // Windows: no sudo / no privilege-drop — always run `claude` directly as the
    // current user. (`mode` is always 'user' on the Windows fork.)
    if (!isWindows && mode === 'system' && process.env.SUDO_USER) {
      return spawnSync('sudo', ['-u', process.env.SUDO_USER, '-E', cmd, ...args], { stdio });
    }
    return spawnSync(cmd, args, { stdio });
  };

  // Force a fresh copy of the plugin into Claude Code's cache on EVERY install/upgrade.
  // A `directory`-source marketplace is snapshotted at add-time; a bare `marketplace add`
  // is a no-op once the entry exists, so a plugin file that changed since the marketplace
  // was first added (notably hooks.json) stays FROZEN in the cache and the hooks keep
  // launching the OLD command. This is exactly what broke after the bin/→dist/ hook move:
  // caches first added at 0.1.0 kept invoking the since-deleted `bin/captain-memo-hook`.
  // Removing first guarantees the `add` below re-copies the current plugin. Best-effort
  // and quiet — on a fresh install there's nothing to remove and that non-zero exit is fine.
  // (Scoped to `user` so a project/local-scoped declaration is left untouched.)
  const steps = pluginRegistrationSteps(REPO_ROOT);
  runAsUser('claude', steps[0]!, { quiet: true });

  // Idempotent — if the marketplace already exists, claude prints a notice and exits 0.
  const r1 = runAsUser('claude', steps[1]!);
  if (r1.status !== 0) {
    warn(`'claude plugin marketplace add' failed (exit ${r1.status})`);
    info('You can register manually later:');
    info(`  claude plugin marketplace add ${REPO_ROOT}`);
    info(`  claude plugin install captain-memo@captain-memo`);
    return;
  }

  const r2 = runAsUser('claude', steps[2]!);
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

// --- Windows install (native; no systemd / no sudo) -------------------------
// Forked from installCommand() so the Linux systemd/sudo/POSIX flow stays
// byte-for-byte untouched. Supervision is per-user Scheduled Tasks via the
// ServiceManager abstraction; secrets reach the worker via worker.env +
// loadWorkerEnv() (no EnvironmentFile= equivalent on Windows).
// Add captain-memo's MCP tools to the user's settings `permissions.allow` so the
// agent can call them without a per-call prompt — and so "don't ask" mode doesn't
// auto-deny them. A plugin can't self-grant via `claude plugin install`, but this
// user-run installer can. Best-effort: a settings-write failure never aborts install.
function grantMcpPermissions(opts: InstallOptions, settingsPath: string): void {
  if (opts.noGrantPermissions) { info('skipped MCP-tool permission grant (--no-grant-permissions)'); return; }
  try {
    const { added } = grantPluginToolPermissions(settingsPath);
    ok(added
      ? `allowed captain-memo's MCP tools in ${settingsPath} (no per-call prompts)`
      : `captain-memo's MCP tools already allowed in ${settingsPath}`);
  } catch (e) {
    warn(`couldn't update permissions in ${settingsPath}: ${(e as Error).message}`);
    info('Allow them manually: add "mcp__plugin_captain-memo_captain-memo__*" to permissions.allow');
  }
}

async function installWindows(args: string[], opts: InstallOptions): Promise<number> {
  printMiniBanner();

  // The captain-memo project/plugin root (where src/worker/index.ts lives).
  const INSTALL_DIR = resolve(import.meta.dir, '../../..');
  const port = DEFAULT_WORKER_PORT;

  // Preflight: the ONLY hard requirement is bun on PATH. Never call
  // uname/systemctl/sudo/getent/df or read /proc.
  let bunPath: string;
  try {
    bunPath = probeBun();
  } catch {
    fail('`bun` not found. Install bun (https://bun.com) first, then re-run.');
  }
  // probeBun() returns process.execPath as a last resort, so guard against a
  // path that doesn't actually exist.
  if (!bunPath || !existsSync(bunPath)) {
    fail('`bun` not found on PATH. Install bun (https://bun.com) first, then re-run.');
  }
  info(`bun:    ${bunPath}`);
  info(`source: ${INSTALL_DIR}`);

  let existing: Partial<WizardConfig> | undefined;
  if (existsSync(WORKER_ENV_PATH)) {
    info(`detected existing config: ${WORKER_ENV_PATH}`);
    // Re-installing: load the existing config as the fallback so an upgrade NEVER
    // drops the user's settings (API key, models, endpoints, watch paths) — flags
    // and env still override. (Passing {} here was the bug: `install --yes` rewrote
    // worker.env from defaults and silently produced a keyless, non-embedding file.)
    if (opts.nonInteractive || askYesNo('Reconfigure (re-ask all questions)?', true)) existing = loadExistingConfig(WORKER_ENV_PATH);
    else info('keeping current config; re-running setup steps only.');
  }

  // gatherConfig() is the same wizard the Linux path uses; opts make it headless.
  const cfg = gatherConfig(existing, opts);

  console.log();
  header('Summary');
  info(`mode:        windows (per-user Scheduled Task)`);
  info(`summarizer:  ${cfg.summarizer} (model=${cfg.summarizerModel})`);
  info(`embedder:    ${cfg.embedder} ${cfg.embedder === 'local-sidecar' ? '' : `(${cfg.embedderEndpoint})`}`);
  info(`watch:       ${cfg.watchMemory || '(none)'}`);

  // Hardware checks only matter for the LOCAL embedder (hosted runs on someone
  // else's GPUs — local CPU/RAM/disk are irrelevant). Use platform.ts probes;
  // these are warnings only (non-fatal), matching the Linux WARN semantics.
  if (cfg.embedder === 'local-sidecar') {
    console.log();
    console.log('\x1b[1mPre-flight checks\x1b[0m');

    // Python 3.11+ for the sidecar venv. `py -3.11` is the Windows launcher idiom;
    // fall back to bare `python`. Non-fatal warn (install-embedder.ps1 re-checks).
    let pyOut = '';
    const pyLauncher = spawnSync('py', ['-3.11', '--version'], { encoding: 'utf-8' });
    if (pyLauncher.status === 0) pyOut = (pyLauncher.stdout || pyLauncher.stderr).trim();
    else {
      const py = spawnSync('python', ['--version'], { encoding: 'utf-8' });
      if (py.status === 0) pyOut = (py.stdout || py.stderr).trim();
    }
    if (pyOut) ok(`Python: ${pyOut}`);
    else warn('Python 3.11 not found (`py -3.11` / `python`). The local embedder needs it — install from python.org or pick a hosted embedder.');

    const ramGb = totalMemGb();
    if (ramGb >= 4) ok(`RAM: ${ramGb.toFixed(1)} GB`);
    else warn(`RAM: ${ramGb.toFixed(1)} GB (4 GB+ recommended; embedder + worker peak ~3 GB)`);

    const diskGb = await diskFreeGb(DATA_DIR);
    if (diskGb === Infinity) info('Disk: free space unknown (skipping check)');
    else if (diskGb >= 5) ok(`Disk: ${diskGb.toFixed(1)} GB free`);
    else warn(`Disk: ${diskGb.toFixed(1)} GB free (5 GB+ recommended; embedder venv + model = ~3.3 GB)`);
  }

  console.log();
  // Non-interactive: proceed without the confirmation prompt.
  if (!opts.nonInteractive && !askYesNo('Proceed with install?', true)) {
    info('aborted; nothing changed.');
    return 0;
  }

  // ----- worker.env -----
  header('Writing worker config');
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  // Same key=value content the Linux path emits (data lives in the user's home).
  const lines = workerEnvLines(cfg, DATA_DIR);
  writeFileSync(WORKER_ENV_PATH, lines.join('\n') + '\n');
  ok(`wrote ${WORKER_ENV_PATH}`);
  // NTFS ACL-lock: 0600 is meaningless on Windows. Strip inheritance and grant
  // only the current user full control. Best-effort — warn but don't abort.
  const userName = process.env.USERNAME ?? process.env.USER ?? '';
  const icaclsArgs = [WORKER_ENV_PATH, '/inheritance:r', '/grant:r', `${userName}:F`];
  const acl = spawnSync('icacls', icaclsArgs, { encoding: 'utf-8' });
  if (acl.status === 0) ok('locked worker.env to current user (icacls)');
  else warn(`could not ACL-lock worker.env (icacls exit ${acl.status ?? '?'}); secrets are readable by other local users`);

  // ----- local embedder sidecar (optional) -----
  if (cfg.embedder === 'local-sidecar') {
    header('Installing embedder sidecar');
    const embedDir = join(DATA_DIR, 'embed');
    try {
      await getEmbedderInstaller().install({ installDir: embedDir, model: cfg.embedderModel, port });
      ok('embedder sidecar installed');
      // Register the embedder Scheduled Task (uvicorn from the venv).
      await getServiceManager().install({
        name: 'captain-memo-embed',
        description: 'Captain Memo local embedder',
        exec: [join(embedDir, 'venv', 'Scripts', 'uvicorn.exe'), 'app:app', '--host', '127.0.0.1', '--port', String(port)],
        workingDir: join(INSTALL_DIR, 'services', 'embed'),
        autostart: true,
        restartOnFailure: true,
        logDir: LOGS_DIR,
      });
      await getServiceManager().start('captain-memo-embed');
      ok('embedder task registered + started (captain-memo-embed)');
    } catch (e) {
      warn(`embedder sidecar setup failed: ${e instanceof Error ? e.message : String(e)}`);
      info('Worker install continues; you can re-run install or switch to a hosted embedder later.');
    }
  }

  // ----- worker Scheduled Task -----
  header('Installing worker service');
  await getServiceManager().install({
    name: 'captain-memo-worker',
    description: 'Captain Memo worker',
    exec: [bunPath, 'src/worker/index.ts'],
    workingDir: INSTALL_DIR,
    envFile: WORKER_ENV_PATH,
    autostart: true,
    restartOnFailure: true,
    logDir: LOGS_DIR,
  });
  await getServiceManager().start('captain-memo-worker');
  ok('worker task registered + started (captain-memo-worker)');

  // ----- CLI shim -----
  header('Linking CLI shim');
  const binDir = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'captain-memo', 'bin');
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });
  const shimSrc = join(INSTALL_DIR, 'bin', 'captain-memo.cmd');
  const shimDst = join(binDir, 'captain-memo.cmd');
  try {
    copyFileSync(shimSrc, shimDst);
    ok(`installed ${shimDst}`);
    // Don't clobber PATH with setx (it truncates long PATHs and is easy to misuse).
    // Print one clear, idiot-proof instruction instead.
    warn(`Add this folder to your PATH so you can run \`captain-memo\` from anywhere:`);
    info(`  ${binDir}`);
    info('  (Settings → Edit environment variables for your account → Path → New → paste the line above)');
    info(`Until then you can run it directly:  bun bin\\captain-memo <cmd>`);
  } catch (e) {
    warn(`could not install CLI shim: ${e instanceof Error ? e.message : String(e)}`);
    info(`Run the CLI directly instead:  bun bin\\captain-memo <cmd>`);
  }

  // ----- register the plugin with Claude Code (best-effort) -----
  header('Registering Claude Code plugin');
  registerPlugin('user');
  grantMcpPermissions(opts, join(homedir(), '.claude', 'settings.json'));

  // ----- health probe -----
  header('Health probe');
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    const body = await res.text();
    if (res.ok && body.includes('"healthy":true')) ok(`worker is responding on http://localhost:${port}`);
    else warn(`worker responded but not yet healthy (HTTP ${res.status}) — initial indexing on a large corpus can take minutes`);
  } catch {
    warn(`worker not yet responding on http://localhost:${port} (initial indexing can take minutes — check ${join(LOGS_DIR, 'worker.log')})`);
  }

  console.log();
  ok('Captain Memo installed.');
  console.log();
  info('What now:');
  info('  • Restart any open Claude Code sessions for plugin hooks to take effect.');
  info('  • The worker runs as a per-user Scheduled Task and autostarts at logon.');
  info(`  • Logs:          ${join(LOGS_DIR, 'worker.log')}`);
  info('  • Check status:  captain-memo doctor');
  info('  • View config:   captain-memo config show');
  info('  • Roll back:     captain-memo uninstall');
  return 0;
}

export async function installCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: captain-memo install [--user|--system] [--yes] [flags]

DEFAULT: --user (no sudo)
  Embedder:    ~/.captain-memo/embed/  (Python venv + voyage-4-nano)
  Systemd:     ~/.config/systemd/user/captain-memo-{worker,embed}.service
  Config:      ~/.config/captain-memo/worker.env
  Plugin:      ~/.claude/plugins/captain-memo

WITH --system (sudo): for headless servers / multi-user / always-on boxes.
  Installs to /opt + /etc + /etc/systemd/system. Survives any user logout.

NON-INTERACTIVE (headless / CI / non-TTY stdin):
  Pass --yes (or -y) to never prompt. A non-TTY stdin is auto-detected and
  also disables prompts. Each setting can be supplied by a flag, an env var,
  or (TTY only) the prompt; on a re-install the EXISTING worker.env is the
  fallback, so an upgrade never drops your settings. Precedence:
  flag > env > existing config > default.

  --embedder <voyage-hosted|local-sidecar|openai-compatible|skip>
                                   (env CAPTAIN_MEMO_EMBEDDER)
  --voyage-key <key>               Voyage API key for the hosted embedder
                                   (env CAPTAIN_MEMO_EMBEDDER_API_KEY)
  --voyage-model <model>           Voyage / external embedder model
                                   (env CAPTAIN_MEMO_EMBEDDER_MODEL)
  --embedding-dim <n>              Embedding dimension
                                   (env CAPTAIN_MEMO_EMBEDDING_DIM)
  --summarizer <claude-oauth|anthropic|claude-code|openai-compatible>
                                   (env CAPTAIN_MEMO_SUMMARIZER_PROVIDER)
  --openai-endpoint <url>          OpenAI-compatible endpoint (summarizer/embedder)
                                   (env CAPTAIN_MEMO_OPENAI_ENDPOINT)
  --openai-key <key>               OpenAI-compatible API key
                                   (env CAPTAIN_MEMO_OPENAI_API_KEY)
  --watch <all-projects|none|path> Memory dirs to watch; a path/glob = custom
                                   (env CAPTAIN_MEMO_WATCH_MEMORY)
  --yes, -y                        No prompts; reuse existing config (flags/env override, defaults fill the rest)

Both modes: re-running preserves existing config (flags/env override). To remove: captain-memo uninstall`);
    return 0;
  }

  // Parse flags + env once; threaded through both the Windows and Linux paths.
  const opts = parseInstallOptions(args);

  // Windows fork — the whole Linux flow below this point is systemd/sudo/POSIX
  // and stays byte-for-byte untouched. Native Windows takes its own path.
  if (isWindows) return installWindows(args, opts);

  printMiniBanner();

  // Mode: explicit flag wins; otherwise auto-detect (root → ask, non-root → user)
  let mode: InstallMode;
  if (args.includes('--system')) mode = 'system';
  else if (args.includes('--user')) mode = 'user';
  else if (process.getuid && process.getuid() === 0 && opts.nonInteractive) {
    // Root, no explicit flag, can't prompt — default to system-wide (the only
    // mode that makes sense for root; user-level would install into /root).
    mode = 'system';
  } else if (process.getuid && process.getuid() === 0) {
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
    // Re-installing: load the existing config as the fallback so an upgrade NEVER
    // drops the user's settings (API key, models, endpoints, watch paths) — flags
    // and env still override. (Passing {} here was the bug: `install --yes` rewrote
    // worker.env from defaults and silently produced a keyless, non-embedding file.)
    if (opts.nonInteractive || askYesNo('Reconfigure (re-ask all questions)?', true)) existing = loadExistingConfig(paths.envFile);
    else info('keeping current config; re-running setup steps only.');
  }

  const cfg = gatherConfig(existing, opts);

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
    // Non-interactive: a failing pre-flight check is fatal — there's nobody to
    // confirm "continue anyway", and silently proceeding could install broken.
    if (opts.nonInteractive) {
      fail('pre-flight checks failed (non-interactive mode aborts rather than guess). Fix the FAIL items above, or re-run interactively to override.');
    }
    if (!askYesNo('Some checks failed. Continue anyway?', false)) {
      info('aborted.');
      return 1;
    }
  }

  console.log();
  // Non-interactive: proceed without the confirmation prompt.
  if (!opts.nonInteractive && !askYesNo('Proceed with install?', true)) {
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
  grantMcpPermissions(opts, join(realUserAndGroup().home, '.claude', 'settings.json'));

  header('Linking CLI shim');
  installCliShim(mode);

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
