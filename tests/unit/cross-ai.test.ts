import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mergeCursorMcpConfig, connectCrossAi, type Runner } from '../../src/cli/cross-ai.ts';

const MCP_PATH = '/repo/plugin/dist/mcp-server.js';

// A runner that fails `which` for everything (so codex/gemini never look
// installed) and never spawns a real process. The cursor adapter doesn't shell
// out at all, so for cursor-only tests this never even runs — but injecting it
// guarantees no test ever shells out to a real codex/gemini on the host PATH.
const noopRunner: Runner = () => ({ status: 1, stdout: '', stderr: '' });

// ---- mergeCursorMcpConfig — the pure, disk-free merge -----------------------

test('mergeCursorMcpConfig — null/empty config gets a fresh mcpServers with our entry', () => {
  const out = JSON.parse(mergeCursorMcpConfig(null, MCP_PATH));
  expect(out.mcpServers['captain-memo']).toEqual({ command: 'bun', args: [MCP_PATH] });
  // It's the only server.
  expect(Object.keys(out.mcpServers)).toEqual(['captain-memo']);
});

test('mergeCursorMcpConfig — empty-string config behaves like null', () => {
  const out = JSON.parse(mergeCursorMcpConfig('', MCP_PATH));
  expect(out.mcpServers['captain-memo']).toEqual({ command: 'bun', args: [MCP_PATH] });
});

test('mergeCursorMcpConfig — merges into existing config, preserving other servers + top-level keys', () => {
  const existing = JSON.stringify({
    schema: 1,
    mcpServers: {
      'some-other': { command: 'node', args: ['/x/y.js'] },
    },
    foo: { bar: 'baz' },
  });
  const out = JSON.parse(mergeCursorMcpConfig(existing, MCP_PATH));
  // Our entry added.
  expect(out.mcpServers['captain-memo']).toEqual({ command: 'bun', args: [MCP_PATH] });
  // Foreign server untouched.
  expect(out.mcpServers['some-other']).toEqual({ command: 'node', args: ['/x/y.js'] });
  // Top-level keys untouched.
  expect(out.schema).toBe(1);
  expect(out.foo).toEqual({ bar: 'baz' });
});

test('mergeCursorMcpConfig — idempotent: re-merge produces no duplicate and stable content', () => {
  const first = mergeCursorMcpConfig(null, MCP_PATH);
  const second = mergeCursorMcpConfig(first, MCP_PATH);
  expect(JSON.parse(second)).toEqual(JSON.parse(first));
  const out = JSON.parse(second);
  expect(Object.keys(out.mcpServers).filter((k) => k === 'captain-memo').length).toBe(1);
});

test('mergeCursorMcpConfig — refreshes the path if it changed (re-point to new mcp-server.js)', () => {
  const first = mergeCursorMcpConfig(null, '/old/path/mcp-server.js');
  const out = JSON.parse(mergeCursorMcpConfig(first, MCP_PATH));
  expect(out.mcpServers['captain-memo'].args).toEqual([MCP_PATH]);
});

// ---- connectCrossAi — cursor adapter against an injected temp home ----------
// Cursor needs no CLI (detect = <home>/.cursor exists; connect = mcp.json merge +
// skill copy), so we can wire it end-to-end against a temp home with no spawns.
// We inject `home` directly into connectCrossAi rather than mutate process.env.HOME
// — Bun's os.homedir() reads the OS user database and ignores a runtime HOME
// mutation, so the env approach would leak into the developer's real ~/.cursor.

let home: string;
let skillSource: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'captain-memo-crossai-'));
  // Make cursor "detected".
  mkdirSync(join(home, '.cursor'), { recursive: true });
  // A real skill source to copy.
  const srcDir = mkdtempSync(join(tmpdir(), 'captain-memo-skillsrc-'));
  skillSource = join(srcDir, 'SKILL.md');
  writeFileSync(skillSource, '# skill body\n');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test('connectCrossAi — only:[cursor] wires mcp.json + copies the skill', () => {
  const results = connectCrossAi({
    only: ['cursor'],
    mcpCommand: ['bun', MCP_PATH],
    skillSource,
    home,
    run: noopRunner,
  });
  expect(results.length).toBe(1);
  const r = results[0]!;
  expect(r.tool).toBe('cursor');
  expect(r.mcp).toBe('added');
  expect(r.skill).toBe('installed');

  // mcp.json written + correct.
  const cfg = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf-8'));
  expect(cfg.mcpServers['captain-memo']).toEqual({ command: 'bun', args: [MCP_PATH] });

  // Skill copied to the documented rules location.
  const ruleFile = join(home, '.cursor', 'rules', 'captain-memo.md');
  expect(existsSync(ruleFile)).toBe(true);
  expect(readFileSync(ruleFile, 'utf-8')).toBe('# skill body\n');
});

