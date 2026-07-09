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

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

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
export type Runner = (cmd: string, args: string[]) => RunResult;

const defaultRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' });
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
  const r = run('which', [id]);
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

// --- cursor mcp.json merge (PURE — unit-tested without disk) -----------------
// Read the existing ~/.cursor/mcp.json (as a string, or null/'' when absent),
// merge in mcpServers["captain-memo"] = { command: 'bun', args: [path] }, and
// return the serialized result. Preserves every other server and top-level key.
// Idempotent: re-merging the same path yields identical content. Refreshes the
// path if it changed (re-point to a moved mcp-server.js).
export function mergeCursorMcpConfig(existingJson: string | null, mcpServerPath: string): string {
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
  servers['captain-memo'] = { command: 'bun', args: [mcpServerPath] };
  root.mcpServers = servers;
  return JSON.stringify(root, null, 2) + '\n';
}

// Pull the single mcp-server.js path out of mcpCommand for the cursor merge /
// CLI-positional forms. mcpCommand is ['bun', '<path>'] — the path is the arg
// after the command. Falls back to the last element so a longer argv still works.
function mcpServerPath(mcpCommand: string[]): string {
  return mcpCommand[1] ?? mcpCommand[mcpCommand.length - 1] ?? '';
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

// --- Mistral Vibe config.toml MCP block (append-if-absent; TOML) ----------------
// Vibe reads MCP servers from ~/.vibe/config.toml as `[[mcp_servers]]`. With no TOML parser we APPEND a single
// managed block (idempotent on a marker comment) and NEVER rewrite the user's TOML.
const VIBE_MCP_MARKER = '# captain-memo (managed by `captain-memo connect`)';
export function mergeVibeMcpConfig(existingToml: string | null, mcpServerPath: string): string {
  const base = existingToml ?? '';
  if (base.includes(VIBE_MCP_MARKER)) return base;
  const block = VIBE_MCP_MARKER + '\n'
    + '[[mcp_servers]]\n'
    + 'name = "captain-memo"\n'
    + 'transport = "stdio"\n'
    + 'command = "bun"\n'
    + 'args = [' + JSON.stringify(mcpServerPath) + ']\n';
  const sep = base === '' ? '' : (base.endsWith('\n') ? '\n' : '\n\n');
  return base + sep + block;
}

// --- adapters ----------------------------------------------------------------

// Codex CLI (~/.codex). Register: `codex mcp add captain-memo -- bun <path>`.
// Skill: copy SKILL.md → ~/.codex/skills/captain-memo/SKILL.md.
const codexAdapter: ToolAdapter = {
  id: 'codex',
  label: 'Codex CLI',
  detect({ home, run }) {
    return cliOnPath(run, 'codex') || existsSync(join(home, '.codex'));
  },
  connect(ctx) {
    let mcp: ConnectResult['mcp'] = 'failed';
    let detail: string | undefined;
    // `codex mcp add <name> -- <command> [args...]`. The `--` separates the
    // launch command from codex's own flags. Idempotent: re-adding the same
    // name updates in place (codex handles "already added").
    const r = ctx.run('codex', ['mcp', 'add', 'captain-memo', '--', ...ctx.mcpCommand]);
    if (r.status === 0) mcp = 'added';
    else if (looksAlreadyPresent(r)) mcp = 'present';
    else detail = errDetail(r, 'codex mcp add failed');
    const skill = copySkill(ctx.skillSource, join(ctx.home, '.codex', 'skills', 'captain-memo', 'SKILL.md'));
    return withDetail({ tool: 'codex', mcp, skill }, detail);
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
    return withDetail({ tool: 'gemini', mcp, skill }, detail);
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
      const already = !!existing && existing.includes(VIBE_MCP_MARKER);
      const merged = mergeVibeMcpConfig(existing, serverPath);
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, merged);
      mcp = already ? 'present' : 'added';
    } catch (e) {
      detail = (e as Error).message;
    }
    const skill = copySkill(ctx.skillSource, join(ctx.home, '.vibe', 'skills', 'captain-memo', 'SKILL.md'));
    return withDetail({ tool: 'vibe', mcp, skill }, detail);
  },
};

// VS Code (Copilot agent mode) — MCP is GA. Auto-wire by merging ~/.config/Code/User/mcp.json (top-level
// `servers`, stdio). Skill best-effort to the user prompts folder as a *.instructions.md (read path unverified).
const vscodeAdapter: ToolAdapter = {
  id: 'vscode',
  label: 'VS Code (Copilot)',
  detect({ home, run }) {
    return cliOnPath(run, 'code') || existsSync(join(home, '.config', 'Code')) || existsSync(join(home, '.vscode'));
  },
  connect(ctx) {
    const mcpJsonPath = join(ctx.home, '.config', 'Code', 'User', 'mcp.json');
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
    const skill = copySkill(ctx.skillSource, join(ctx.home, '.config', 'Code', 'User', 'prompts', 'captain-memo.instructions.md'));
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

export const ADAPTERS: ToolAdapter[] = [codexAdapter, geminiAdapter, agyAdapter, cursorAdapter, opencodeAdapter, vibeAdapter, vscodeAdapter, jetbrainsAdapter];

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
  const results: ConnectResult[] = [];
  for (const adapter of ADAPTERS) {
    if (adapter.detect({ home, run })) results.push(adapter.connect(ctx));
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
    const line = `${r.tool}: ${mcpLabel}, ${skillLabel}${r.detail ? ` — ${r.detail}` : ''}`;
    if (r.mcp === 'failed') warn(line);
    else if (r.mcp === 'skipped') info(line);
    else ok(line);
  }
}
