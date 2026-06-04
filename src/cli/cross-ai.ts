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

export const ADAPTERS: ToolAdapter[] = [codexAdapter, geminiAdapter, cursorAdapter];

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
}): ConnectResult[] {
  const home = opts.home ?? homedir();
  const run = opts.run ?? defaultRunner;
  const ctx: ConnectCtx = { mcpCommand: opts.mcpCommand, skillSource: opts.skillSource, home, run };

  if (opts.only && opts.only.length > 0) {
    const results: ConnectResult[] = [];
    for (const id of opts.only) {
      const adapter = ADAPTERS.find((a) => a.id === id);
      if (!adapter) {
        results.push({ tool: id, mcp: 'skipped', skill: 'skipped', detail: 'unknown tool (expected: codex | gemini | cursor)' });
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
    info('No other AI tools detected (Codex, Gemini CLI, Cursor). Claude Code is wired by the plugin install.');
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
