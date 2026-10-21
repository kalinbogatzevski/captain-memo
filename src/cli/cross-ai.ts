// Cross-AI install — detect installed MCP-speaking AI coding tools (Codex,
// Gemini CLI, Cursor) and wire each to the SAME captain-memo worker so they
// share one local memory corpus.
//
// Two things per tool:
//   1. Register the MCP server  → `bun <REPO_ROOT>/plugin/dist/mcp-server.js`
//      (a stdio bridge to the worker on http://localhost:39888 — every tool
//      reuses the same worker/corpus). This is the MUST-HAVE.
//   2. Install the portable skill (skills/captain-memo/SKILL.md) into the tool's
//      skills/rules dir → tells the model WHEN to recall. Best-effort: a skill
//      copy failure still counts the MCP registration as wired.
//
// Claude Code is intentionally NOT handled here — the plugin install (registerPlugin
// in install.ts) already wires its MCP server, hooks, and skill. We list it as
// already-wired in reports but never duplicate that work.
//
// Idempotent: re-running must not error or duplicate. The codex/gemini CLIs handle
// "already added"; cursor is a read+parse+merge+write that never clobbers.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, realpathSync, statSync, unlinkSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { isMac, isWindows } from '../shared/platform.ts';
import { vscodeUserDirFor } from '../shared/vscode-paths.ts';
import { NATIVE_PROMPT_HOOK_TIMEOUT_S } from '../shared/paths.ts';
import { compareSemver } from '../shared/self-update.ts';
import { kimiCodeHomeDir } from '../shared/kimi-home.ts';
import { codexHomeDir } from '../shared/codex-home.ts';

/** Return to column 0 and ERASE the line, for the in-place per-tool probe line that `connect` and
 *  `install` both repaint. A bare `\r` is not enough: the line is routinely overwritten by a SHORTER
 *  one ("checking codex…" → "wiring codex…"), leaving the tail of the longer string on screen — which
 *  is what rendered as "· wiring codex…x…" on every run. Piped or redirected we emit only `\r`, so a
 *  captured log never has escape bytes written into it. */
export const PROBE_CLEAR = process.stdout.isTTY === true ? '\r\x1b[2K' : '\r';

// Console style matches install.ts (info/ok/warn).
function info(text: string): void { console.log(`  ${text}`); }
function ok(text: string): void { console.log(`  \x1b[32m✓\x1b[0m ${text}`); }
function warn(text: string): void { console.log(`  \x1b[33m!\x1b[0m ${text}`); }

// Minimal shape of spawnSync's result we depend on — lets tests inject a fake
// runner without pulling in the full SpawnSyncReturns generic.
export interface RunResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}
export type Runner = (cmd: string, args: string[], timeoutMs?: number) => RunResult;

/** TWO ceilings, because the two kinds of call are nothing alike.
 *
 *  DETECTION is `which <cli>` — measured at 19ms for EIGHT probes on this machine, so a probe
 *  that takes seconds is a stuck PATH entry (a network mount, a stale automount), not work.
 *  Cut it short and read it as "not installed", which is what a null status already means.
 *
 *  WIRING runs the tool's own CLI to register the MCP server, and that is real work: `gemini
 *  mcp add` measured at 5,031ms here — the single slowest thing in the whole step, and 91% of
 *  its total. One shared 5s ceiling would have killed it right at the boundary and broken
 *  Gemini wiring intermittently, which is why these are separate numbers rather than one.
 *
 *  Reported from a real upgrade: the installer sat on its last section header long enough
 *  that the operator killed it. Nothing was hung and nothing was indexing — this step was
 *  simply slow and silent. */
const PROBE_TIMEOUT_MS = 5_000;
const WIRE_TIMEOUT_MS = 60_000;

const defaultRunner: Runner = (cmd, args, timeoutMs) => {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: timeoutMs ?? WIRE_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: r.error } : {}) };
};

export interface ConnectCtx {
  // e.g. ['bun', '<REPO_ROOT>/plugin/dist/mcp-server.js'] — argv to launch the
  // stdio MCP server. The first element is the command, the rest are its args.
  mcpCommand: string[];
  // Absolute path to skills/captain-memo/SKILL.md.
  skillSource: string;
  // Home directory root for config dirs. Injectable so tests can point at a tmp
  // dir (os.homedir() ignores a runtime HOME mutation, so we can't rely on env).
  home: string;
  // Command runner (defaults to spawnSync). Injectable so tests don't shell out.
  run: Runner;
  // opencode-only: which LOCAL runtime to configure (ollama | vllm | lmstudio), from
  // `connect opencode --local-provider <key>`. Other adapters ignore it. Default ollama.
  localProvider?: string;
}

export interface ConnectResult {
  tool: string;
  // 'added' = we registered it; 'present' = already registered (idempotent re-run);
  // 'failed' = registration attempt errored; 'skipped' = tool not detected / not wired here.
  mcp: 'added' | 'present' | 'failed' | 'skipped';
  // 'installed' = skill copied into place; 'failed' = copy errored; 'skipped' = not attempted.
  skill: 'installed' | 'failed' | 'skipped';
  // Native lifecycle hooks where the installed CLI exposes a usable contract.
  // Transcript/rollout capture stays armed until a hook actually reaches the worker.
  capture?: 'native-hooks' | 'rollout-fallback' | 'hook-install-failed';
  detail?: string;
}

export interface ToolAdapter {
  id: string;
  label: string;
  detect(ctx: { home: string; run: Runner }): boolean;
  connect(ctx: ConnectCtx): ConnectResult;
}

// `which <id>` — tool CLI on PATH? Pulled out so adapters share one probe.
function cliOnPath(run: Runner, id: string): boolean {
  // Short ceiling: a `which` that takes seconds is a stuck PATH entry, not a slow answer.
  // Windows ships no `which` — the equivalent is `where.exe`. Without this branch the probe
  // errors on EVERY adapter there, so detection silently degrades to the config-dir check
  // alone and a tool that IS installed but not yet configured reads as absent.
  const r = run(isWindows ? 'where' : 'which', [id], PROBE_TIMEOUT_MS);
  return r.status === 0 && (r.stdout ?? '').trim().length > 0;
}

// Best-effort skill copy into <dir>/<file>. Returns 'installed' on success,
// 'failed' otherwise (never throws — the MCP registration is the must-have).
function copySkill(skillSource: string, destFile: string): ConnectResult['skill'] {
  try {
    mkdirSync(dirname(destFile), { recursive: true });
    copyFileSync(skillSource, destFile);
    return 'installed';
  } catch {
    return 'failed';
  }
}

// Replace <path> with <text> atomically (a tmp file in the same directory, then rename), so a kimi that starts mid-write never
// reads half a file. A symlinked file (a dotfiles checkout) is written THROUGH to its target; an existing file keeps its mode
// (an mcp.json can hold other servers' tokens), a new one is 0600.
function writeFileAtomic(path: string, text: string): void {
  let target = path;
  try { target = realpathSync(path); } catch { /* not there yet */ }
  let mode = 0o600;
  try { mode = statSync(target).mode & 0o777; } catch { /* a new file */ }
  const tmp = `${target}.captain-memo-tmp`;
  try {
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}

// Did a CLI's "add" fail simply because the entry already exists? Treat that as
// idempotent success (present), not a hard failure.
function looksAlreadyPresent(r: RunResult): boolean {
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.toLowerCase();
  return /already|exists|duplicate/.test(out);
}

function errDetail(r: RunResult, fallback: string): string {
  return (r.stderr || r.stdout || (r.error ? r.error.message : fallback)).trim();
}

function withDetail(base: ConnectResult, detail: string | undefined): ConnectResult {
  return detail !== undefined ? { ...base, detail } : base;
}

// --- mcpServers-shape merge (PURE — unit-tested without disk) ----------------
// Shared by every adapter whose target file is `{ mcpServers: { name: {command,args} } }`
// (cursor, Claude Desktop, and — via mergeCursorMcpConfig — agy). Read the existing config
// (as a string, or null/'' when absent), merge in mcpServers["captain-memo"] =
// { command, args: [path] }, and return the serialized result. Preserves every other
// server and top-level key. Idempotent: re-merging the same command+path yields identical
// content. Refreshes the path (or command) if it changed.
function mergeMcpServersConfig(existingJson: string | null, command: string, mcpServerPath: string): string {
  let root: Record<string, unknown> = {};
  if (existingJson && existingJson.trim().length > 0) {
    const parsed = JSON.parse(existingJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    }
  }
  const servers = (root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers))
    ? (root.mcpServers as Record<string, unknown>)
    : {};
  servers['captain-memo'] = { command, args: [mcpServerPath] };
  root.mcpServers = servers;
  return JSON.stringify(root, null, 2) + '\n';
}

// ~/.cursor/mcp.json. Hardcodes `command: 'bun'` — Cursor is not known to launch MCP
// servers with a minimal PATH the way Claude Desktop does, so a bare `bun` is fine here.
export function mergeCursorMcpConfig(existingJson: string | null, mcpServerPath: string): string {
  return mergeMcpServersConfig(existingJson, 'bun', mcpServerPath);
}

// Claude Desktop's claude_desktop_config.json — same top-level `mcpServers` stdio shape as
// cursor, with one difference that matters: the COMMAND is passed in, because Claude Desktop
// launches configured servers with a minimal PATH. A bare `bun` resolves in your terminal and
// fails inside the app, and the failure is silent — the server just never starts. Callers pass
// an absolute path (see claudeDesktopAdapter, which uses process.execPath).
export function mergeClaudeDesktopConfig(existingJson: string | null, command: string, mcpServerPath: string): string {
  return mergeMcpServersConfig(existingJson, command, mcpServerPath);
}

// Pull the single mcp-server.js path out of mcpCommand for the cursor merge /
// CLI-positional forms. mcpCommand is ['bun', '<path>'] — the path is the arg
// after the command. Falls back to the last element so a longer argv still works.
function mcpServerPath(mcpCommand: string[]): string {
  return mcpCommand[1] ?? mcpCommand[mcpCommand.length - 1] ?? '';
}

// --- goose config.yaml merge (PURE — unit-tested without disk) ---------------
// goose (Block, Apache-2.0) has NO non-interactive registration command — `goose configure` is a
// TUI and `goose mcp <name>` only launches a BUILT-IN extension's server. Its documented advanced
// path is editing ~/.config/goose/config.yaml directly, where a top-level `extensions:` map holds
// {name, cmd, args, enabled, envs, type, timeout} per entry. So register by read+parse+merge+write
// (like cursor's mcp.json), never clobbering other extensions or the top-level provider keys.
//
// `envs: {}` is written explicitly rather than omitted: the documented example always carries the
// key, and an empty map is inert whether goose defaults it or requires it.

/** Bun's native YAML, feature-detected. Typed locally so this compiles against an @types/bun that
 *  predates `Bun.YAML` — and so an older Bun reads as "absent" instead of throwing. */
const bunYaml = (globalThis as {
  Bun?: { YAML?: { parse(src: string): unknown; stringify(value: unknown): string } };
}).Bun?.YAML;

export function gooseExtensionEntry(mcpServerPath: string): Record<string, unknown> {
  return {
    name: 'captain-memo',
    cmd: 'bun',
    args: [mcpServerPath],
    enabled: true,
    envs: {},
    type: 'stdio',
    timeout: 300,
  };
}

/** Every layout goose can put config.yaml in, in probe order. goose resolves this through the
 *  `etcetera` crate's `choose_app_strategy(top_level_domain: "Block", author: "Block", app_name:
 *  "goose")` (crates/goose/src/config/paths.rs), which picks a DIFFERENT strategy per OS — so a
 *  single XDG path is right on exactly one of the three platforms.
 *
 *  - Windows → `Windows` strategy: base `config_dir()` is `data_dir()` = `%APPDATA%`, then
 *    `<author>\<app_name>` and a literal `config` subfolder → `%APPDATA%\Block\goose\config\`.
 *  - macOS  → `Apple` strategy: `~/Library/Application Support/<bundle_id>`, where `bundle_id()`
 *    joins TLD + author.toLowerCase() + app_name → `Block.block.goose` (only the author is
 *    lowercased — that asymmetry is in etcetera, not a typo here).
 *  - Linux  → `Xdg` strategy: `$XDG_CONFIG_HOME/goose` else `~/.config/goose`.
 *
 *  VERIFIED vs. DERIVED: the Linux path was OBSERVED — `goose info` on goose 1.45.0 prints
 *  `~/.config/goose/config.yaml`. The Windows and macOS paths are DERIVED by reading goose's
 *  paths.rs and etcetera 0.11's strategy sources; neither has been seen on a real machine. That
 *  is why this probes for an existing file rather than trusting one answer: if the derivation is
 *  off but goose already wrote a config somewhere we list, we still find it. */
