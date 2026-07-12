import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mergeCursorMcpConfig, mergeKimiConfig, parseOllamaList, connectCrossAi, type Runner } from '../../src/cli/cross-ai.ts';

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

// ---- mergeKimiConfig / parseOllamaList — `connect kimi` must leave kimi LAUNCHABLE -------------
// Without [providers.*] + [models.<alias>] + a root default_model in ~/.kimi/config.toml, bare `kimi` has
// nothing to route to and dies with "LLM not set". `connect kimi` used to write NONE of it.

test('parseOllamaList — takes the NAME column, skips the header, ignores blanks', () => {
  const out = parseOllamaList('NAME              ID          SIZE\nqwen3.5:9b        abc         5 GB\ngemma4:12b        def         8 GB\n\n');
  expect(out).toEqual(['qwen3.5:9b', 'gemma4:12b']);
  expect(parseOllamaList('')).toEqual([]);
});

test('mergeKimiConfig — writes the loopback provider + one [models.<alias>] per model + a root default_model', () => {
  const out = mergeKimiConfig(null, { models: ['qwen3.5:9b', 'gemma4:12b'] });
  expect(out.startsWith('default_model = "qwen3.5:9b"')).toBe(true);   // ROOT key ⇒ must precede every table
  expect(out).toContain('[providers.ollama]');
  expect(out).toContain('type = "openai_legacy"');
  expect(out).toContain('base_url = "http://127.0.0.1:11434/v1"');     // loopback ⇒ no api key, no /login
  expect(out).toContain('[models."qwen3.5:9b"]');                      // the `-m <alias>` key
  expect(out).toContain('[models."gemma4:12b"]');
});

test('mergeKimiConfig — regenerates the managed block, preserves foreign tables + a user-chosen default', () => {
  const existing = 'default_model = "mine"\n\n[providers.moonshot]\ntype = "openai"\napi_key = "sk-x"\n\n[models.mine]\nprovider = "moonshot"\nmodel = "kimi-k2"\n';
  const once = mergeKimiConfig(existing, { models: ['qwen3.5:9b'] });
  expect(once).toContain('[providers.moonshot]');                      // foreign table untouched
  expect(once.match(/default_model/g)!.length).toBe(1);                // their default is never overridden
  expect(once).toContain('default_model = "mine"');
  const twice = mergeKimiConfig(once, { models: ['qwen3.5:9b', 'gemma4:12b'] });   // a newly pulled model
  expect(twice.match(/\[providers\.ollama\]/g)!.length).toBe(1);       // block REPLACED, not appended twice
  expect(twice).toContain('[models."gemma4:12b"]');
  expect(mergeKimiConfig(twice, { models: ['qwen3.5:9b', 'gemma4:12b'] })).toBe(twice);   // idempotent
});

test('mergeKimiConfig — a default left dangling by an `ollama rm` is REWRITTEN, never left unresolvable', () => {
  const once = mergeKimiConfig(null, { models: ['qwen3:8b', 'llama3.2:latest'] });
  expect(once).toContain('default_model = "qwen3:8b"');
  const gone = mergeKimiConfig(once, { models: ['llama3.2:latest'] });   // user ran `ollama rm qwen3:8b`
  expect(gone.match(/default_model/g)!.length).toBe(1);
  expect(gone).toContain('default_model = "llama3.2:latest"');           // resolves to a real [models.*] alias
  expect(gone).not.toContain('[models."qwen3:8b"]');
  expect(gone.startsWith('default_model')).toBe(true);                   // ROOT key still precedes every table
});

test('mergeKimiConfig — an embedding model is never the default (it cannot chat)', () => {
  const out = mergeKimiConfig(null, { models: ['nomic-embed-text:latest', 'qwen3:8b'] });
  expect(out.startsWith('default_model = "qwen3:8b"')).toBe(true);
  expect(out).toContain('[models."nomic-embed-text:latest"]');           // still reachable via `-m`
  // embedder-only box: no chat model ⇒ no default at all, rather than one that cannot chat
  expect(mergeKimiConfig(null, { models: ['nomic-embed-text:latest'] })).not.toContain('default_model');
});

test('connectCrossAi — only:[kimi] with only an embedder writes no default and says why', () => {
  const run: Runner = (cmd, args) => (cmd === 'ollama' && args[0] === 'list'
    ? { status: 0, stdout: 'NAME                     ID    SIZE\nnomic-embed-text:latest  abc   274 MB\n', stderr: '' }
    : { status: 1, stdout: '', stderr: 'no such command' });
  const r = connectCrossAi({ only: ['kimi'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run });
  expect(r[0]!.detail).toContain('looks like an embedder');
  expect(readFileSync(join(home, '.kimi', 'config.toml'), 'utf-8')).not.toContain('default_model');
});

test('connectCrossAi — only:[kimi] writes ~/.kimi/config.toml from `ollama list`', () => {
  const run: Runner = (cmd, args) => (cmd === 'ollama' && args[0] === 'list'
    ? { status: 0, stdout: 'NAME        ID    SIZE\nqwen3.5:9b  abc   5 GB\n', stderr: '' }
    : { status: 1, stdout: '', stderr: 'no such command' });
  const r = connectCrossAi({ only: ['kimi'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run });
  expect(r[0]!.tool).toBe('kimi');
  const cfg = readFileSync(join(home, '.kimi', 'config.toml'), 'utf-8');
  expect(cfg).toContain('[providers.ollama]');
  expect(cfg).toContain('[models."qwen3.5:9b"]');
  expect(cfg).toContain('default_model = "qwen3.5:9b"');
});

test('connectCrossAi — only:[kimi] with NO local models writes NOTHING and says why (never a lying config)', () => {
  const r = connectCrossAi({ only: ['kimi'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
  expect(existsSync(join(home, '.kimi', 'config.toml'))).toBe(false);
  expect(r[0]!.detail).toContain('no local Ollama models found');
});