test('connectCrossAi — cursor is idempotent (re-run reports present, no dupe)', () => {
  connectCrossAi({ only: ['cursor'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
  const second = connectCrossAi({ only: ['cursor'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
  const r = second[0]!;
  // Already present → reported as 'present', not 'added'.
  expect(r.mcp).toBe('present');
  const cfg = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf-8'));
  expect(Object.keys(cfg.mcpServers).filter((k) => k === 'captain-memo').length).toBe(1);
});

test('connectCrossAi — only:[cursor] preserves a pre-existing foreign server in mcp.json', () => {
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(
    join(home, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { foreign: { command: 'x', args: [] } } }),
  );
  connectCrossAi({ only: ['cursor'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
  const cfg = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf-8'));
  expect(cfg.mcpServers.foreign).toEqual({ command: 'x', args: [] });
  expect(cfg.mcpServers['captain-memo']).toEqual({ command: 'bun', args: [MCP_PATH] });
});

// Antigravity CLI (agy) — successor to Gemini CLI. Wires agy's OWN MCP config
// (~/.gemini/config/mcp_config.json, top-level mcpServers) via file-merge (no `agy mcp add`).
test('connectCrossAi — only:[agy] wires ~/.gemini/config/mcp_config.json + copies the skill', () => {
  const results = connectCrossAi({ only: ['agy'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
  expect(results.length).toBe(1);
  const r = results[0]!;
  expect(r.tool).toBe('agy');
  expect(r.mcp).toBe('added');
  expect(r.skill).toBe('installed');
  // agy's OWN MCP config (~/.gemini/config/mcp_config.json), top-level mcpServers, stdio {command,args}.
  const cfg = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf-8'));
  expect(cfg.mcpServers['captain-memo']).toEqual({ command: 'bun', args: [MCP_PATH] });
  expect(existsSync(join(home, '.gemini', 'skills', 'captain-memo', 'SKILL.md'))).toBe(true);
});

test('connectCrossAi — agy is idempotent + preserves a foreign server in mcp_config.json', () => {
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  writeFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { foreign: { command: 'x', args: [] } } }));
  connectCrossAi({ only: ['agy'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
  const second = connectCrossAi({ only: ['agy'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
  expect(second[0]!.mcp).toBe('present');
  const cfg = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf-8'));
  expect(cfg.mcpServers.foreign).toEqual({ command: 'x', args: [] });
  expect(cfg.mcpServers['captain-memo']).toEqual({ command: 'bun', args: [MCP_PATH] });
  expect(Object.keys(cfg.mcpServers).filter((k) => k === 'captain-memo').length).toBe(1);
});

test('connectCrossAi — skill-copy failure still counts the MCP as wired (best-effort skill)', () => {
  const results = connectCrossAi({
    only: ['cursor'],
    mcpCommand: ['bun', MCP_PATH],
    skillSource: '/does/not/exist/SKILL.md',  // copy will fail
    home,
    run: noopRunner,
  });
  const r = results[0]!;
  expect(r.mcp).toBe('added');     // MCP is the must-have — still wired
  expect(r.skill).toBe('failed');  // skill copy failed but didn't abort
});

test('connectCrossAi — undetected tool (no CLI / no config dir) is skipped from auto-detect', () => {
  // Auto-detect (no `only`): cursor IS detected (we made ~/.cursor in the temp
  // home); codex/gemini are only detected if their CLI is on PATH OR their config
  // dir exists. With an injected home (no ~/.codex, ~/.gemini) and a runner whose
  // `which` always fails, neither is detected — so only cursor is wired, exactly
  // once, with no crash and no dupes.
  const results = connectCrossAi({ mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
  const tools = results.map((r) => r.tool);
  expect(tools).toContain('cursor');
  expect(tools.filter((t) => t === 'cursor').length).toBe(1);
  // codex/gemini are NOT detected (no CLI via noopRunner, no config dir in temp home).
  expect(tools).not.toContain('codex');
  expect(tools).not.toContain('gemini');
});