export function gooseConfigCandidates(home: string): string[] {
  return [
    join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Block', 'goose', 'config', 'config.yaml'),
    join(home, 'Library', 'Application Support', 'Block.block.goose', 'config.yaml'),
    join(process.env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), 'goose', 'config.yaml'),
  ];
}

/** The config.yaml this machine's goose actually reads.
 *  `GOOSE_PATH_ROOT` wins outright when it is ABSOLUTE — goose's own `validated_path_root` drops
 *  relative values rather than resolving them, so a relative one must fall through, not be honoured.
 *  Otherwise: first candidate that exists; if none do, the canonical one for this platform, so a
 *  first-time write still lands where goose will look. */
export function gooseConfigPath(home: string): string {
  const root = process.env.GOOSE_PATH_ROOT?.trim();
  if (root && isAbsolute(root)) return join(root, 'config', 'config.yaml');
  const candidates = gooseConfigCandidates(home);
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[isWindows ? 0 : isMac ? 1 : 2]!;
}

/** Our entry as it currently stands in an existing config, JSON-normalized for comparison, or null.
 *  Lets connect() report 'present' on an unchanged re-run instead of rewriting the file every time. */
export function extractGooseEntry(existingYaml: string): string | null {
  if (!bunYaml) return null;
  try {
    const parsed = bunYaml.parse(existingYaml) as Record<string, unknown> | null;
    const exts = parsed?.extensions as Record<string, unknown> | undefined;
    const entry = exts?.['captain-memo'];
    return entry ? JSON.stringify(entry) : null;
  } catch { return null; }
}

/** Shape gate: anything with a colon, backslash, space or leading punctuation is quoted outright.
 *  Matters most for a Windows mcp-server path (`C:\Users\...`) — bare, the drive colon would parse
 *  as a nested key and silently corrupt the file. */
const YAML_BARE_SAFE = /^[A-Za-z0-9_][A-Za-z0-9_\-./]*$/;

/** Serialize one scalar, quoting whenever bare output would not survive a round-trip.
 *
 *  Passing the shape gate is NOT sufficient, because YAML also *types* bare scalars: `yes` becomes
 *  a bool, `12` an int, `1e5` a float, `0x1F` an int, `1_000` an int. Enumerating those rules by
 *  regex is a losing game — an earlier version of this function did exactly that, allowed `1e5`
 *  through, and turned the string "1e5" into the number 100000 on the way back in.
 *
 *  So the parser decides: emit bare only when re-parsing the bare token yields the identical
 *  STRING. That subsumes every implicit-typing rule YAML has, including ones added later, and it
 *  fails safe — no parser available, or any doubt at all, means quoted. */
function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const s = String(value);
  if (!YAML_BARE_SAFE.test(s)) return JSON.stringify(s);
  try {
    if (bunYaml && bunYaml.parse(s) === s) return s;
  } catch { /* unparseable bare — fall through to the quoted form */ }
  return JSON.stringify(s);   // JSON's double-quoted form is a valid YAML scalar
}

function isEmptyContainer(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0;
  return !!v && typeof v === 'object' && Object.keys(v as object).length === 0;
}

/** Minimal BLOCK-style YAML emitter for plain data (nested maps, arrays, scalars).
 *
 *  Why this exists rather than `Bun.YAML.stringify`: Bun emits FLOW style only
 *  (`{a: 1,b: {c: 2}}`) and accepts no options, so a round-trip would rewrite the user's
 *  entire goose config onto one unreadable line. config.yaml is a file people open and
 *  edit, so it has to come back out looking like the one goose itself writes.
 *
 *  ponytail: comments are still lost — inherent to any parse-then-emit round-trip, and
 *  acceptable because goose authors this file itself via `goose configure`. If comment
 *  preservation is ever needed, the upgrade path is a YAML CST library, not a bigger emitter. */
export function toBlockYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    return value.map((item) =>
      item && typeof item === 'object' && !isEmptyContainer(item)
        ? `${pad}-\n${toBlockYaml(item, indent + 1)}`
        : `${pad}- ${isEmptyContainer(item) ? (Array.isArray(item) ? '[]' : '{}') : yamlScalar(item)}\n`,
    ).join('');
  }
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => {
    if (isEmptyContainer(v)) return `${pad}${yamlScalar(k)}: ${Array.isArray(v) ? '[]' : '{}'}\n`;
    if (v && typeof v === 'object') return `${pad}${yamlScalar(k)}:\n${toBlockYaml(v, indent + 1)}`;
    return `${pad}${yamlScalar(k)}: ${yamlScalar(v)}\n`;
  }).join('');
}

export function mergeGooseConfig(existingYaml: string | null, mcpServerPath: string): string {
  if (!bunYaml) throw new Error('Bun.YAML unavailable');
  let root: Record<string, unknown> = {};
  if (existingYaml && existingYaml.trim().length > 0) {
    const parsed = bunYaml.parse(existingYaml);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    }
  }
  const extensions = (root.extensions && typeof root.extensions === 'object' && !Array.isArray(root.extensions))
    ? (root.extensions as Record<string, unknown>)
    : {};
  extensions['captain-memo'] = gooseExtensionEntry(mcpServerPath);
  root.extensions = extensions;
  return toBlockYaml(root);
}

// --- opencode opencode.json merge (PURE — unit-tested without disk) -----------
// opencode (MIT) has NO `opencode mcp add` for setup — MCP servers, providers, and a permissive agent are ALL
// config-file. So register by read+parse+merge+write of opencode.json (like cursor's mcp.json): the captain-memo
// MCP server + the OpenRouter / local providers + a permissive agent. CRITICAL: the OpenRouter key is written as
// the `{env:OPENROUTER_API_KEY}` REFERENCE — opencode interpolates it from the env at launch — so no literal
// secret lands in the 0644 config. Idempotent: re-merging is content-stable.
export const OPENCODE_AUTO_AGENT = 'captain-auto';
const OPENCODE_GATEWAY_ENDPOINT = 'https://openrouter.ai/api/v1';
// The local OpenAI-compatible runtimes opencode can drive locally. The KEY is the opencode provider name AND the
// route prefix (ollama/x, vllm/x, lmstudio/x). `connect opencode --local-provider <key>` selects one (default ollama).
const OPENCODE_LOCAL_PROVIDERS: Record<string, { name: string; baseURL: string }> = {
  ollama:   { name: 'Ollama (local)',    baseURL: 'http://localhost:11434/v1' },
  vllm:     { name: 'vLLM (local)',      baseURL: 'http://localhost:8000/v1' },
  lmstudio: { name: 'LM Studio (local)', baseURL: 'http://127.0.0.1:1234/v1' },
};
export const OPENCODE_LOCAL_PROVIDER_KEYS = Object.keys(OPENCODE_LOCAL_PROVIDERS);

export interface OpencodeMergeOpts {
  mcpCommand: string[];
  gatewayEndpoint?: string;
  localEndpoint?: string;
  localProvider?: string;   // 'ollama' (default) | 'vllm' | 'lmstudio'
}

export function mergeOpencodeConfig(existingJson: string | null, opts: OpencodeMergeOpts): string {
  let root: Record<string, unknown> = {};
  if (existingJson && existingJson.trim().length > 0) {
    const parsed = JSON.parse(existingJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) root = parsed as Record<string, unknown>;
  }
  const objAt = (key: string): Record<string, unknown> => {
    const v = root[key];
    return (v && typeof v === 'object' && !Array.isArray(v)) ? (v as Record<string, unknown>) : {};
  };
  const sub = (parent: Record<string, unknown>, key: string): Record<string, unknown> => {
    const v = parent[key];
    return (v && typeof v === 'object' && !Array.isArray(v)) ? (v as Record<string, unknown>) : {};
  };

  const mcp = objAt('mcp');
  mcp['captain-memo'] = { type: 'local', command: [...opts.mcpCommand], enabled: true };
  root.mcp = mcp;

  const provider = objAt('provider');
  const orPrev = sub(provider, 'openrouter');
  provider.openrouter = {
    ...orPrev,
    options: { ...sub(orPrev, 'options'), baseURL: opts.gatewayEndpoint ?? OPENCODE_GATEWAY_ENDPOINT, apiKey: '{env:OPENROUTER_API_KEY}' },
  };
  const localKey = Object.prototype.hasOwnProperty.call(OPENCODE_LOCAL_PROVIDERS, opts.localProvider ?? '') ? opts.localProvider! : 'ollama';
  const localDef = OPENCODE_LOCAL_PROVIDERS[localKey]!;
  const lpPrev = sub(provider, localKey);
  provider[localKey] = {
    npm: '@ai-sdk/openai-compatible',
    name: localDef.name,
    ...lpPrev,
    options: { ...sub(lpPrev, 'options'), baseURL: opts.localEndpoint ?? localDef.baseURL },
  };
  root.provider = provider;

  const agent = objAt('agent');
  agent[OPENCODE_AUTO_AGENT] = {
    description: 'captain-memo unattended session (auto-approve) — permissive permissions, selected via --agent.',
    mode: 'primary',
    permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' },
  };
  root.agent = agent;

  return JSON.stringify(root, null, 2) + '\n';
}

// --- VS Code mcp.json merge -- top-level `servers` (NOT mcpServers), stdio ------
export function mergeVscodeMcpConfig(existingJson: string | null, mcpServerPath: string): string {
  let root: Record<string, unknown> = {};
  if (existingJson && existingJson.trim().length > 0) {
    const parsed = JSON.parse(existingJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) root = parsed as Record<string, unknown>;
  }
  const servers = (root.servers && typeof root.servers === 'object' && !Array.isArray(root.servers))
    ? (root.servers as Record<string, unknown>)
    : {};
  servers['captain-memo'] = { type: 'stdio', command: 'bun', args: [mcpServerPath] };
  root.servers = servers;
  return JSON.stringify(root, null, 2) + '\n';
}

// JetBrains AI Assistant MCP is UI-only (no programmatic config file) but IMPORTS the standard `mcpServers`
// (Claude-desktop) shape, so the jetbrains adapter writes this snippet for the operator to paste.
function jetbrainsMcpSnippet(mcpServerPath: string): string {
  return JSON.stringify({ mcpServers: { 'captain-memo': { command: 'bun', args: [mcpServerPath] } } }, null, 2) + '\n';
}

// --- Mistral Vibe config.toml MCP block (append-if-absent; TOML, not JSON) -----
// Vibe (github.com/mistralai/mistral-vibe) reads MCP servers from ~/.vibe/config.toml as `[[mcp_servers]]`
// array-of-tables. With no TOML parser here we APPEND a single managed block and NEVER rewrite the user's TOML, so
// foreign config + formatting are untouched. "Already there" is decided by the TABLE (an [[mcp_servers]] named
// captain-memo), not by our marker comment: Vibe re-serialises config.toml when it saves and drops every comment,
// so after that the marker is gone and a marker-only check appended a second block (Windows report, 2026-10-21).
// The marker still counts (a marked block whose table was since renamed is left alone, as before).
const VIBE_MCP_MARKER = '# captain-memo (managed by `captain-memo connect`)';

/** End of the quoted TOML string that starts at s[i] (basic or literal, single- or multi-line), or the end of the
 *  line for an unterminated one. */
function tomlSkipString(s: string, i: number): number {
  const q = s[i]!;
  const close = s.startsWith(q.repeat(3), i) ? q.repeat(3) : q;
  i += close.length;
  while (i < s.length) {
    if (q === '"' && s[i] === '\\') { i += 2; continue; }
    if (s.startsWith(close, i)) { i += close.length; while (close.length === 3 && s[i] === q) i++; return i; }
    if (close.length === 1 && s[i] === '\n') return i;
    i++;
  }
  return s.length;
}

/** The text of a TOML value starting at s[i]: a string, a (possibly multi-line, nested) array or inline table,
 *  or a bare scalar up to the end of its line or its comment. */
function tomlSkipValue(s: string, i: number): number {
  if (s[i] === '"' || s[i] === "'") return tomlSkipString(s, i);
  if (s[i] !== '[' && s[i] !== '{') { while (i < s.length && s[i] !== '\n' && s[i] !== '#') i++; return i; }
  for (let depth = 0; i < s.length;) {
    const c = s[i]!;
    if (c === '"' || c === "'") { i = tomlSkipString(s, i); continue; }
    if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    i++;
    if (c === '[' || c === '{') depth++;
    else if ((c === ']' || c === '}') && --depth === 0) return i;
  }
  return i;
}

