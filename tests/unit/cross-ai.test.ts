import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mergeCursorMcpConfig, mergeVibeMcpConfig, mergeKimiConfig, mergeKimiHooks, kimiHooksSupported, mergeClaudeDesktopConfig, mergeGooseConfig, mergeGeminiHooks, geminiHooksSupported, toBlockYaml, mergeCodexToolApprovals, mergeCodexHooks, codexHooksEnabled, CAPTAIN_MEMO_CODEX_HOOK_MARKER, CAPTAIN_MEMO_GEMINI_HOOK_MARKER, CAPTAIN_MEMO_KIMI_HOOK_BEGIN, CODEX_TOOL_NAMES, gooseConfigPath, gooseConfigCandidates, extractGooseEntry, gooseExtensionEntry, parseOllamaList, connectCrossAi, type Runner } from '../../src/cli/cross-ai.ts';

// Bun's native YAML, typed locally so this compiles against an @types/bun predating `Bun.YAML`.
const YAML = (globalThis as { Bun: { YAML: { parse(s: string): any; stringify(v: unknown): string } } }).Bun.YAML;

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

// ---- mergeClaudeDesktopConfig — the pure, disk-free merge --------------------
// Same mcpServers shape as cursor's, but the command is a caller-supplied absolute
// path rather than a hardcoded 'bun' — Claude Desktop launches configured servers
// with a minimal PATH, so a bare 'bun' would resolve in a terminal and fail silently
// inside the app.

test('mergeClaudeDesktopConfig: writes an absolute command into an empty config', () => {
  const out = mergeClaudeDesktopConfig(null, 'C:\\Users\\u\\.bun\\bin\\bun.exe', 'C:\\repo\\mcp-server.js');
  const parsed = JSON.parse(out);

  expect(parsed.mcpServers['captain-memo'].command).toBe('C:\\Users\\u\\.bun\\bin\\bun.exe');
  expect(parsed.mcpServers['captain-memo'].args).toEqual(['C:\\repo\\mcp-server.js']);
});

test('mergeClaudeDesktopConfig: preserves foreign servers and foreign top-level keys', () => {
  const existing = JSON.stringify({
    globalShortcut: 'Alt+Space',
    mcpServers: { filesystem: { command: 'node', args: ['/srv/fs.js'] } },
  });
  const parsed = JSON.parse(mergeClaudeDesktopConfig(existing, '/usr/bin/bun', '/repo/mcp-server.js'));

  expect(parsed.globalShortcut).toBe('Alt+Space');
  expect(parsed.mcpServers.filesystem).toEqual({ command: 'node', args: ['/srv/fs.js'] });
  expect(parsed.mcpServers['captain-memo'].command).toBe('/usr/bin/bun');
});

test('mergeClaudeDesktopConfig: re-merging is byte-stable', () => {
  const once = mergeClaudeDesktopConfig(null, '/usr/bin/bun', '/repo/mcp-server.js');
  const twice = mergeClaudeDesktopConfig(once, '/usr/bin/bun', '/repo/mcp-server.js');

  expect(twice).toBe(once);
});

test('mergeClaudeDesktopConfig: re-points a moved server path', () => {
  const once = mergeClaudeDesktopConfig(null, '/usr/bin/bun', '/old/mcp-server.js');
  const parsed = JSON.parse(mergeClaudeDesktopConfig(once, '/usr/bin/bun', '/new/mcp-server.js'));
  expect(parsed.mcpServers['captain-memo'].args).toEqual(['/new/mcp-server.js']);
});

// ---- mergeCodexToolApprovals — codex approves MCP tools ONE AT A TIME ---------

test('CODEX_TOOL_NAMES — stays identical to the MCP server\'s own TOOLS list', async () => {
  // Anti-drift guard. The names are duplicated in cross-ai.ts so the CLI does not import the MCP
  // SDK just to read them; this test is what makes that duplication safe. Add a tool to the server
  // without pre-approving it and codex silently cannot call it from `codex exec`.
  const { TOOLS } = await import('../../src/mcp-server.ts');
  expect([...CODEX_TOOL_NAMES] as string[]).toEqual(TOOLS.map((t: { name: string }) => t.name));
});

