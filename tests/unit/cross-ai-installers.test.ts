// connect installers for the MCP-speaking tools that share the one local corpus: opencode (OpenRouter gateway +
// local Ollama/vLLM/LM Studio), Mistral Vibe, VS Code (Copilot), JetBrains (AI Assistant). Each registers the
// captain-memo MCP server in that tool's config so it recalls the shared memory — the OSS "one worker, many
// tools" feature. (Running these as driven co-sessions is a separate, non-OSS layer.)
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  mergeOpencodeConfig, mergeVscodeMcpConfig, mergeVibeMcpConfig,
  connectCrossAi, OPENCODE_AUTO_AGENT, type Runner,
} from '../../src/cli/cross-ai.ts';

const MCP_PATH = '/repo/plugin/dist/mcp-server.js';
const noopRunner: Runner = () => ({ status: 1, stdout: '', stderr: '' });

// ---- pure merges ----

test('mergeOpencodeConfig — mcp + openrouter (key by {env:} reference, never literal) + ollama + the auto agent', () => {
  const serialized = mergeOpencodeConfig(null, { mcpCommand: ['bun', MCP_PATH] });
  expect(serialized).toContain('{env:OPENROUTER_API_KEY}');
  expect(serialized).not.toMatch(/sk-or-/);
  const out = JSON.parse(serialized);
  expect(out.mcp['captain-memo']).toEqual({ type: 'local', command: ['bun', MCP_PATH], enabled: true });
  expect(out.provider.openrouter.options.apiKey).toBe('{env:OPENROUTER_API_KEY}');
  expect(out.provider.ollama.options.baseURL).toBe('http://localhost:11434/v1');
  expect(out.agent[OPENCODE_AUTO_AGENT].permission.edit).toBe('allow');
});

test('mergeOpencodeConfig — localProvider:vllm writes a vllm provider (:8000) and not ollama', () => {
  const out = JSON.parse(mergeOpencodeConfig(null, { mcpCommand: ['bun', MCP_PATH], localProvider: 'vllm' }));
  expect(out.provider.vllm.options.baseURL).toBe('http://localhost:8000/v1');
  expect(out.provider.ollama).toBeUndefined();
});

test('mergeVscodeMcpConfig — top-level servers (stdio), preserves foreign keys, idempotent', () => {
  const out = JSON.parse(mergeVscodeMcpConfig('{"inputs":[1],"servers":{"x":{}}}', MCP_PATH));
  expect(out.servers['captain-memo']).toEqual({ type: 'stdio', command: 'bun', args: [MCP_PATH] });
  expect(out.servers.x).toEqual({});
  expect(out.inputs).toEqual([1]);
  expect(JSON.parse(mergeVscodeMcpConfig(JSON.stringify(out), MCP_PATH))).toEqual(out);
});

test('mergeVibeMcpConfig — appends a [[mcp_servers]] block; idempotent on the marker', () => {
  const once = mergeVibeMcpConfig(null, MCP_PATH);
  expect(once).toContain('[[mcp_servers]]');
  expect(once).toContain('name = "captain-memo"');
  expect(mergeVibeMcpConfig(once, MCP_PATH)).toBe(once);
});

// ---- connect smoke tests (temp home, no spawns) ----

let home: string;
let skillSource: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'captain-memo-inst-'));
  const srcDir = mkdtempSync(join(tmpdir(), 'captain-memo-skillsrc-'));
  skillSource = join(srcDir, 'SKILL.md');
  writeFileSync(skillSource, '# skill\n');
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

test('connect only:[opencode] writes opencode.json (added; idempotent → present); never a literal key', () => {
  const first = connectCrossAi({ only: ['opencode'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
  expect(first[0]!.mcp).toBe('added');
  const raw = readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf-8');
  expect(raw).toContain('{env:OPENROUTER_API_KEY}');
  expect(raw).not.toMatch(/sk-or-/);
  const second = connectCrossAi({ only: ['opencode'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
  expect(second[0]!.mcp).toBe('present');
});

test('connect only:[vscode] auto-writes ~/.config/Code/User/mcp.json (servers.captain-memo)', () => {
  const r = connectCrossAi({ only: ['vscode'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner })[0]!;
  expect(r.mcp).toBe('added');
  const cfg = JSON.parse(readFileSync(join(home, '.config', 'Code', 'User', 'mcp.json'), 'utf-8'));
  expect(cfg.servers['captain-memo']).toEqual({ type: 'stdio', command: 'bun', args: [MCP_PATH] });
});

test('connect only:[jetbrains] is assisted-manual: skipped + an AI Assistant instruction + a paste-ready snippet', () => {
  const r = connectCrossAi({ only: ['jetbrains'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner })[0]!;
  expect(r.mcp).toBe('skipped');
  expect(r.detail).toMatch(/AI Assistant/i);
  const snip = JSON.parse(readFileSync(join(home, '.config', 'JetBrains', 'captain-memo-mcp.json'), 'utf-8'));
  expect(snip.mcpServers['captain-memo']).toEqual({ command: 'bun', args: [MCP_PATH] });
});

test('connect only:[vibe] appends ~/.vibe/config.toml + copies the skill', () => {
  const r = connectCrossAi({ only: ['vibe'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner })[0]!;
  expect(r.mcp).toBe('added');
  expect(readFileSync(join(home, '.vibe', 'config.toml'), 'utf-8')).toContain('name = "captain-memo"');
  expect(existsSync(join(home, '.vibe', 'skills', 'captain-memo', 'SKILL.md'))).toBe(true);
});