/** Table headers and key = value statements of a TOML text, in order. Strings, arrays and comments are skipped
 *  as units, so a `[[header]]` or `name = ...` line INSIDE a multi-line string or array is not mistaken for one. */
function* tomlStatements(s: string): Generator<{ header: string; array: boolean } | { key: string; value: string }> {
  for (let i = 0; i < s.length;) {
    const c = s[i]!;
    if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '[') {
      const array = s[i + 1] === '[';
      const from = (i += array ? 2 : 1);
      while (i < s.length && s[i] !== '\n' && s[i] !== ']') i = s[i] === '"' || s[i] === "'" ? tomlSkipString(s, i) : i + 1;
      yield { header: s.slice(from, i).replace(/["'\s]/g, ''), array };
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    const from = i;
    while (i < s.length && s[i] !== '=' && s[i] !== '\n') i = s[i] === '"' || s[i] === "'" ? tomlSkipString(s, i) : i + 1;
    if (s[i] !== '=') continue;
    const key = s.slice(from, i).trim().replace(/^(["'])(.*)\1$/, '$2');
    i++;
    while (s[i] === ' ' || s[i] === '\t') i++;
    const start = i;
    i = tomlSkipValue(s, i);
    yield { key, value: s.slice(start, i).trim() };
  }
}

/** The string a single-line TOML string value holds (basic strings decoded), else null. */
function tomlString(value: string): string | null {
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  if (!/^"(?:[^"\\\n]|\\.)*"$/.test(value)) return null;
  try { return JSON.parse(value) as string; } catch { return null; }   // TOML escapes JSON lacks (\e, \xHH) read as "unknown"
}

/** The elements of a TOML array of strings (any layout, comments and trailing comma allowed), or null when it holds
 *  anything else. */
function tomlStringList(value: string): string[] | null {
  if (value[0] !== '[') return null;
  const out: string[] = [];
  for (let i = 1; i < value.length;) {
    const c = value[i]!;
    if (c === ']') return out;
    if (c === '#') { while (i < value.length && value[i] !== '\n') i++; continue; }
    if (c === ',' || c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c !== '"' && c !== "'") return null;
    const end = tomlSkipString(value, i);
    const str = tomlString(value.slice(i, end));
    if (str === null) return null;
    out.push(str);
    i = end;
  }
  return null;
}

/** The `args` of every `[[mcp_servers]]` table named "captain-memo" in a Vibe config.toml (null for a table whose
 *  args are missing or not a plain list of strings). A `name = "captain-memo"` inside any other table ([[models]],
 *  [providers.x], [mcp_servers.env]) is not one. Read-only: the text is never rewritten. */
export function vibeCaptainMemoTables(toml: string): (string[] | null)[] {
  const found: (string[] | null)[] = [];
  let entry: { name: string | null; args: string[] | null } | null = null;
  const flush = () => { if (entry?.name === 'captain-memo') found.push(entry.args); entry = null; };
  for (const st of tomlStatements(toml)) {
    if ('header' in st) { flush(); if (st.array && st.header === 'mcp_servers') entry = { name: null, args: null }; }
    else if (entry && st.key === 'name') entry.name = tomlString(st.value);
    else if (entry && st.key === 'args') entry.args = tomlStringList(st.value);
  }
  flush();
  return found;
}

/** What `connect vibe` does to Vibe's config.toml: `text` is what to write (the input itself when captain-memo is
 *  already there), `added` whether a block was appended, `note` a plain sentence for the connect report when the
 *  existing entry needs the owner's eye. An existing entry is NEVER edited, whatever its args say: rewriting the
 *  path would silently change which install Vibe runs (both checkouts can exist), and with two entries there is no
 *  single right one. So a path that differs from this install's is reported, and left. */
export function planVibeMcpConfig(existingToml: string | null, mcpServerPath: string): { text: string; added: boolean; note?: string } {
  const base = existingToml ?? '';
  const tables = vibeCaptainMemoTables(base);
  if (tables.length > 0 || base.includes(VIBE_MCP_MARKER)) {
    const notes: string[] = [];
    const norm = (p: string) => p.replace(/\\/g, '/');   // exact otherwise: a case-only difference reads as "differs", which only costs a sentence
    if (tables.length > 0 && !tables.some((args) => args?.some((a) => norm(a) === norm(mcpServerPath)))) {
      notes.push(`its captain-memo entry points at ${tables[0]?.join(' ') || 'args this scan cannot read'}, this install is ${mcpServerPath}; left as it is (edit that args line to switch)`);
    }
    if (tables.length > 1) notes.push(`${tables.length} [[mcp_servers]] entries are named captain-memo; keep one and delete the others by hand`);
    return { text: base, added: false, ...(notes.length ? { note: notes.join('; ') } : {}) };
  }
  const block = VIBE_MCP_MARKER + '\n'
    + '[[mcp_servers]]\n'
    + 'name = "captain-memo"\n'
    + 'transport = "stdio"\n'
    + 'command = "bun"\n'
    + 'args = [' + JSON.stringify(mcpServerPath) + ']\n';
  const sep = base === '' ? '' : (base.endsWith('\n') ? '\n' : '\n\n');
  return { text: base + sep + block, added: true };
}

export function mergeVibeMcpConfig(existingToml: string | null, mcpServerPath: string): string {
  return planVibeMcpConfig(existingToml, mcpServerPath).text;
}

// --- kimi config.toml merge (PURE — unit-tested without disk) -----------------
// `connect kimi` must leave kimi LAUNCHABLE, and kimi's launchability lives entirely in ~/.kimi/config.toml:
// a [providers.*] table + [models.<alias>] aliases + a root `default_model` (bare `kimi` has nothing to route
// to without them). VERIFIED shape (kimi-cli 1.48.0): provider type "openai_legacy", a loopback base_url needs
// no real key and no /login, but the api_key FIELD is required (kimi refuses the file without it, 2026-09-26), so
// a placeholder is written; and `-m <alias>` takes a [models.*] KEY — so the aliases are named after the Ollama
// model ids, 1:1. Managed BEGIN/END block: re-running REGENERATES it (so a newly pulled model shows up) and
// never touches a line outside it. `default_model` is a ROOT key ⇒ it MUST precede all tables (a bare key after
// a [section] header belongs to THAT table, and kimi then dies with "LLM not set") ⇒ it is PREPENDED — and it is
// only KEPT when it still RESOLVES to a [models.*] alias in the final file. A default left pointing at a model
// the user has since `ollama rm`'d is dangling, and dangling == "LLM not set" == exactly the breakage this
// function exists to prevent.
const KIMI_BEGIN = '# >>> captain-memo (managed by `captain-memo connect kimi`) >>>';
const KIMI_END = '# <<< captain-memo <<<';
const KIMI_LOCAL_ENDPOINT = 'http://127.0.0.1:11434/v1';   // ponytail: loopback Ollama, the only verified provider
// kimi-cli 1.48.0 compacts the conversation whenever its tokens + reserved_context_size (50,000 by default, its
// config.py) reach max_context_size, and its own system prompt plus tool schemas are ~20K tokens before any MCP
// server. At 32768 every step compacted first, so the prompt never reached the model: the request carried the system
// message alone (2026-09-26, against a mock server that logged the request; 65536 and 131072 delivered it). This is kimi's
// budget, not the model's: the Ollama server's own context length still bounds what the model actually reads.
const KIMI_MAX_CONTEXT = 131072;
// Below this kimi compacts before the prompt reaches the model: its 50,000-token reserve plus its ~20K preamble.
const KIMI_MIN_CONTEXT = 70_000;

/** The owner's OWN [models.*] tables (outside the managed block) whose max_context_size is below KIMI_MIN_CONTEXT,
 *  as "alias (size)". `connect` never edits those tables, so it names them instead of reporting a quiet success. */
export function kimiSmallContexts(toml: string): string[] {
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const outside = toml.replace(new RegExp(esc(KIMI_BEGIN) + '[\\s\\S]*?' + esc(KIMI_END)), '');
  const out: string[] = [];
  let table = '';
  for (const line of outside.split('\n')) {
    const t = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
    if (t) { table = t[1]!.replace(/["'\s]/g, ''); continue; }
    const m = /^\s*max_context_size\s*=\s*(\d+)/.exec(line);
    if (m && table.startsWith('models.') && Number(m[1]) < KIMI_MIN_CONTEXT) out.push(`${table.slice(7)} (${m[1]})`);
  }
  return out;
}

export function mergeKimiConfig(existingToml: string | null, opts: { models: string[]; endpoint?: string }): string {
  // Drop any previous managed block — this is a regenerate, not an append. Trailing whitespace goes with it so
  // a re-run is byte-stable (no blank line creeping in each time).
  const base = (existingToml ?? '').replace(
    new RegExp(KIMI_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + KIMI_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?'),
    '',
  ).replace(/\s+$/, '');
  const endpoint = opts.endpoint ?? KIMI_LOCAL_ENDPOINT;
  // A table the owner declared OUTSIDE the block (a hand-written config) is theirs, and writing it again
  // would be a duplicate TOML table, which kimi refuses to load: the block skips it.
  const owned = new Set(base.split('\n').map((l) => /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(l)?.[1]?.replace(/["'\s]/g, '')).filter(Boolean));
  let block = KIMI_BEGIN + '\n' + (owned.has('providers.ollama') ? '' : '[providers.ollama]\n'
    + 'type = "openai_legacy"\n'
    + 'base_url = ' + JSON.stringify(endpoint) + '\n'
    + 'api_key = "ollama"\n');   // kimi 1.48.0 refuses a provider without api_key ("Field required"); Ollama ignores it
  for (const m of opts.models) {
    if (owned.has('models.' + m)) continue;
    block += '\n[models.' + JSON.stringify(m) + ']\n'
      + 'provider = "ollama"\n'
      + 'model = ' + JSON.stringify(m) + '\n'
      + 'max_context_size = ' + KIMI_MAX_CONTEXT + '\n';
  }
  block += KIMI_END + '\n';

  // ROOT default_model. Only lines BEFORE the first [table] are root keys (one under a [section] belongs to
  // that section). Keep the declared one ONLY if it still resolves to an alias in the FINAL file — a
  // user-defined [models.mine] survives, a stale pointer into a regenerated block does not.
  const lines = base === '' ? [] : base.split('\n');
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const at = lines.slice(0, firstTable === -1 ? lines.length : firstTable)
    .findIndex((l) => /^\s*default_model\s*=/.test(l));
  const declared = at === -1 ? undefined : /=\s*["']([^"']*)["']/.exec(lines[at]!)?.[1];
  const resolves = declared !== undefined && (opts.models.includes(declared)
    || base.includes('[models.' + JSON.stringify(declared) + ']')   // quoted key
    || base.includes('[models.' + declared + ']'));                 // bare key
  const wanted = pickChatModel(opts.models);
  let prefix = '';
  if (!resolves && wanted) {
    const line = 'default_model = ' + JSON.stringify(wanted);
    if (at === -1) prefix = line + '\n\n'; else lines[at] = line;
  }
  const merged = lines.join('\n');
  return prefix + (merged === '' ? block : merged + '\n\n' + block);
}

export const CAPTAIN_MEMO_KIMI_HOOK_BEGIN = '# >>> captain-memo native hooks (managed) >>>';
export const CAPTAIN_MEMO_KIMI_HOOK_END = '# <<< captain-memo native hooks <<<';

/** Kimi introduced its Beta lifecycle hooks in 1.28.0 and has no feature-list
 *  command, so this is the one adapter where a semver capability gate is the
 *  vendor-supported signal. Unknown output fails closed to transcript capture. */
export function kimiHooksSupported(result: RunResult): boolean {
  if (result.status !== 0) return false;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major! > 1 || (major === 1 && minor! >= 28);
}

export function mergeKimiHooks(existingToml: string | null, hookCommand: string, hookBundle: string): string {
  const escapedBegin = CAPTAIN_MEMO_KIMI_HOOK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = CAPTAIN_MEMO_KIMI_HOOK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const base = (existingToml ?? '')
    .replace(new RegExp(`${escapedBegin}[\\s\\S]*?${escapedEnd}\\n?`), '')
    .replace(/\s+$/, '');
  const command = (alias: string) =>
    `${quoteHookArg(hookCommand)} ${quoteHookArg(hookBundle)} ${alias}`;
  const hook = (event: string, alias: string, timeout: number) => [
    '[[hooks]]',
    `event = ${JSON.stringify(event)}`,
    `command = ${JSON.stringify(command(alias))}`,
    `timeout = ${timeout}`,
  ].join('\n');
  const block = [
    CAPTAIN_MEMO_KIMI_HOOK_BEGIN,
    hook('UserPromptSubmit', 'KimiUserPromptSubmit', NATIVE_PROMPT_HOOK_TIMEOUT_S),
    '',
    hook('PostToolUse', 'KimiPostToolUse', 5),
    '',
    hook('Stop', 'KimiStop', 30),
    CAPTAIN_MEMO_KIMI_HOOK_END,
    '',
  ].join('\n');
  return base ? `${base}\n\n${block}` : block;
}

// --- kimi 2.x ("kimi-code", home = kimiCodeHomeDir) ---------------------------------------------------------
// Everything below was read from kimi-code 2.2.0's open source (no 2.x binary was run on the build host): MCP servers are
// `{"mcpServers":{"<name>":{command,args,env,cwd}}}` in <home>/mcp.json (there is NO `kimi mcp` subcommand), hooks are
// `[[hooks]]` in <home>/config.toml with exactly event/matcher/command/timeout, and a tool call is approved only by a
// `[[permission.rules]]` entry (decision, pattern, optional scope/reason) or a mode flag.

/** The major of `kimi --version` (bare `2.2.0` on 2.x, `kimi-cli 1.48.0` on 1.x), or null when it cannot be read. Same triple
 *  grab as kimiHooksSupported, which stays as it was for 1.x. */
export function kimiMajorVersion(result: RunResult): number | null {
  if (result.status !== 0) return null;
  const match = /(\d+)\.\d+\.\d+/.exec(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return match ? Number(match[1]) : null;
}

/** Merge captain-memo into kimi 2.x's mcp.json. Returns the text to write, or null when the entry is already exactly ours (a
 *  true no-op: the file keeps whatever formatting the user gave it). Every other server and top-level key keeps its value and
 *  order; the one write is laid out as kimi's own is (2-space JSON, trailing newline). An entry that is already ours by name
 *  (a `kimi migrate`d 1.x one) is updated IN PLACE: its command and args follow this install, its other fields (env, enabled,
 *  timeouts) stay. THROWS on what kimi itself rejects (not JSON, not an object, `mcpServers` not an object): it must not be
 *  papered over with a fresh `{}`, that would delete the user's servers. */
export function mergeKimiCodeMcp(existingJson: string | null, mcpCommand: string[]): string | null {
  let root: Record<string, unknown> = {};
  if (existingJson !== null && existingJson.trim() !== '') {
    let parsed: unknown;
    try { parsed = JSON.parse(existingJson); } catch (e) { throw new Error(`not valid JSON (${(e as Error).message})`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    root = parsed as Record<string, unknown>;
  }
  const rawServers = root.mcpServers;
  if (rawServers !== undefined && (!rawServers || typeof rawServers !== 'object' || Array.isArray(rawServers))) throw new Error('"mcpServers" is not an object');
  const servers = (rawServers ?? {}) as Record<string, unknown>;
  const prev = servers['captain-memo'];
  const own = prev && typeof prev === 'object' && !Array.isArray(prev) && typeof (prev as { command?: unknown }).command === 'string'
    ? prev as Record<string, unknown> : {};   // an http/other-shaped entry under our name is replaced, not blended
  const entry = { ...own, command: mcpCommand[0] ?? 'bun', args: mcpCommand.slice(1) };
  if (JSON.stringify(entry) === JSON.stringify(prev)) return null;
  servers['captain-memo'] = entry;
  root.mcpServers = servers;
  return JSON.stringify(root, null, 2) + '\n';
}

/** What `connect kimi` allows in kimi 2.x. Default "Always Ask" approves no MCP tool, so without this every captain-memo call
 *  (recall, claim, send) waits on a prompt. OUR server only, never a wildcard over MCP. */
export const KIMI_ALLOW_PATTERN = 'mcp__captain-memo__*';

/** Read kimi's config.toml for permission rules, line by line (this repo has no TOML parser). `allowed`: a
 *  `[[permission.rules]]` entry already allows KIMI_ALLOW_PATTERN. `inline`: `rules` is written as a static array
 *  (`[permission] rules = [...]`, `permission.rules = [...]`, `permission = {...}`, a `[permission.rules]` table), where a later `[[permission.rules]]` is a
 *  TOML error that would stop kimi loading its whole config. */
function scanKimiPermissionRules(toml: string): { allowed: boolean; inline: boolean } {
  let table = '', isArray = false, decision = '', pattern = '', allowed = false, inline = false;
  const flush = () => {
    if (isArray && table === 'permission.rules' && decision === 'allow' && pattern === KIMI_ALLOW_PATTERN) allowed = true;
    decision = pattern = '';
  };
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      flush();
      isArray = header[1] === '[[';
      table = header[2]!.replace(/["'\s]/g, '');
      if (table === 'permission.rules' && !isArray) inline = true;   // a plain [permission.rules] table cannot also be an array of tables
      continue;
    }
    if (isArray && table === 'permission.rules') {
      decision = /^decision\s*=\s*["']([^"']*)["']/.exec(line)?.[1] ?? decision;
      pattern = /^pattern\s*=\s*["']([^"']*)["']/.exec(line)?.[1] ?? pattern;
    } else if ((table === '' && /^permission\s*(=|\.\s*rules\s*=)/.test(line)) || (table === 'permission' && /^rules\s*=/.test(line))) {
      inline = true;
    }
  }
  flush();
  return { allowed, inline };
}

/** Append the allow rule for captain-memo's own tools to kimi 2.x's config.toml, unless an equivalent `[[permission.rules]]`
 *  allow is already there (the input comes back unchanged, whoever wrote the rule). Append-only, like mergeCodexToolApprovals:
 *  no other rule is touched or reordered. Kimi evaluates a user deny rule, then an ask rule, BEFORE any allow, so those of
 *  the user still win over this one. THROWS when `rules` is written as a static array (see scanKimiPermissionRules). */
export function mergeKimiAllowRule(existingToml: string | null): string {
  const base = existingToml ?? '';
  const { allowed, inline } = scanKimiPermissionRules(base);
  if (allowed) return base;
  if (inline) throw new Error('permission rules are written as a static array');
  const block = '# captain-memo: lets kimi call the captain-memo MCP tools without asking each time (`captain-memo connect kimi`); your own deny and ask rules still win\n'
    + '[[permission.rules]]\n'
    + 'decision = "allow"\n'
    + `pattern = ${JSON.stringify(KIMI_ALLOW_PATTERN)}\n`
    + 'reason = "captain-memo MCP tools (added by `captain-memo connect kimi`)"\n';
  return base.trim() === '' ? block : `${base.replace(/\s+$/, '')}\n\n${block}`;
}

/** The model bare `kimi` should default to: the first that isn't obviously an embedder (`ollama list` returns
 *  those too — captain-memo's own README tells users to pull one — and an embedder cannot chat). undefined ⇒
 *  nothing chat-like is installed. Every model is still emitted as a [models.*] alias, so `-m` reaches them all.
 *  ponytail: a name heuristic, not a capability probe — the real check is POST /api/show and connect() is sync. */
export function pickChatModel(models: string[]): string | undefined {
  return models.find((m) => !/embed|bge|minilm|nomic|gte-|e5-/i.test(m)) ?? undefined;
}

/** The local Ollama model ids, via the `ollama` CLI (`ollama list` → first column, header skipped).
 *  ponytail: no tools-capability filter — that needs an async POST /api/show and connect() is sync. A
 *  non-agentic model simply fails at run time; the user picks with `-m`. */
export function parseOllamaList(stdout: string): string[] {
  return stdout.split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((n) => n.length > 0 && n !== 'NAME');
}

// --- adapters ----------------------------------------------------------------

// Codex CLI (~/.codex, or $CODEX_HOME - see codexHomeDir). Register: `codex mcp add captain-memo -- bun <path>`.
// Skill: copy SKILL.md → <codex home>/skills/captain-memo/SKILL.md.
/** Every tool captain-memo's MCP server exposes. Codex approves MCP tools ONE AT A TIME, so this
 *  list is what `connect codex` pre-approves. Kept as a literal rather than imported from
 *  src/mcp-server.ts so the CLI does not pull in the MCP SDK just to read names — a test asserts it
 *  stays identical to that server's `TOOLS`, so it cannot drift silently. */
export const CODEX_TOOL_NAMES = [
  'search_memory', 'remember', 'search_skill', 'list_skills', 'recommend_skills', 'load_skill',
  'list_capabilities', 'recommend_capabilities', 'get_capability',
  'search_observations', 'search_all', 'get_full',
  'reindex', 'stats', 'status', 'work_set', 'todo_add', 'todo_list', 'todo_claim', 'todo_unclaim', 'todo_done', 'work_active', 'work_clear',
] as const;

/** Pre-approve captain-memo's tools in codex's config.toml.
 *
 *  WHY THIS EXISTS: registering the server is not enough to make it usable non-interactively.
 *  Codex gates every MCP tool call behind an approval elicitation, and in `codex exec` there is no
 *  user to answer it — the call is rejected in ~13 ms with `user cancelled MCP tool call`. The skill
 *  still loads and still tells the model to recall, so the agent believes it has memory, silently
 *  gets none, and carries on. Anyone scripting `codex exec` in CI or a pipeline hits this.
 *
 *  Codex writes these blocks itself when you pick "Always allow" in the TUI, and the shape is its
 *  own: `[mcp_servers.<server>.tools.<tool>] approval_mode = "approve"`. It is PER TOOL — a
 *  server-level `approval_mode` is rejected outright by `codex --strict-config` as an unknown field.
 *
 *  Append-only on purpose: we add a block only when that exact header is absent, and never rewrite
 *  or reformat the rest of the file. config.toml is hand-edited and holds the user's model choice,
 *  profiles and other servers; round-tripping it through a TOML writer would reflow all of that. */
export function mergeCodexToolApprovals(existingToml: string, tools: readonly string[] = CODEX_TOOL_NAMES): string {
  let out = existingToml;
  for (const tool of tools) {
    const header = `[mcp_servers.captain-memo.tools.${tool}]`;
    if (out.includes(header)) continue;
    out = `${out.replace(/\n+$/, '')}\n\n${header}\napproval_mode = "approve"\n`;
  }
  return out;
}

// Codex's home lives in shared/codex-home.ts so the other readers use the same resolution; re-exported for doctor and the tests.
export { codexHomeDir };

/** Codex's config.toml — the one file connect, `doctor` and the worker's boot refresh all look at. */
export function codexConfigPath(home: string = homedir(), env: Record<string, string | undefined> = process.env): string {
  return join(codexHomeDir(home, env), 'config.toml');
}

/** What config.toml says about captain-memo: is the server registered in it, and which tools in CODEX_TOOL_NAMES have no
 *  approval block yet. The ONE reading `captain-memo doctor` and the worker's boot refresh both go by.
 *
 *  Registered = the server's own table header on a line by itself. Not a prefix match: every approval block also starts
 *  `[mcp_servers.captain-memo`, so leftovers from a server that was removed would read as a registration.
 *  "Missing" asks mergeCodexToolApprovals itself (it returns its input unchanged when the header is there), so the two
 *  can never disagree about what counts as present. */
export function codexApprovalState(toml: string | null): { registered: boolean; missing: string[] } {
  if (toml === null || !/^[ \t]*\[mcp_servers\.captain-memo\][ \t]*(?:#.*)?$/m.test(toml)) return { registered: false, missing: [] };
  return { registered: true, missing: CODEX_TOOL_NAMES.filter((tool) => mergeCodexToolApprovals(toml, [tool]) !== toml) };
}

/** Keep the approvals current after a release adds a tool: `connect codex` writes them once, and nothing else did, so
 *  Codex prompted for (or, under `codex exec`, silently rejected) every tool added since. Called by the worker after every
 *  boot, which is where every update route ends (src/worker/index.ts).
 *
 *  Append-only through mergeCodexToolApprovals, and ONLY into a config that already registers captain-memo: it never
 *  creates the file or the directory, and never registers a server the user did not connect. A block that is already there
 *  is left alone whatever its approval_mode. Idempotent; never throws (a failure is one log line, `doctor` still sees the
 *  gap). CAPTAIN_MEMO_CODEX_APPROVALS=0 turns it off. Returns the tools it added. */
export function refreshCodexToolApprovals(
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = () => {},
): string[] {
  if (env.CAPTAIN_MEMO_CODEX_APPROVALS === '0') return [];
  const cfgPath = codexConfigPath(home, env);
  try {
    if (!existsSync(cfgPath)) return [];
    const before = readFileSync(cfgPath, 'utf-8');
    const { missing } = codexApprovalState(before);
    if (missing.length === 0) return [];
    writeFileSync(cfgPath, mergeCodexToolApprovals(before, missing));
    log(`codex approvals: appended ${missing.length} missing captain-memo tool approval${missing.length === 1 ? '' : 's'} to ${cfgPath} (${missing.join(', ')}); CAPTAIN_MEMO_CODEX_APPROVALS=0 turns this off`);
    return missing;
  } catch (e) {
    log(`codex approvals: could not refresh ${cfgPath} (${(e as Error).message})`);
    return [];
  }
}

export const CAPTAIN_MEMO_CODEX_HOOK_MARKER = 'captain-memo-codex-hook-managed';

type CommandHookEntry = {
  type?: string;
  command?: string;
  timeout?: number;
  async?: boolean;
  [key: string]: unknown;
};
type CommandHookGroup = { hooks?: CommandHookEntry[]; [key: string]: unknown };
type CodexHooksFile = {
  hooks?: Record<string, CommandHookGroup[]>;
  [key: string]: unknown;
};

/** Read `codex features list` rather than guessing support from a version. The
 *  last column is the effective value, so an explicit `[features] hooks=false`
 *  correctly keeps Captain Memo on rollout capture. */
export function codexHooksEnabled(result: RunResult): boolean {
  if (result.status !== 0) return false;
  return (result.stdout ?? '').split(/\r?\n/).some((line) => {
    const cols = line.trim().split(/\s+/);
    return cols[0] === 'hooks' && cols.at(-1) === 'true';
  });
}

/** One argument of a hook command line, as the host CLI's shell will read it. Bare when it can be: a line
 *  that STARTS with a quoted word makes cmd.exe (the shell Codex uses for hooks on Windows) strip the first
 *  and last quote of the whole line and run `bun" "C:\...` — "hook exited with code 1" on every prompt.
 *  Backslashes are escaped for sh only; inside cmd.exe quotes they are literal path separators, and
 *  doubling them turned every Windows path into C:\\Users\\... */
function quoteHookArg(value: string): string {
  if (!/[\s"']/.test(value)) return value;
  const inner = process.platform === 'win32' ? value.replace(/"/g, '\\"') : value.replace(/(["\\])/g, '\\$1');
  return `"${inner}"`;
}

/** Merge Captain Memo's native Codex hooks while preserving every foreign
 *  top-level key, event group, and command. Managed entries are replaced in
 *  place on reconnect so a moved checkout never leaves stale executable refs. */
export function mergeCodexHooks(existingJson: string | null, hookCommand: string, hookBundle: string): string {
  let root: CodexHooksFile = {};
  if (existingJson && existingJson.trim()) {
    const parsed = JSON.parse(existingJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('hooks.json must contain a JSON object');
    }
    root = parsed as CodexHooksFile;
  }
  const hooks = root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks)
    ? root.hooks
    : {};

  // Strip only our prior command entries. If a group also contains a foreign
  // command, keep the group and all its matcher/metadata intact.
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    hooks[event] = groups.flatMap((group) => {
      const entries = Array.isArray(group?.hooks)
        ? group.hooks.filter((entry) => !entry.command?.includes(CAPTAIN_MEMO_CODEX_HOOK_MARKER))
        : [];
      return entries.length > 0 ? [{ ...group, hooks: entries }] : [];
    });
  }

  const command = (alias: string) =>
    `${quoteHookArg(hookCommand)} ${quoteHookArg(hookBundle)} ${alias} ${CAPTAIN_MEMO_CODEX_HOOK_MARKER}`;   // marker as an extra argument (ignored by the hook); `# marker` is not a comment to cmd.exe
  const managed: Record<string, CommandHookEntry> = {
    UserPromptSubmit: {
      type: 'command', command: command('CodexUserPromptSubmit'), timeout: NATIVE_PROMPT_HOOK_TIMEOUT_S,
      // Captain Memo's default injection budget is 4k tokens; Codex otherwise
      // truncates command-hook context at its lower 2.5k default.
      additionalContextLimit: 5_000,
    },
    // Keep observation delivery synchronous: marking a session native suppresses
    // its rollout fallback, so Codex must know enqueue completed before moving on.
    PostToolUse: { type: 'command', command: command('CodexPostToolUse'), timeout: 5 },
    // The work-board claim and the edit/deploy guards. No matcher: the hook returns at once for tools that write nothing.
    PreToolUse: { type: 'command', command: command('CodexPreToolUse'), timeout: 5 },
    Stop: { type: 'command', command: command('CodexStop'), timeout: 30 },
    // The articles once per session (and again after /compact); same 2.5k default truncation as above.
    SessionStart: {
      type: 'command', command: command('CodexSessionStart'), timeout: NATIVE_PROMPT_HOOK_TIMEOUT_S,
      additionalContextLimit: 5_000,
    },
  };
  for (const [event, entry] of Object.entries(managed)) {
    (hooks[event] ??= []).push({ hooks: [entry] });
  }
  root.hooks = hooks;
  return JSON.stringify(root, null, 2) + '\n';
}

export const CAPTAIN_MEMO_GEMINI_HOOK_MARKER = 'captain-memo-gemini-hook-managed';

export function geminiHooksSupported(result: RunResult): boolean {
  if (result.status !== 0) return false;
  return /Manage Gemini CLI hooks|gemini hooks migrate/i.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}

/** The x.y.z from `gemini --version` (its stdout is the version alone; settings warnings go to stderr), or null. A
 *  preview or nightly prints a suffix (0.62.0-preview.0, 0.62.0-nightly.20260925.gbedef96ef): dropped, since the switch
 *  follows the release line. */
export function parseGeminiVersion(result: RunResult): string | null {
  return result.status === 0 ? /^\s*(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?\s*$/m.exec(result.stdout ?? '')?.[1] ?? null : null;
}

/** Whether this gemini needs the old `hooks.enabled` switch. The switch moved twice; read from each release's settings
 *  schema and run through its own validator (2026-09-25):
 *    0.21-0.23  tools.enableHooks (default false). A `hooks.enabled` key fails their schema (hooks.* must be arrays).
 *    0.24-0.25  tools.enableHooks (default true) AND hooks.enabled (default FALSE): the only releases that need it.
 *    0.26-0.27  tools.enableHooks AND hooksConfig.enabled (default true); `hooks.enabled` is "Expected array".
 *    0.28+      hooksConfig.enabled only. The invalid key is a warning printed on every start, not a refusal.
 *  An unknown version gets the key: a startup warning on a newer CLI beats hooks silently off on 0.24/0.25. */
export function geminiNeedsHooksEnabledKey(version: string | null | undefined): boolean {
  return !version || (compareSemver(version, '0.24.0') >= 0 && compareSemver(version, '0.26.0') < 0);
}

/** Doctor's check: does this Gemini settings file carry a boolean `hooks.enabled` that the CLI answering `version`
 *  rejects at every start (any release outside 0.24-0.25, see geminiNeedsHooksEnabledKey)? Only `connect` rewrites the
 *  file, and self-update never runs it, so an install wired before the version gate keeps the old shape. `version` is
 *  called only when that shape is present, and an unreadable version answers false: doctor cannot tell, so it says
 *  nothing. */
export function geminiHooksToggleRejected(settingsJson: string | null, version: () => RunResult): boolean {
  let hooks: unknown;
  try { hooks = (JSON.parse(settingsJson ?? '') as { hooks?: unknown } | null)?.hooks; } catch { return false; }
  if (!hooks || typeof hooks !== 'object' || typeof (hooks as { enabled?: unknown }).enabled !== 'boolean') return false;
  const v = parseGeminiVersion(version());
  return v !== null && !geminiNeedsHooksEnabledKey(v);
}

/** Enable and merge Gemini's lifecycle hooks, for the switch `version` reads (geminiNeedsHooksEnabledKey). A
 *  `hooks.enabled` an older connect left behind is removed where it is invalid, so re-running connect repairs it.
 *  The user's foreign settings and hook groups survive byte-for-structure; only Captain Memo commands carrying our
 *  marker are replaced. */
export function mergeGeminiHooks(existingJson: string | null, hookCommand: string, hookBundle: string, version?: string | null): string {
  let root: Record<string, unknown> = {};
  if (existingJson && existingJson.trim()) {
    const parsed = JSON.parse(existingJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings.json must contain a JSON object');
    }
    root = parsed as Record<string, unknown>;
  }
  const tools = root.tools && typeof root.tools === 'object' && !Array.isArray(root.tools)
    ? root.tools as Record<string, unknown>
    : {};
  tools.enableHooks = true;
  root.tools = tools;
  const hooksConfig = root.hooksConfig && typeof root.hooksConfig === 'object' && !Array.isArray(root.hooksConfig)
    ? root.hooksConfig as Record<string, unknown>
    : {};
  hooksConfig.enabled = true;   // valid on every version checked (0.22-0.61), read from 0.26
  root.hooksConfig = hooksConfig;
  const hooks = root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks)
    ? root.hooks as Record<string, unknown>
    : {};
  if (geminiNeedsHooksEnabledKey(version)) hooks.enabled = true;
  else delete hooks.enabled;

  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    hooks[event] = value.flatMap((group: CommandHookGroup) => {
      const entries = Array.isArray(group?.hooks)
        ? group.hooks.filter((entry) => !entry.command?.includes(CAPTAIN_MEMO_GEMINI_HOOK_MARKER))
        : [];
      return entries.length > 0 ? [{ ...group, hooks: entries }] : [];
    });
  }
  const command = (alias: string) =>
    `${quoteHookArg(hookCommand)} ${quoteHookArg(hookBundle)} ${alias} ${CAPTAIN_MEMO_GEMINI_HOOK_MARKER}`;   // marker as an extra argument (ignored by the hook); `# marker` is not a comment to cmd.exe
  const add = (event: string, alias: string, timeout: number, matcher?: string) => {
    const groups = Array.isArray(hooks[event]) ? hooks[event] as CommandHookGroup[] : [];
    groups.push({
      ...(matcher !== undefined ? { matcher } : {}),
      hooks: [{
        name: `captain-memo-${event.toLowerCase()}`,
        type: 'command', command: command(alias), timeout,
        description: 'Captain Memo native memory and observation capture',
      }],
    });
    hooks[event] = groups;
  };
  add('BeforeAgent', 'GeminiBeforeAgent', NATIVE_PROMPT_HOOK_TIMEOUT_S * 1000);
  add('AfterTool', 'GeminiAfterTool', 5_000, '*');
  add('BeforeTool', 'GeminiBeforeTool', 5_000, 'write_file|replace|run_shell_command');   // work-board claim + edit/deploy guards
  add('AfterAgent', 'GeminiAfterAgent', 30_000);
  add('SessionStart', 'GeminiSessionStart', NATIVE_PROMPT_HOOK_TIMEOUT_S * 1000);   // no matcher: startup, resume and clear
  root.hooks = hooks;
  return JSON.stringify(root, null, 2) + '\n';
}

const codexAdapter: ToolAdapter = {
  id: 'codex',
  label: 'Codex CLI',
  detect({ home, run }) {
    return cliOnPath(run, 'codex') || existsSync(codexHomeDir(home));
  },
  connect(ctx) {
    let mcp: ConnectResult['mcp'] = 'failed';
    let detail: string | undefined;
    // Everything below lands where codex READS it: $CODEX_HOME when set, else ~/.codex (codexHomeDir). `codex mcp add`
    // already wrote its config.toml there, so the approvals and hooks must follow or they sit in a file codex never opens.
    // ponytail: skill-refresh.ts still refreshes only the ~/.codex copies of the skills, so a copy under $CODEX_HOME
    // is as fresh as the last `connect codex`; follow CODEX_HOME there if that matters.
    const codexHome = codexHomeDir(ctx.home);
    // A CODEX_HOME that is set but not there: codex refuses to start with it (codex-cli 0.159.3: `mcp list` prints "failed to
    // resolve CODEX_HOME", `mcp add` "failed to load configuration", and both go on "CODEX_HOME points to …, but that path
    // does not exist"). Writing anything here would make the directory (copySkill's mkdir), and codex would then start
    // quietly on an empty home with no login instead of telling the user their CODEX_HOME is wrong. So write nothing and
    // say so. (An unset or empty CODEX_HOME that has no <home>/.codex yet is the normal first run: codex makes that one itself.)
    if (process.env.CODEX_HOME && !existsSync(codexHome)) {
      return {
        tool: 'codex', mcp: 'failed', skill: 'skipped',
        detail: `CODEX_HOME points to "${codexHome}", but that path does not exist, and codex refuses to start with it. Nothing was registered or written. Create the directory or fix CODEX_HOME, then run \`captain-memo connect codex\` again`,
      };
    }
    // `codex mcp add <name> -- <command> [args...]`. The `--` separates the
    // launch command from codex's own flags. Idempotent: re-adding the same
    // name updates in place (codex handles "already added").
    const r = ctx.run('codex', ['mcp', 'add', 'captain-memo', '--', ...ctx.mcpCommand]);
    if (r.status === 0) mcp = 'added';
    else if (looksAlreadyPresent(r)) mcp = 'present';
    else detail = errDetail(r, 'codex mcp add failed');

    // Registration alone leaves `codex exec` unable to CALL anything (see mergeCodexToolApprovals).
    // Best-effort: a failure here does not undo a successful registration, it just means the user
    // gets the approval prompts interactively, which is codex's own default.
    if (mcp !== 'failed') {
      const cfgPath = join(codexHome, 'config.toml');
      try {
        const before = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : '';
        const after = mergeCodexToolApprovals(before);
        if (after !== before) {
          mkdirSync(dirname(cfgPath), { recursive: true });
          writeFileSync(cfgPath, after);
        }
      } catch (e) {
        detail = `MCP registered, but pre-approving tools failed (${(e as Error).message}) — codex will prompt for each tool`;
      }
    }

    const skill = copySkill(ctx.skillSource, join(codexHome, 'skills', 'captain-memo', 'SKILL.md'));

    // Native hooks landed after Captain Memo's rollout reader. Capability-probe
    // them so old CLIs remain untouched and a user-disabled hooks feature is
    // respected. A hook that actually fires marks its session in capture-state;
    // until then the worker continues reading rollout JSONL as the fallback.
    let capture: NonNullable<ConnectResult['capture']> = 'rollout-fallback';
    const featureProbe = ctx.run('codex', ['features', 'list'], PROBE_TIMEOUT_MS);
    if (codexHooksEnabled(featureProbe)) {
      const hooksPath = join(codexHome, 'hooks.json');
      const hookBundle = join(dirname(mcpServerPath(ctx.mcpCommand)), 'captain-memo-hook.js');
      try {
        const before = existsSync(hooksPath) ? readFileSync(hooksPath, 'utf-8') : null;
        const after = mergeCodexHooks(before, ctx.mcpCommand[0] ?? 'bun', hookBundle);
        if (after !== before) {
          mkdirSync(dirname(hooksPath), { recursive: true });
          writeFileSync(hooksPath, after);
          // Codex keeps a trusted_hash per hook and holds a new one back until the user accepts it in the TUI.
          // Both hooks Codex asks about are named: a first connect adds SessionStart and PreToolUse together (#223).
          const fresh = [['CodexSessionStart', 'SessionStart'], ['CodexPreToolUse', 'PreToolUse (the work-board guard)']].filter(([alias]) => !before?.includes(alias!)).map(([, label]) => label);
          if (fresh.length > 0) {
            const note = `Codex will ask once to trust the new ${fresh.join(' and ')} ${fresh.length > 1 ? 'hooks' : 'hook'} ("Trust all and continue"); until then codex exec skips ${fresh.length > 1 ? 'them' : 'it'}`;
            detail = detail ? `${detail}; ${note}` : note;
          }
        }
        capture = 'native-hooks';
      } catch (e) {
        capture = 'hook-install-failed';
        const hookError = `native hook install failed (${(e as Error).message}); rollout capture remains active`;
        detail = detail ? `${detail}; ${hookError}` : hookError;
      }
    }
    return withDetail({ tool: 'codex', mcp, skill, capture }, detail);
  },
};

// Gemini CLI (~/.gemini). Register (positional form):
//   `gemini mcp add captain-memo bun <path> -s user --trust`
// (-s user = user scope; --trust bypasses tool-confirmation prompts.)
// Skill: copy SKILL.md → ~/.gemini/skills/captain-memo/SKILL.md.
// NOTE: the gemini skills *read* path is unverified upstream — the MCP
// registration is what's confirmed working. See docs/cross-ai-tools.md.
const geminiAdapter: ToolAdapter = {
  id: 'gemini',
  label: 'Gemini CLI',
  detect({ home, run }) {
    return cliOnPath(run, 'gemini') || existsSync(join(home, '.gemini'));
  },
  connect(ctx) {
    let mcp: ConnectResult['mcp'] = 'failed';
    let detail: string | undefined;
    // positional: `gemini mcp add <name> <command> [args...]` then flags.
    const r = ctx.run('gemini', ['mcp', 'add', 'captain-memo', ...ctx.mcpCommand, '-s', 'user', '--trust']);
    if (r.status === 0) mcp = 'added';
    else if (looksAlreadyPresent(r)) mcp = 'present';
    else detail = errDetail(r, 'gemini mcp add failed');
    const skill = copySkill(ctx.skillSource, join(ctx.home, '.gemini', 'skills', 'captain-memo', 'SKILL.md'));
    let capture: NonNullable<ConnectResult['capture']> = 'rollout-fallback';
    // Gemini's Node-based CLI can take >5s on a cold start (the MCP wiring call
    // already has the same behavior), so this is capability work, not a PATH
    // detection probe. Reuse the wiring ceiling to avoid a false old-CLI result.
    const hookProbe = ctx.run('gemini', ['hooks', '--help'], WIRE_TIMEOUT_MS);
    if (geminiHooksSupported(hookProbe)) {
      const settingsPath = join(ctx.home, '.gemini', 'settings.json');
      const hookBundle = join(dirname(mcpServerPath(ctx.mcpCommand)), 'captain-memo-hook.js');
      try {
        const before = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : null;
        // The hooks switch moved between releases, so the version picks which one to write (one more cold start).
        const version = parseGeminiVersion(ctx.run('gemini', ['--version'], WIRE_TIMEOUT_MS));
        const after = mergeGeminiHooks(before, ctx.mcpCommand[0] ?? 'bun', hookBundle, version);
        if (after !== before) {
          mkdirSync(dirname(settingsPath), { recursive: true });
          writeFileSync(settingsPath, after);
        }
        capture = 'native-hooks';
      } catch (e) {
        capture = 'hook-install-failed';
        const hookError = `native hook install failed (${(e as Error).message}); transcript capture remains active`;
        detail = detail ? `${detail}; ${hookError}` : hookError;
      }
    }
    return withDetail({ tool: 'gemini', mcp, skill, capture }, detail);
  },
};

// Google Antigravity CLI (agy) — SUCCESSOR to the Gemini CLI (Gemini CLI is sunset for consumer tiers
// 2026-06-18). It reuses ~/.gemini but keeps its OWN MCP config at ~/.gemini/config/mcp_config.json and has
// NO `agy mcp add` subcommand, so register by read+parse+merge+write (never clobber). That file's top-level
// `mcpServers` object uses the same {name:{command,args,env}} stdio shape as Cursor's mcp.json (verified against
// agy 1.1.0's embedded schema), so we reuse mergeCursorMcpConfig. Skill best-effort to ~/.gemini/skills (shared
// with gemini; agy reads GEMINI.md/AGENTS.md context + skills). Wiring is auth-independent (config file) — agy's
// own login is a separate keyring OAuth.
const agyAdapter: ToolAdapter = {
  id: 'agy',
  label: 'Antigravity CLI (agy)',
  detect({ home, run }) {
    return cliOnPath(run, 'agy')
      || existsSync(join(home, '.gemini', 'antigravity-cli'))
      || existsSync(join(home, '.gemini', 'config', 'mcp_config.json'));
  },
  connect(ctx) {
    const mcpJsonPath = join(ctx.home, '.gemini', 'config', 'mcp_config.json');
    const serverPath = mcpServerPath(ctx.mcpCommand);
    let mcp: ConnectResult['mcp'] = 'failed';
    let detail: string | undefined;
    try {
      const existing = existsSync(mcpJsonPath) ? readFileSync(mcpJsonPath, 'utf-8') : null;
      let already = false;
      if (existing && existing.trim().length > 0) {
        try {
          const entry = JSON.parse(existing)?.mcpServers?.['captain-memo'];
          if (entry && Array.isArray(entry.args) && entry.args.includes(serverPath)) already = true;
        } catch { /* unparseable → merge below throws and we report failed */ }
      }
      const merged = mergeCursorMcpConfig(existing, serverPath);   // same top-level `mcpServers` stdio shape
      mkdirSync(dirname(mcpJsonPath), { recursive: true });
      writeFileSync(mcpJsonPath, merged);
      mcp = already ? 'present' : 'added';
    } catch (e) {
      detail = (e as Error).message;
    }
    const skill = copySkill(ctx.skillSource, join(ctx.home, '.gemini', 'skills', 'captain-memo', 'SKILL.md'));
    return withDetail({ tool: 'agy', mcp, skill }, detail);
  },
};

// goose (Block's OSS coding agent, Apache-2.0) — config-file only, see mergeGooseConfig above.
// Config lives at $XDG_CONFIG_HOME/goose/config.yaml, falling back to ~/.config/goose/config.yaml.
// VERIFIED against goose 1.45.0 on Linux: `goose info` reports exactly that path, and there is no
// non-interactive registration command (`goose configure` takes no args, `goose plugin install` is
// git-repos-only, `goose mcp <SERVER>` runs a BUNDLED server), so editing the file is the only route.
//
// SKILL: deliberately not written, and NOT for lack of a read path — `goose skills list` shows goose
// reads `~/.claude/skills/` (plus `builtin://skills/`). That directory belongs to CLAUDE CODE, which
// already receives this skill through the plugin install, so copying SKILL.md there to serve goose
// would plant a second copy in another tool's skill set. Wiring it is a cross-tool decision, not a
// goose one. Reports 'skipped' rather than silently reaching into a neighbour's config.
//
// Cross-platform: the config location differs per OS (see gooseConfigCandidates) and the PATH
// probe uses `where` on Windows, so detection and wiring both work on Linux, macOS and Windows.
const gooseAdapter: ToolAdapter = {
  id: 'goose',
  label: 'goose',
  detect({ home, run }) {
    return cliOnPath(run, 'goose') || existsSync(gooseConfigPath(home));
  },
  connect(ctx) {
    if (!bunYaml) {
      return {
        tool: 'goose', mcp: 'failed', skill: 'skipped',
        detail: 'this Bun has no native YAML support — upgrade Bun, or add the captain-memo block to config.yaml by hand',
      };
    }
    const cfgPath = gooseConfigPath(ctx.home);
    try {
      const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : null;
      const wanted = JSON.stringify(gooseExtensionEntry(mcpServerPath(ctx.mcpCommand)));
      const current = existing ? extractGooseEntry(existing) : null;
      if (current === wanted) return { tool: 'goose', mcp: 'present', skill: 'skipped' };
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, mergeGooseConfig(existing, mcpServerPath(ctx.mcpCommand)));
      return { tool: 'goose', mcp: 'added', skill: 'skipped' };
    } catch (e) {
      return {
        tool: 'goose', mcp: 'failed', skill: 'skipped',
        detail: `could not update ${cfgPath}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  },
};

// Cursor (~/.cursor) — no CLI for MCP. Register by merging ~/.cursor/mcp.json
// (read+parse+merge+write, never clobber). Skill: copy SKILL.md → ~/.cursor/rules/captain-memo.md.
const cursorAdapter: ToolAdapter = {
  id: 'cursor',
  label: 'Cursor',
  detect({ home }) {
    return existsSync(join(home, '.cursor'));
  },
  connect(ctx) {
    const mcpJsonPath = join(ctx.home, '.cursor', 'mcp.json');
    const serverPath = mcpServerPath(ctx.mcpCommand);
    let mcp: ConnectResult['mcp'] = 'failed';
    let detail: string | undefined;
    try {
      const existing = existsSync(mcpJsonPath) ? readFileSync(mcpJsonPath, 'utf-8') : null;
      // Detect "already wired with this exact path" → report 'present' (idempotent).
      let already = false;
      if (existing) {
        try {
          const parsed = JSON.parse(existing);
          const entry = parsed?.mcpServers?.['captain-memo'];
          if (entry && Array.isArray(entry.args) && entry.args.includes(serverPath)) already = true;
        } catch { /* unparseable → merge below throws and we report failed */ }
      }
      const merged = mergeCursorMcpConfig(existing, serverPath);
      mkdirSync(dirname(mcpJsonPath), { recursive: true });
      writeFileSync(mcpJsonPath, merged);
      mcp = already ? 'present' : 'added';
    } catch (e) {
      detail = (e as Error).message;
    }
    const skill = copySkill(ctx.skillSource, join(ctx.home, '.cursor', 'rules', 'captain-memo.md'));
    return withDetail({ tool: 'cursor', mcp, skill }, detail);
  },
};

// opencode (~/.config/opencode) — MIT, model-agnostic. No `mcp add` CLI; MCP + providers + the auto-approve agent
// are config-file, so register by merging opencode.json. Skill best-effort to the opencode skills dir (read path
// unverified upstream, like gemini). The OpenRouter key is written by reference, never literal.
const opencodeAdapter: ToolAdapter = {
  id: 'opencode',
  label: 'opencode',
  detect({ home, run }) {
    return cliOnPath(run, 'opencode') || existsSync(join(home, '.config', 'opencode')) || existsSync(join(home, '.opencode'));
  },
  connect(ctx) {
    const cfgPath = join(ctx.home, '.config', 'opencode', 'opencode.json');
    let mcp: ConnectResult['mcp'] = 'failed';
    let detail: string | undefined;
    try {
      const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : null;
      let already = false;
      if (existing) {
        try {
          const parsed = JSON.parse(existing);
          const cmd = parsed?.mcp?.['captain-memo']?.command;
          if (Array.isArray(cmd) && cmd.join(' ') === ctx.mcpCommand.join(' ') && parsed?.provider?.openrouter) already = true;
        } catch { /* unparseable → merge below rewrites it; reported 'added' */ }
      }
      const localProvider = ctx.localProvider ?? process.env.CAPTAIN_MEMO_OPENCODE_LOCAL_PROVIDER;
      const merged = mergeOpencodeConfig(existing, {
        mcpCommand: ctx.mcpCommand,
        ...(process.env.CAPTAIN_MEMO_OPENCODE_GATEWAY_ENDPOINT ? { gatewayEndpoint: process.env.CAPTAIN_MEMO_OPENCODE_GATEWAY_ENDPOINT } : {}),
        ...(process.env.CAPTAIN_MEMO_OPENCODE_LOCAL_ENDPOINT ? { localEndpoint: process.env.CAPTAIN_MEMO_OPENCODE_LOCAL_ENDPOINT } : {}),
        ...(localProvider ? { localProvider } : {}),
      });
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, merged);
      mcp = already ? 'present' : 'added';
    } catch (e) {
      detail = (e as Error).message;
    }
    const skill = copySkill(ctx.skillSource, join(ctx.home, '.config', 'opencode', 'skills', 'captain-memo', 'SKILL.md'));
    return withDetail({ tool: 'opencode', mcp, skill }, detail);
  },
};

// Mistral Vibe (~/.vibe) — Apache-2.0. No `mcp add` CLI; MCP is config.toml [[mcp_servers]], so register by
// appending a managed block (idempotent, append-only). Skill best-effort to ~/.vibe/skills (read path unverified).
const vibeAdapter: ToolAdapter = {
  id: 'vibe',
  label: 'Mistral Vibe',
  detect({ home, run }) {
    return cliOnPath(run, 'vibe') || existsSync(join(home, '.vibe'));
  },
  connect(ctx) {
    const cfgPath = join(ctx.home, '.vibe', 'config.toml');
    const serverPath = mcpServerPath(ctx.mcpCommand);
    let mcp: ConnectResult['mcp'] = 'failed';
    let detail: string | undefined;
    try {
      const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : null;
      const plan = planVibeMcpConfig(existing, serverPath);
      if (plan.text !== existing) {   // an entry that is already there leaves the file untouched, byte for byte
        mkdirSync(dirname(cfgPath), { recursive: true });
        writeFileSync(cfgPath, plan.text);
      }
      mcp = plan.added ? 'added' : 'present';
      if (plan.note) detail = `${cfgPath}: ${plan.note}`;
    } catch (e) {
      detail = (e as Error).message;
    }
    const skill = copySkill(ctx.skillSource, join(ctx.home, '.vibe', 'skills', 'captain-memo', 'SKILL.md'));
    return withDetail({ tool: 'vibe', mcp, skill }, detail);
  },
};

// kimi (MoonshotAI) — the local-first tool (a loopback Ollama in its own config.toml). TWO generations share the binary name
// `kimi` and live in different homes, each read only by its own binary:
//   1.x (kimi-cli, ~/.kimi): TWO halves, and BOTH matter:
//     1. PROVIDER CONFIG (~/.kimi/config.toml) — the LAUNCHABILITY half. Without it bare `kimi` has no
//        default_model to route to. Written as a managed block (mergeKimiConfig) from the host's own `ollama list`.
//        No models ⇒ we write NOTHING and say so in `detail` — a base_url-only config would be a lie.
//     2. MCP registration — `kimi mcp add <name> -- <command...>` (the codex form). VERIFIED on kimi-cli 1.48.0.
//        MCP servers land in ~/.kimi/mcp.json, SEPARATE from config.toml — the two halves never collide. A failure
//        soft-lands in `detail` with the CLI's own stderr; nothing is clobbered.
//     Skill best-effort to ~/.kimi/skills (read path unverified upstream, like gemini).
//   2.x (kimi-code, kimiCodeHomeDir = $KIMI_CODE_HOME else ~/.kimi-code): no `kimi mcp` command, so the server is merged into
//     <home>/mcp.json; the allow rule for our tools and the [[hooks]] go into <home>/config.toml; the skill into <home>/skills.
//     Connect does NOT write mergeKimiConfig's 1.x provider block there (2.x needs an api_key or api_key_env per provider).
// Which half runs: 2.x when `kimi --version` says major >= 2 (no readable version: when the 2.x home exists), and ALSO when a 2.x
// home exists next to a 1.x `kimi` on PATH; 1.x unless `kimi` is 2.x, and ALSO when ~/.kimi exists next to a 2.x `kimi`.
const kimiAdapter: ToolAdapter = {
  id: 'kimi',
  label: 'Kimi CLI',
  detect({ home, run }) {
    return cliOnPath(run, 'kimi') || existsSync(join(home, '.kimi')) || existsSync(kimiCodeHomeDir(home));
  },
  connect(ctx) {
    const mcps: ConnectResult['mcp'][] = [];
    const skills: ConnectResult['skill'][] = [];
    const details: string[] = [];
    let capture: NonNullable<ConnectResult['capture']> = 'rollout-fallback';
    const hookBundle = join(dirname(mcpServerPath(ctx.mcpCommand)), 'captain-memo-hook.js');

    const versionProbe = ctx.run('kimi', ['--version'], PROBE_TIMEOUT_MS);
    const major = kimiMajorVersion(versionProbe);
    const kimiCodeHome = kimiCodeHomeDir(ctx.home);
    const has2Home = existsSync(kimiCodeHome);
    const kimiIs2 = major !== null ? major >= 2 : has2Home;   // the `kimi` that runs is 2.x
    const do2 = kimiIs2 || has2Home;
    const do1 = !kimiIs2 || existsSync(join(ctx.home, '.kimi'));

    if (do1) {
      // 1. provider/model config — the half that actually makes kimi launchable.
      const cfgPath = join(ctx.home, '.kimi', 'config.toml');
      const models = parseOllamaList(ctx.run('ollama', ['list']).stdout ?? '');
      if (models.length === 0) {
        details.push('no local Ollama models found (`ollama list` empty or ollama not installed) — ~/.kimi/config.toml NOT written; pull a model (e.g. `ollama pull qwen3:8b`) and re-run `captain-memo connect kimi`');
      } else {
        if (!pickChatModel(models)) {
          details.push('every local Ollama model looks like an embedder (' + models.join(', ') + ') — no default_model written (an embedder cannot chat); pull a chat model (e.g. `ollama pull qwen3:8b`) and re-run `captain-memo connect kimi`');
        }
        try {
          const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : null;
          const merged = mergeKimiConfig(existing, { models });
          if (merged !== existing) {
            mkdirSync(dirname(cfgPath), { recursive: true });
            writeFileSync(cfgPath, merged);
          }
          const small = kimiSmallContexts(merged);
          if (small.length) details.push(`max_context_size in your own ~/.kimi/config.toml is below about 70,000 for ${small.join(', ')}: kimi compacts before your prompt reaches the model, so raise it there (connect leaves your own tables alone)`);
        } catch (e) {
          details.push('config.toml: ' + (e as Error).message);
        }
      }

      // 2. MCP registration (unverified argv — soft-fails into `detail`). Only while `kimi` is not 2.x: 2.x has no `mcp` command.
      if (!kimiIs2) {
        const r = ctx.run('kimi', ['mcp', 'add', 'captain-memo', '--', ...ctx.mcpCommand]);
        if (r.status === 0) mcps.push('added');
        else if (looksAlreadyPresent(r)) mcps.push('present');
        else { mcps.push('failed'); details.push(errDetail(r, 'kimi mcp add failed')); }
      } else {
        details.push('~/.kimi (a kimi 1.x home) also exists, but `kimi` on PATH is 2.x, so MCP and hooks were not set up there');
      }

      skills.push(copySkill(ctx.skillSource, join(ctx.home, '.kimi', 'skills', 'captain-memo', 'SKILL.md')));
      if (!kimiIs2 && kimiHooksSupported(versionProbe)) {
        try {
          const before = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : null;
          const after = mergeKimiHooks(before, ctx.mcpCommand[0] ?? 'bun', hookBundle);
          if (after !== before) {
            mkdirSync(dirname(cfgPath), { recursive: true });
            writeFileSync(cfgPath, after);
          }
          capture = 'native-hooks';
        } catch (e) {
          capture = 'hook-install-failed';
          details.push(`native hook install failed (${(e as Error).message}); transcript capture remains active`);
        }
      }
    }

    if (do2) {
      try { mkdirSync(kimiCodeHome, { recursive: true, mode: 0o700 }); } catch (e) { details.push(`kimi 2.x: could not create ${kimiCodeHome} (${(e as Error).message})`); }

      // MCP → <home>/mcp.json. An unreadable or invalid file is left exactly as it is.
      const mcpPath = join(kimiCodeHome, 'mcp.json');
      try {
        const after = mergeKimiCodeMcp(existsSync(mcpPath) ? readFileSync(mcpPath, 'utf-8') : null, ctx.mcpCommand);
        if (after === null) mcps.push('present');
        else {
          writeFileAtomic(mcpPath, after);
          mcps.push('added');
          details.push(`kimi 2.x: captain-memo registered in ${mcpPath}`);
        }
      } catch (e) {
        mcps.push('failed');
        details.push(`kimi 2.x: ${mcpPath} was NOT changed: ${(e as Error).message}; fix it and re-run \`captain-memo connect kimi\``);
      }

      // config.toml: the allow rule FIRST, then the hooks block. mergeKimiHooks cuts its block out and appends it again at the
      // end, so a rule appended after it would be moved behind it by every re-run (a rewrite each time).
      const cfg2 = join(kimiCodeHome, 'config.toml');
      try {
        const before = existsSync(cfg2) ? readFileSync(cfg2, 'utf-8') : null;
        let toml = before;
        try {
          const withRule = mergeKimiAllowRule(toml);
          if (withRule !== (toml ?? '')) details.push(`kimi 2.x: allow rule for ${KIMI_ALLOW_PATTERN} added to ${cfg2} (kimi otherwise asks before every captain-memo tool call; your own deny and ask rules still win)`);
          toml = withRule;
        } catch {
          details.push(`kimi 2.x: ${cfg2} writes its permission rules as a static array, so connect did not add the allow rule: add it yourself as [[permission.rules]] with decision = "allow" and pattern = "${KIMI_ALLOW_PATTERN}", or kimi will ask before every captain-memo tool call`);
        }
        toml = mergeKimiHooks(toml, ctx.mcpCommand[0] ?? 'bun', hookBundle);
        if (toml !== before) writeFileAtomic(cfg2, toml);
        if (capture !== 'hook-install-failed') capture = 'native-hooks';
      } catch (e) {
        capture = 'hook-install-failed';
        details.push(`kimi 2.x: could not update ${cfg2} (${(e as Error).message}), so neither the allow rule nor the native hooks were written; transcript capture remains active`);
      }

      skills.push(copySkill(ctx.skillSource, join(kimiCodeHome, 'skills', 'captain-memo', 'SKILL.md')));
    }

    const mcp: ConnectResult['mcp'] = mcps.includes('added') ? 'added' : mcps.includes('present') ? 'present' : 'failed';
    const skill: ConnectResult['skill'] = skills.every((r) => r === 'installed') ? 'installed' : 'failed';
    return withDetail({ tool: 'kimi', mcp, skill, capture }, details.length ? details.join('; ') : undefined);
  },
};

/** VS Code's user folder on THIS machine (see shared/vscode-paths.ts for the per-OS paths and how far they are verified). */
export function vscodeUserDir(home: string): string {
  return vscodeUserDirFor(isWindows ? 'win32' : isMac ? 'darwin' : 'linux', home);
}

// VS Code (Copilot agent mode) — MCP is GA. Auto-wire by merging mcp.json in VS Code's user folder (top-level
// `servers`, stdio). Skill best-effort to the user prompts folder as a *.instructions.md (read path unverified).
const vscodeAdapter: ToolAdapter = {
  id: 'vscode',
  label: 'VS Code (Copilot)',
  detect({ home, run }) {
    return cliOnPath(run, 'code') || existsSync(dirname(vscodeUserDir(home))) || existsSync(join(home, '.vscode'));
  },
  connect(ctx) {
    const userDir = vscodeUserDir(ctx.home);
    const mcpJsonPath = join(userDir, 'mcp.json');
    const serverPath = mcpServerPath(ctx.mcpCommand);
    let mcp: ConnectResult['mcp'] = 'failed';
    let detail: string | undefined;
    try {
      const existing = existsSync(mcpJsonPath) ? readFileSync(mcpJsonPath, 'utf-8') : null;
      let already = false;
      if (existing) {
        try {
          const entry = JSON.parse(existing)?.servers?.['captain-memo'];
          if (entry && Array.isArray(entry.args) && entry.args.includes(serverPath)) already = true;
        } catch { /* unparseable → merge below throws and we report failed */ }
      }
      const merged = mergeVscodeMcpConfig(existing, serverPath);
      mkdirSync(dirname(mcpJsonPath), { recursive: true });
      writeFileSync(mcpJsonPath, merged);
      mcp = already ? 'present' : 'added';
    } catch (e) {
      detail = (e as Error).message;
    }
    const skill = copySkill(ctx.skillSource, join(userDir, 'prompts', 'captain-memo.instructions.md'));
    return withDetail({ tool: 'vscode', mcp, skill }, detail);
  },
};

// JetBrains (AI Assistant / Junie) — MCP is configured IN-IDE only; no programmatic config file. Honest
// assisted-manual adapter: detect + write a paste-ready `mcpServers` snippet + copy the skill, report the manual step.
const jetbrainsAdapter: ToolAdapter = {
  id: 'jetbrains',
  label: 'JetBrains (AI Assistant)',
  detect({ home, run }) {
    return cliOnPath(run, 'phpstorm') || cliOnPath(run, 'idea')
      || existsSync(join(home, '.config', 'JetBrains')) || existsSync(join(home, '.local', 'share', 'JetBrains'));
  },
  connect(ctx) {
    const serverPath = mcpServerPath(ctx.mcpCommand);
    let detail = 'JetBrains AI Assistant MCP is configured in-IDE — add captain-memo via Settings | Tools | AI Assistant | MCP';
    try {
      const snipPath = join(ctx.home, '.config', 'JetBrains', 'captain-memo-mcp.json');
      mkdirSync(dirname(snipPath), { recursive: true });
      writeFileSync(snipPath, jetbrainsMcpSnippet(serverPath));
      detail += ` (paste-ready snippet written to ${snipPath})`;
    } catch { /* the snippet is a convenience; the manual menu step is the real instruction */ }
    const skill = copySkill(ctx.skillSource, join(ctx.home, '.config', 'JetBrains', 'captain-memo.md'));
    return withDetail({ tool: 'jetbrains', mcp: 'skipped', skill }, detail);
  },
};

/** Claude Desktop's config directory, or null when the app is not installed.
 *  Roaming first — that is where the config was verified to live on Windows;
 *  the Local fallback covers layouts that differ. Returns the directory that
 *  actually exists rather than assuming one.
 *
 *  VERIFIED vs. CONVENTION-DERIVED: the Windows Roaming entry (%APPDATA%\Claude) and the
 *  macOS entry (~/Library/Application Support/Claude) were both OBSERVED on real machines.
 *  The Linux entry below was NOT — Claude Desktop shipped a Linux beta 2026-06-30 (Ubuntu
 *  22.04+/Debian 12+), but nobody has checked a real install here yet. It is derived from a
 *  pattern, not a citation: the two verified paths above are exactly Electron's standard
 *  `userData` layout for an app named "Claude" (`%APPDATA%\<app>` on Windows,
 *  `~/Library/Application Support/<app>` on macOS), and `~/.config/<app>` (or
 *  `$XDG_CONFIG_HOME/<app>` when set) is the Linux member of that same three-OS triple. If
 *  you get access to a Linux box with the app installed, confirm this before trusting it. */
function claudeDesktopConfigDir(home: string): string | null {
  const candidates = [
    process.env.APPDATA ? join(process.env.APPDATA, 'Claude') : join(home, 'AppData', 'Roaming', 'Claude'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Claude') : join(home, 'AppData', 'Local', 'Claude'),
    join(home, 'Library', 'Application Support', 'Claude'),   // macOS — VERIFIED (Electron userData)
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'Claude') : join(home, '.config', 'Claude'),   // Linux — UNVERIFIED, convention-derived (see doc comment)
  ];
  for (const dir of candidates) if (existsSync(dir)) return dir;
  return null;
}

// Claude Desktop chat app (GUI). Local stdio MCP server via claude_desktop_config.json.
// VERIFIED on Windows: the config lives in ROAMING %APPDATA%\Claude\ — not %LOCALAPPDATA%,
// which is where the third-party-inference build keeps ITS data directory.
// Tools only: the chat app has no hook surface, so there is no passive capture and no
// auto-injection (spec 2026-08-07 §3). SKILL.md is deliberately NOT copied — no confirmed
// read path exists, and writing one would produce a file nothing loads plus a report that
// overstates what was wired.
const claudeDesktopAdapter: ToolAdapter = {
  id: 'claude-desktop',
  label: 'Claude Desktop (chat app)',
  detect({ home }) {
    return claudeDesktopConfigDir(home) !== null;
  },
  connect(ctx) {
    const dir = claudeDesktopConfigDir(ctx.home);
    if (dir === null) {
      return { tool: 'claude-desktop', mcp: 'skipped', skill: 'skipped', detail: 'Claude Desktop config directory not found' };
    }
    const cfgPath = join(dir, 'claude_desktop_config.json');
    const serverPath = mcpServerPath(ctx.mcpCommand);
    // process.execPath is the ABSOLUTE bun binary running this CLI — exactly what the app
    // needs, with no PATH lookup and no `which` probe.
    const command = process.execPath;

    let mcp: ConnectResult['mcp'] = 'failed';
    let detail: string | undefined;
    try {
      const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : null;
      let already = false;
      if (existing && existing.trim().length > 0) {
        try {
          const entry = JSON.parse(existing)?.mcpServers?.['captain-memo'];
          if (entry && entry.command === command && Array.isArray(entry.args) && entry.args.includes(serverPath)) {
            already = true;
          }
        } catch { /* unparseable → the merge below throws and we report failed */ }
      }
      const merged = mergeClaudeDesktopConfig(existing, command, serverPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(cfgPath, merged);
      mcp = already ? 'present' : 'added';
    } catch (e) {
      detail = (e as Error).message;
    }
    return withDetail({ tool: 'claude-desktop', mcp, skill: 'skipped' }, detail);
  },
};

export const ADAPTERS: ToolAdapter[] = [codexAdapter, geminiAdapter, agyAdapter, gooseAdapter, cursorAdapter, opencodeAdapter, vibeAdapter, kimiAdapter, vscodeAdapter, jetbrainsAdapter, claudeDesktopAdapter];

// Detect installed tools (or the `only` subset), connect each, return reports.
// `only` filters by adapter id; an unknown id yields a skipped result so the
// caller can report "no such tool" rather than silently doing nothing.
// `home`/`run` are injectable for tests (default to the real home + spawnSync).
export function connectCrossAi(opts: {
  only?: string[];
  mcpCommand: string[];
  skillSource: string;
  home?: string;
  run?: Runner;
  localProvider?: string;   // opencode-only: which local runtime to configure (ollama | vllm | lmstudio)
  /** Called BEFORE each probe and each write, so a stall names the tool it is stuck on
   *  rather than leaving a bare section header on screen. */
  onProbe?: (tool: string, phase: 'detect' | 'connect') => void;
}): ConnectResult[] {
  const home = opts.home ?? homedir();
  const run = opts.run ?? defaultRunner;
  const ctx: ConnectCtx = { mcpCommand: opts.mcpCommand, skillSource: opts.skillSource, home, run, ...(opts.localProvider ? { localProvider: opts.localProvider } : {}) };

  if (opts.only && opts.only.length > 0) {
    const results: ConnectResult[] = [];
    for (const id of opts.only) {
      const adapter = ADAPTERS.find((a) => a.id === id);
      if (!adapter) {
        results.push({ tool: id, mcp: 'skipped', skill: 'skipped', detail: 'unknown tool (expected: ' + ADAPTERS.map((a) => a.id).join(' | ') + ')' });
        continue;
      }
      // Explicit `only` wires the tool even if detect() is iffy — the user named it.
      results.push(adapter.connect(ctx));
    }
    return results;
  }

  // Auto-detect: connect every installed tool.
  //
  // ANNOUNCE BEFORE ACTING, never after. detect() shells out to `which <cli>`, which walks
  // every PATH entry — one network mount or stale automount in PATH and it blocks. Reported
  // from a real upgrade: the installer printed the section header and then went silent long
  // enough that the operator killed it, with nothing on screen naming what it was doing. The
  // probe timeout bounds the hang; this makes the last line on screen say which tool caused
  // it. Printing after the fact only ever tells you about the steps that already finished.
  const results: ConnectResult[] = [];
  for (const adapter of ADAPTERS) {
    opts.onProbe?.(adapter.id, 'detect');
    if (!adapter.detect({ home, run })) continue;
    opts.onProbe?.(adapter.id, 'connect');
    results.push(adapter.connect(ctx));
  }
  return results;
}

// Just report which tools are detected (no changes). Claude Code is listed as
// already-wired (handled by the plugin install) for an at-a-glance full picture.
export interface DetectionRow {
  id: string;
  label: string;
  detected: boolean;
  note?: string;
}

export function detectCrossAi(opts: { home?: string; run?: Runner } = {}): DetectionRow[] {
  const home = opts.home ?? homedir();
  const run = opts.run ?? defaultRunner;
  const rows: DetectionRow[] = [
    { id: 'claude-code', label: 'Claude Code', detected: existsSync(join(home, '.claude')), note: 'wired by the plugin install' },
  ];
  for (const a of ADAPTERS) {
    rows.push({ id: a.id, label: a.label, detected: a.detect({ home, run }) });
  }
  return rows;
}

// Pretty-print a connect report (used by both `connect` and the install tail).
export function printConnectReport(results: ConnectResult[]): void {
  if (results.length === 0) {
    info('No other AI tools detected. Claude Code is wired by the plugin install.');
    return;
  }
  for (const r of results) {
    const mcpLabel = r.mcp === 'added' ? 'MCP registered'
      : r.mcp === 'present' ? 'MCP already registered'
      : r.mcp === 'skipped' ? 'skipped'
      : 'MCP registration FAILED';
    const skillLabel = r.skill === 'installed' ? 'skill installed'
      : r.skill === 'failed' ? 'skill copy failed'
      : 'skill skipped';
    const captureLabel = r.capture === 'native-hooks' && r.tool === 'codex'
      ? ', native observation hooks installed (review once in /hooks)'
      : r.capture === 'native-hooks' ? ', native observation hooks installed'
      : r.capture === 'rollout-fallback' ? ', transcript/rollout observation fallback'
      : r.capture === 'hook-install-failed' ? ', native hook install failed'
      : '';
    const line = `${r.tool}: ${mcpLabel}, ${skillLabel}${captureLabel}${r.detail ? ` — ${r.detail}` : ''}`;
    if (r.mcp === 'failed') warn(line);
    else if (r.mcp === 'skipped') info(line);
    else ok(line);
  }
}