test('mergeCodexToolApprovals — writes one approval block per tool', () => {
  const out = mergeCodexToolApprovals('', ['search_all', 'status']);
  expect(out).toContain('[mcp_servers.captain-memo.tools.search_all]');
  expect(out).toContain('[mcp_servers.captain-memo.tools.status]');
  expect(out.match(/approval_mode = "approve"/g)).toHaveLength(2);
});

test('mergeCodexToolApprovals — idempotent, and never rewrites what is already there', () => {
  // config.toml is hand-edited and holds the user's model, profiles and other servers. We append
  // only; a second run must be a byte-for-byte no-op.
  const existing = [
    'model = "gpt-5.6-sol"',
    '',
    '[mcp_servers.other-server]',
    'command = "node"',
    '',
    '[mcp_servers.captain-memo.tools.status]',
    'approval_mode = "approve"',
    '',
  ].join('\n');
  const once = mergeCodexToolApprovals(existing, ['status', 'search_all']);
  const twice = mergeCodexToolApprovals(once, ['status', 'search_all']);
  expect(twice).toBe(once);
  // The pre-existing entry was not duplicated, and the foreign server survived untouched.
  expect(once.match(/\[mcp_servers\.captain-memo\.tools\.status\]/g)).toHaveLength(1);
  expect(once).toContain('[mcp_servers.other-server]');
  expect(once).toContain('model = "gpt-5.6-sol"');
});

test('codexHooksEnabled — follows the effective feature value and fails closed', () => {
  expect(codexHooksEnabled({ status: 0, stdout: 'hooks stable true\nplugins stable true\n' })).toBe(true);
  expect(codexHooksEnabled({ status: 0, stdout: 'hooks stable false\n' })).toBe(false);
  expect(codexHooksEnabled({ status: 1, stdout: 'hooks stable true\n' })).toBe(false);
});

test('mergeCodexHooks — preserves foreign hooks and replaces managed entries idempotently', () => {
  const existing = JSON.stringify({
    custom: { keep: true },
    hooks: {
      PostToolUse: [{ matcher: 'foreign', hooks: [
        { type: 'command', command: 'foreign-tool' },
        { type: 'command', command: `old-bundle CodexPostToolUse # ${CAPTAIN_MEMO_CODEX_HOOK_MARKER}` },
      ] }],
    },
  });
  const once = mergeCodexHooks(existing, '/opt/bun', '/new/captain-memo-hook.js');
  const twice = mergeCodexHooks(once, '/opt/bun', '/new/captain-memo-hook.js');
  const parsed = JSON.parse(once);
  expect(twice).toBe(once);
  expect(parsed.custom).toEqual({ keep: true });
  expect(JSON.stringify(parsed)).toContain('foreign-tool');
  expect(JSON.stringify(parsed).match(new RegExp(CAPTAIN_MEMO_CODEX_HOOK_MARKER, 'g'))).toHaveLength(3);
  expect(parsed.hooks.PostToolUse.at(-1).hooks[0].async).toBeUndefined();
  expect(JSON.stringify(parsed)).not.toContain('old-bundle');
});

test('connectCrossAi — Codex installs native hooks only when the effective feature is on', () => {
  const run: Runner = (cmd, args) => {
    if (cmd === 'codex' && args[0] === 'mcp') return { status: 0, stdout: '' };
    if (cmd === 'codex' && args[0] === 'features') return { status: 0, stdout: 'hooks stable true\n' };
    return { status: 1, stdout: '' };
  };
  const [result] = connectCrossAi({
    only: ['codex'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run,
  });
  expect(result?.capture).toBe('native-hooks');
  const hooksPath = join(home, '.codex', 'hooks.json');
  expect(existsSync(hooksPath)).toBe(true);
  const hooks = JSON.parse(readFileSync(hooksPath, 'utf-8'));
  expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command).toContain('CodexUserPromptSubmit');
  expect(hooks.hooks.PostToolUse[0].hooks[0].command).toContain('captain-memo-hook.js');
});

test('connectCrossAi — old or hooks-disabled Codex stays on rollout fallback', () => {
  const run: Runner = (cmd, args) => {
    if (cmd === 'codex' && args[0] === 'mcp') return { status: 0, stdout: '' };
    if (cmd === 'codex' && args[0] === 'features') return { status: 0, stdout: 'hooks stable false\n' };
    return { status: 1, stdout: '' };
  };
  const [result] = connectCrossAi({
    only: ['codex'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run,
  });
  expect(result?.capture).toBe('rollout-fallback');
  expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false);
});

test('Gemini hooks — capability probe and merge preserve foreign settings', () => {
  expect(geminiHooksSupported({ status: 0, stdout: 'Manage Gemini CLI hooks.\n' })).toBe(true);
  expect(geminiHooksSupported({ status: 1, stdout: 'Manage Gemini CLI hooks.\n' })).toBe(false);
  const existing = JSON.stringify({ theme: 'dark', hooks: {
    AfterTool: [{ matcher: 'foreign', hooks: [{ type: 'command', command: 'foreign-hook' }] }],
  } });
  const once = mergeGeminiHooks(existing, 'bun', '/repo/hook.js');
  const twice = mergeGeminiHooks(once, 'bun', '/repo/hook.js');
  const parsed = JSON.parse(once);
  expect(twice).toBe(once);
  expect(parsed.theme).toBe('dark');
  expect(parsed.tools.enableHooks).toBe(true);
  expect(parsed.hooks.enabled).toBe(true);
  expect(JSON.stringify(parsed)).toContain('foreign-hook');
  expect(JSON.stringify(parsed).match(new RegExp(CAPTAIN_MEMO_GEMINI_HOOK_MARKER, 'g'))).toHaveLength(3);
});

test('connectCrossAi — Gemini installs supported hooks and keeps transcript fallback for old CLIs', () => {
  let hookProbeTimeout = 0;
  const supported: Runner = (cmd, args, timeoutMs) => {
    if (cmd === 'gemini' && args[0] === 'mcp') return { status: 0, stdout: '' };
    if (cmd === 'gemini' && args[0] === 'hooks') {
      hookProbeTimeout = timeoutMs ?? 0;
      return { status: 0, stdout: 'Manage Gemini CLI hooks.\n' };
    }
    return { status: 1, stdout: '' };
  };
  const [native] = connectCrossAi({ only: ['gemini'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: supported });
  expect(native?.capture).toBe('native-hooks');
  expect(hookProbeTimeout).toBe(60_000);
  expect(readFileSync(join(home, '.gemini', 'settings.json'), 'utf-8')).toContain('GeminiAfterTool');

  const oldHome = mkdtempSync(join(tmpdir(), 'captain-memo-gemini-old-'));
  const unsupported: Runner = (cmd, args) => cmd === 'gemini' && args[0] === 'mcp'
    ? { status: 0, stdout: '' }
    : { status: 1, stdout: '' };
  const [fallback] = connectCrossAi({ only: ['gemini'], mcpCommand: ['bun', MCP_PATH], skillSource, home: oldHome, run: unsupported });
  expect(fallback?.capture).toBe('rollout-fallback');
  expect(existsSync(join(oldHome, '.gemini', 'settings.json'))).toBe(false);
  rmSync(oldHome, { recursive: true, force: true });
});

test('Kimi hooks — version gate and managed TOML block are idempotent', () => {
  expect(kimiHooksSupported({ status: 0, stdout: 'kimi-cli 1.28.0' })).toBe(true);
  expect(kimiHooksSupported({ status: 0, stdout: 'kimi-cli 1.27.9' })).toBe(false);
  const once = mergeKimiHooks('theme = "dark"\n', 'bun', '/repo/hook.js');
  const twice = mergeKimiHooks(once, 'bun', '/repo/hook.js');
  expect(twice).toBe(once);
  expect(once).toContain('theme = "dark"');
  expect(once).toContain(CAPTAIN_MEMO_KIMI_HOOK_BEGIN);
  expect(once.match(/\[\[hooks\]\]/g)).toHaveLength(3);
  expect(once).toContain('KimiPostToolUse');
});

test('connectCrossAi — Kimi 1.28+ installs hooks alongside its managed Ollama config', () => {
  const run: Runner = (cmd, args) => {
    if (cmd === 'ollama') return { status: 0, stdout: 'NAME ID SIZE MODIFIED\nqwen3:8b abc 5GB now\n' };
    if (cmd === 'kimi' && args[0] === 'mcp') return { status: 0, stdout: '' };
    if (cmd === 'kimi' && args[0] === '--version') return { status: 0, stdout: 'kimi-cli 1.48.0\n' };
    return { status: 1, stdout: '' };
  };
  const [result] = connectCrossAi({ only: ['kimi'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run });
  expect(result?.capture).toBe('native-hooks');
  const config = readFileSync(join(home, '.kimi', 'config.toml'), 'utf-8');
  expect(config).toContain('[providers.ollama]');
  expect(config).toContain('KimiPostToolUse');
});

// ---- mergeGooseConfig — same pure, disk-free merge, over goose's config.yaml -

test('mergeGooseConfig — null/empty config gets a fresh extensions map with our entry', () => {
  const out = YAML.parse(mergeGooseConfig(null, MCP_PATH));
  expect(out.extensions['captain-memo']).toEqual(gooseExtensionEntry(MCP_PATH));
  expect(Object.keys(out.extensions)).toEqual(['captain-memo']);
});

test('mergeGooseConfig — empty-string config behaves like null', () => {
  const out = YAML.parse(mergeGooseConfig('', MCP_PATH));
  expect(out.extensions['captain-memo'].args).toEqual([MCP_PATH]);
});

test('mergeGooseConfig — preserves other extensions AND goose top-level provider keys', () => {
  // A realistic goose config: provider settings live at the top level beside `extensions`.
  const existing = YAML.stringify({
    GOOSE_PROVIDER: 'anthropic',
    GOOSE_MODEL: 'claude-sonnet-5',
    extensions: {
      developer: { name: 'developer', type: 'builtin', enabled: true, timeout: 300 },
    },
  });
  const out = YAML.parse(mergeGooseConfig(existing, MCP_PATH));
  expect(out.extensions['captain-memo'].cmd).toBe('bun');
  // Foreign extension untouched — a clobber here would silently disable the user's tools.
  expect(out.extensions.developer).toEqual({ name: 'developer', type: 'builtin', enabled: true, timeout: 300 });
  // Provider keys untouched — a clobber here would log the user out of their model.
  expect(out.GOOSE_PROVIDER).toBe('anthropic');
  expect(out.GOOSE_MODEL).toBe('claude-sonnet-5');
});

test('mergeGooseConfig — idempotent: re-merge produces no duplicate and stable content', () => {
  const first = mergeGooseConfig(null, MCP_PATH);
  const second = mergeGooseConfig(first, MCP_PATH);
  expect(YAML.parse(second)).toEqual(YAML.parse(first));
});

test('mergeGooseConfig — refreshes the path if it changed (re-point to new mcp-server.js)', () => {
  const first = mergeGooseConfig(null, '/old/path/mcp-server.js');
  const out = YAML.parse(mergeGooseConfig(first, MCP_PATH));
  expect(out.extensions['captain-memo'].args).toEqual([MCP_PATH]);
});

test('mergeGooseConfig — emits BLOCK style, never Bun.YAML flow style', () => {
  // Regression guard: Bun.YAML.stringify emits `{extensions: {captain-memo: {...}}}` on ONE line
  // and takes no options, which would flatten the user's whole hand-editable config.
  const out = mergeGooseConfig(YAML.stringify({ GOOSE_PROVIDER: 'anthropic' }), MCP_PATH);
  expect(out.startsWith('{')).toBe(false);
  expect(out).toContain('\nextensions:\n');
  expect(out).toContain('  captain-memo:\n');
  expect(out).toContain('    cmd: bun\n');
  // Still valid YAML with every key intact.
  const parsed = YAML.parse(out);
  expect(parsed.GOOSE_PROVIDER).toBe('anthropic');
  expect(parsed.extensions['captain-memo']).toEqual(gooseExtensionEntry(MCP_PATH));
});

test('toBlockYaml — quotes what would otherwise re-parse as structure (Windows paths, reserved words)', () => {
  const win = 'C:\\Users\\k\\.bun\\bin\\mcp-server.js';
  // Bare, the drive colon would parse as a nested key and silently corrupt the file.
  const out = mergeGooseConfig(null, win);
  expect(YAML.parse(out).extensions['captain-memo'].args).toEqual([win]);

  const tricky = toBlockYaml({ a: 'no', b: 'plain', c: '12', d: 'has: colon', e: '', f: null, g: [], h: {} });
  const back = YAML.parse(tricky);
  expect(back).toEqual({ a: 'no', b: 'plain', c: '12', d: 'has: colon', e: '', f: null, g: [], h: {} });
});

test('toBlockYaml — a STRING that looks numeric survives as a string, in every YAML numeric form', () => {
  // Regression: an earlier version gated bare output on a hand-written number regex that missed
  // exponents, so the string "1e5" was emitted bare and re-parsed as the NUMBER 100000. YAML 1.1
  // types far more than decimals, so the gate is now a round-trip check, not a pattern list.
  const strings = {
    dec: '12', frac: '0.5', neg: '-3', exp: '1e5', expNeg: '1E-5', padded: '007',
    hex: '0x1F', oct: '0o17', underscored: '1_000', sexagesimal: '1:30', inf: '.inf', nan: '.nan',
    yes: 'yes', no: 'no', t: 'true', nul: 'null', y: 'y', off: 'off',
  };
  expect(YAML.parse(toBlockYaml(strings))).toEqual(strings);

  // ...while REAL numbers and booleans still round-trip as numbers and booleans, not strings.
  const scalars = { n: 12, f: 0.5, neg: -3, t: true, f2: false, nul: null };
  expect(YAML.parse(toBlockYaml(scalars))).toEqual(scalars);
});

test('toBlockYaml — nesting survives: deep maps, arrays of objects, unicode and multiline', () => {
  const shape = {
    GOOSE_PROVIDER: 'anthropic',
    deep: { a: { b: { c: 'bottom' } } },
    items: [{ n: 1 }, { n: 2 }],
    text: { multiline: 'line1\nline2', cyrillic: 'Привет', cjk: '日本語', quoted: 'say "hi"' },
    empties: { str: '', arr: [], obj: {} },
  };
  expect(YAML.parse(toBlockYaml(shape))).toEqual(shape);
});

test('extractGooseEntry — round-trips our entry, and is null when absent or unparseable', () => {
  const merged = mergeGooseConfig(null, MCP_PATH);
  expect(extractGooseEntry(merged)).toBe(JSON.stringify(gooseExtensionEntry(MCP_PATH)));
  expect(extractGooseEntry(YAML.stringify({ GOOSE_PROVIDER: 'anthropic' }))).toBeNull();
  expect(extractGooseEntry('\t: : not: valid: yaml: [')).toBeNull();
});

test('gooseConfigCandidates — one layout per OS, matching goose\'s etcetera app strategy', () => {
  // Platform-independent on purpose: the candidate LIST is the same everywhere, only which one
  // gets picked varies. Asserting the list keeps this test honest on a Windows or macOS runner.
  const prevXdg = process.env.XDG_CONFIG_HOME, prevAppdata = process.env.APPDATA;
  try {
    delete process.env.XDG_CONFIG_HOME;
    process.env.APPDATA = 'C:\\Users\\x\\AppData\\Roaming';
    // Every expectation goes through join() too: on Windows the separator is a backslash, and
    // hardcoding '/' here made these fail on the windows-latest runner while the code was fine.
    const [win, mac, xdg] = gooseConfigCandidates('/home/x');
    expect(win).toBe(join('C:\\Users\\x\\AppData\\Roaming', 'Block', 'goose', 'config', 'config.yaml'));
    expect(mac).toBe(join('/home/x', 'Library', 'Application Support', 'Block.block.goose', 'config.yaml'));
    expect(xdg).toBe(join('/home/x', '.config', 'goose', 'config.yaml'));

    process.env.XDG_CONFIG_HOME = '/custom/cfg';
    expect(gooseConfigCandidates('/home/x')[2]).toBe(join('/custom/cfg', 'goose', 'config.yaml'));
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevAppdata === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppdata;
  }
});

test('gooseConfigPath — GOOSE_PATH_ROOT wins when absolute, is ignored when relative', () => {
  const prev = process.env.GOOSE_PATH_ROOT;
  try {
    process.env.GOOSE_PATH_ROOT = '/opt/goose-root';
    // join() again, not a literal — a leading slash IS absolute on Windows, so this branch is
    // taken there too, but the separators come back as backslashes.
    expect(gooseConfigPath('/home/x')).toBe(join('/opt/goose-root', 'config', 'config.yaml'));
    // goose's validated_path_root DROPS a relative value rather than resolving it, so we must too.
    process.env.GOOSE_PATH_ROOT = 'relative/root';
    expect(gooseConfigPath('/home/x')).not.toContain('relative/root');
    expect(gooseConfigCandidates('/home/x')).toContain(gooseConfigPath('/home/x'));
  } finally {
    if (prev === undefined) delete process.env.GOOSE_PATH_ROOT; else process.env.GOOSE_PATH_ROOT = prev;
  }
});

test('gooseConfigPath — prefers a candidate that already exists over the platform default', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'goose-path-'));
  try {
    // Simulate a machine where goose already wrote an XDG config: it must be found even if this
    // test runs on a Windows or macOS runner, where the platform default would be a different slot.
    const xdg = join(tmp, '.config', 'goose');
    mkdirSync(xdg, { recursive: true });
    writeFileSync(join(xdg, 'config.yaml'), 'extensions: {}\n');
    const prev = process.env.XDG_CONFIG_HOME;
    try {
      delete process.env.XDG_CONFIG_HOME;
      expect(gooseConfigPath(tmp)).toBe(join(xdg, 'config.yaml'));
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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
// ---- claude-desktop adapter — claude_desktop_config.json via a FAKE Roaming dir ----
// claudeDesktopConfigDir() reads process.env.APPDATA / LOCALAPPDATA directly — not the
// injected `home` — because that's how the real config is found on a real machine. So
// these tests point APPDATA/LOCALAPPDATA at a fake dir under the temp `home` and always
// restore the originals afterwards, so a test run here can never read or write whatever
// Claude Desktop config already exists on the machine running the suite.
describe('connectCrossAi — claude-desktop adapter', () => {
  let savedAppData: string | undefined;
  let savedLocalAppData: string | undefined;
  let savedXdgConfigHome: string | undefined;
  let fakeClaudeDir: string;

  beforeEach(() => {
    savedAppData = process.env.APPDATA;
    savedLocalAppData = process.env.LOCALAPPDATA;
    savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
    fakeClaudeDir = join(home, 'FakeRoaming', 'Claude');
    mkdirSync(fakeClaudeDir, { recursive: true });
    process.env.APPDATA = join(home, 'FakeRoaming');
    process.env.LOCALAPPDATA = join(home, 'FakeLocal');
    // No XDG override by default — whatever the host machine has set (if anything) must never
    // leak into these tests, since the Linux candidate would otherwise resolve outside the
    // temp `home` and could touch a real ~/.config/Claude on the machine running the suite.
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    if (savedAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = savedAppData;
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocalAppData;
    if (savedXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
  });

  test('only:[claude-desktop] writes an absolute process.execPath command; skill is skipped (tools only)', () => {
    const results = connectCrossAi({ only: ['claude-desktop'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
    expect(results.length).toBe(1);
    const r = results[0]!;
    expect(r.tool).toBe('claude-desktop');
    expect(r.mcp).toBe('added');
    expect(r.skill).toBe('skipped');   // SKILL.md deliberately not copied — no confirmed read path

    const cfg = JSON.parse(readFileSync(join(fakeClaudeDir, 'claude_desktop_config.json'), 'utf-8'));
    expect(cfg.mcpServers['captain-memo'].command).toBe(process.execPath);
    expect(cfg.mcpServers['captain-memo'].args).toEqual([MCP_PATH]);
  });

  test('is idempotent and preserves a pre-existing foreign server + top-level key', () => {
    writeFileSync(
      join(fakeClaudeDir, 'claude_desktop_config.json'),
      JSON.stringify({ globalShortcut: 'Alt+Space', mcpServers: { filesystem: { command: 'node', args: ['/x.js'] } } }),
    );
    connectCrossAi({ only: ['claude-desktop'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
    const second = connectCrossAi({ only: ['claude-desktop'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
    expect(second[0]!.mcp).toBe('present');

    const cfg = JSON.parse(readFileSync(join(fakeClaudeDir, 'claude_desktop_config.json'), 'utf-8'));
    expect(cfg.globalShortcut).toBe('Alt+Space');
    expect(cfg.mcpServers.filesystem).toEqual({ command: 'node', args: ['/x.js'] });
    expect(cfg.mcpServers['captain-memo'].command).toBe(process.execPath);
    expect(Object.keys(cfg.mcpServers).filter((k) => k === 'captain-memo').length).toBe(1);
  });

  test('is absent from auto-detect when no Claude config directory exists', () => {
    rmSync(fakeClaudeDir, { recursive: true, force: true });
    const results = connectCrossAi({ mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
    expect(results.map((r) => r.tool)).not.toContain('claude-desktop');
  });

  // Linux candidate (UNVERIFIED, convention-derived — see the doc comment on
  // claudeDesktopConfigDir): $XDG_CONFIG_HOME/Claude, checked after both Windows candidates.
  // Neither Windows dir exists in this temp home, so a successful write here proves the probe
  // actually falls through to the Linux entry rather than stopping short of it.
  test('probes the Linux path ($XDG_CONFIG_HOME/Claude) when neither Windows dir exists', () => {
    rmSync(fakeClaudeDir, { recursive: true, force: true });   // remove the Roaming candidate
    // LOCALAPPDATA points at FakeLocal (from beforeEach), but FakeLocal/Claude was never created.
    const fakeXdgClaudeDir = join(home, 'FakeXdgConfig', 'Claude');
    mkdirSync(fakeXdgClaudeDir, { recursive: true });
    process.env.XDG_CONFIG_HOME = join(home, 'FakeXdgConfig');

    const results = connectCrossAi({ only: ['claude-desktop'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
    expect(results[0]!.mcp).toBe('added');

    const cfg = JSON.parse(readFileSync(join(fakeXdgClaudeDir, 'claude_desktop_config.json'), 'utf-8'));
    expect(cfg.mcpServers['captain-memo'].command).toBe(process.execPath);
    expect(cfg.mcpServers['captain-memo'].args).toEqual([MCP_PATH]);
  });
});


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

// ---- probe must not be able to hang the installer ------------------------------------
// Reported from a real upgrade: the installer printed "Wiring other AI tools (shared
// memory)" and then sat silent long enough that the operator killed it. Nothing was being
// indexed — wiring is the LAST step, and the worker indexes asynchronously inside its own
// service — but the step spawns `which <cli>` once per supported tool, and `which` walks
// every PATH entry. One network mount or stale automount in PATH and the probe blocks with
// no ceiling and no output.

test('the CLI probe is bounded — a spawn that never returns cannot stall the install', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/cli/cross-ai.ts'), 'utf-8');
  const runner = src.slice(src.indexOf('const defaultRunner'), src.indexOf('export interface ConnectCtx'));
  expect(runner).toMatch(/timeout:/);              // spawnSync is given a ceiling
  expect(runner).toMatch(/WIRE_TIMEOUT_MS/);       // named, not a magic number
  expect(src).toMatch(/const PROBE_TIMEOUT_MS/);
  // TWO ceilings, deliberately. Detection is `which` (19ms for eight probes here); wiring
  // runs the tool's own CLI and `gemini mcp add` measured 5,031ms. A single 5s ceiling would
  // have killed that at the boundary and broken Gemini wiring intermittently.
  const probeCeiling = /const PROBE_TIMEOUT_MS = ([0-9_]+)/.exec(src)?.[1]?.replace(/_/g, '');
  const wireCeiling = /const WIRE_TIMEOUT_MS = ([0-9_]+)/.exec(src)?.[1]?.replace(/_/g, '');
  expect(Number(wireCeiling)).toBeGreaterThan(Number(probeCeiling));
  // detection uses the SHORT ceiling, and probes with the PLATFORM's own PATH tool — Windows
  // ships no `which`, so a hardcoded one made every adapter's probe error there.
  expect(src).toMatch(/run\(isWindows \? 'where' : 'which', \[id\], PROBE_TIMEOUT_MS\)/);
});

test('a probe that times out reports the tool absent instead of throwing', () => {
  // spawnSync returns status null on timeout. Detection must read that as "not installed"
  // and carry on — a slow PATH entry must not fail the whole wiring step.
  const timedOut: Runner = () => ({ status: null as unknown as number, stdout: '', stderr: '', error: new Error('ETIMEDOUT') });
  const home = mkdtempSync(join(tmpdir(), 'cm-probe-'));
  try {
    const results = connectCrossAi({ mcpCommand: ['bun', '/x/mcp.js'], skillSource: '/x/SKILL.md', home, run: timedOut });
    expect(Array.isArray(results)).toBe(true);     // returned, did not throw
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- vibe TOML merge ------------------------------------------------------------------
// OSS ships the vibe adapter and mergeVibeMcpConfig but had NO tests for either — the
// coverage lived only on the federation line. Ported back: a test that exists on one of
// two mirrored lines protects neither.
test('mergeVibeMcpConfig — null config gets a [[mcp_servers]] captain-memo (stdio) block', () => {
  const out = mergeVibeMcpConfig(null, MCP_PATH);
  expect(out).toContain('[[mcp_servers]]');
  expect(out).toContain('name = "captain-memo"');
  expect(out).toContain('transport = "stdio"');
  expect(out).toContain('args = ["' + MCP_PATH + '"]');
});


test('mergeVibeMcpConfig — appends to existing TOML, preserving it; idempotent on the managed marker', () => {
  const existing = '[[mcp_servers]]\nname = "other"\ntransport = "stdio"\ncommand = "node"\nargs = ["/y.js"]\n';
  const once = mergeVibeMcpConfig(existing, MCP_PATH);
  expect(once).toContain('name = "other"');            // foreign block untouched
  expect(once).toContain('name = "captain-memo"');     // ours appended
  const twice = mergeVibeMcpConfig(once, MCP_PATH);
  expect(twice).toBe(once);                            // idempotent — no duplicate captain-memo block
  expect(twice.match(/name = "captain-memo"/g)!.length).toBe(1);
});

test('connectCrossAi — only:[vibe] writes ~/.vibe/config.toml + copies the skill (added; idempotent → present)', () => {
  const first = connectCrossAi({ only: ['vibe'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
  expect(first[0]!.tool).toBe('vibe');
  expect(first[0]!.mcp).toBe('added');
  expect(first[0]!.skill).toBe('installed');
  const cfg = readFileSync(join(home, '.vibe', 'config.toml'), 'utf-8');
  expect(cfg).toContain('name = "captain-memo"');
  expect(existsSync(join(home, '.vibe', 'skills', 'captain-memo', 'SKILL.md'))).toBe(true);
  const second = connectCrossAi({ only: ['vibe'], mcpCommand: ['bun', MCP_PATH], skillSource, home, run: noopRunner });
  expect(second[0]!.mcp).toBe('present');   // re-run reports present, no dupe
});

// ---- mergeKimiConfig / parseOllamaList — `connect kimi` must leave the captain LAUNCHABLE -------------
// Without [providers.*] + [models.<alias>] + a root default_model in ~/.kimi/config.toml, bare `kimi` (the
// adapter's verified launch form) has nothing to route to and ai-capacity reports logged_in:false ⇒
// cosession_spawn(cli:'kimi') is refused with cli_unavailable. `connect kimi` used to write NONE of it.
