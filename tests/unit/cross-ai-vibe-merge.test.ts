// `captain-memo connect vibe` must not append a second captain-memo block when Vibe has already saved the config.
// Vibe re-serialises ~/.vibe/config.toml and drops every comment, so the "# captain-memo (managed by ...)" marker is
// gone after Vibe's first save; the old marker-only check then appended a duplicate (found on a Windows machine,
// 2026-10-21). "Already there" is now decided by the [[mcp_servers]] TABLE named captain-memo.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, statSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mergeVibeMcpConfig, planVibeMcpConfig, vibeCaptainMemoTables, connectCrossAi, type Runner } from '../../src/cli/cross-ai.ts';

const MARKER = '# captain-memo (managed by `captain-memo connect`)';
const NIX_PATH = '/repo/plugin/dist/mcp-server.js';
// The decoded form of the TOML `"C:\\Users\\exampleuser\\captain-memo\\plugin\\dist\\mcp-server.js"` below.
const WIN_PATH = 'C:\\Users\\exampleuser\\captain-memo\\plugin\\dist\\mcp-server.js';
const noopRunner: Runner = () => ({ status: 1, stdout: '', stderr: '' });

// The real case, in Vibe's own formatting (tomli_w): no comment, multi-line `args` with a trailing comma, other
// tables around it, and a `name = "captain-memo"` in a [[models]] table that is not an MCP server.
const vibeFile = (eol = '\n') => [
  'active_model = "devstral-2"',
  '',
  '[[providers]]',
  'name = "mistral"',
  'api_base = "https://api.mistral.ai/v1"',
  '',
  '[[models]]',
  'name = "captain-memo"',
  'provider = "mistral"',
  '',
  '[[mcp_servers]]',
  'name = "other"',
  'transport = "stdio"',
  'command = "node"',
  'args = ["/opt/other/server.js"]',
  '',
  '[[mcp_servers]]',
  'name = "captain-memo"',
  'transport = "stdio"',
  'command = "bun"',
  'args = [',
  '    "C:\\\\Users\\\\exampleuser\\\\captain-memo\\\\plugin\\\\dist\\\\mcp-server.js",',
  ']',
  '',
  '[[mcp_servers]]',
  'name = "last"',
  'transport = "http"',
  'url = "https://mcp.example.test/mcp"',
  '',
].join(eol);

let home: string;
let srcDir: string;
let skillSource: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'captain-memo-vibe-'));
  srcDir = mkdtempSync(join(tmpdir(), 'captain-memo-vibesrc-'));
  skillSource = join(srcDir, 'SKILL.md');
  writeFileSync(skillSource, '# skill\n');
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(srcDir, { recursive: true, force: true }); });

const cfgPath = () => join(home, '.vibe', 'config.toml');
const writeCfg = (text: string) => { mkdirSync(join(home, '.vibe'), { recursive: true }); writeFileSync(cfgPath(), text); };
const connectVibe = (path: string) => connectCrossAi({ only: ['vibe'], mcpCommand: ['bun', path], skillSource, home, run: noopRunner })[0]!;
const count = (text: string, needle: string) => text.split(needle).length - 1;

// ---- pure: the real-case file ----

for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
  test(`${label}: a Vibe-formatted captain-memo table (no comment, multi-line args) with the same path is returned untouched`, () => {
    const fixture = vibeFile(eol);
    expect(vibeCaptainMemoTables(fixture)).toEqual([[WIN_PATH]]);   // the [[models]] "captain-memo" is not counted
    const plan = planVibeMcpConfig(fixture, WIN_PATH);
    expect(plan.text).toBe(fixture);
    expect(plan.added).toBe(false);
    expect(plan.note).toBeUndefined();
    expect(mergeVibeMcpConfig(fixture, WIN_PATH)).toBe(fixture);
  });
}

test('a different checkout path: the file is still returned untouched, and the note names both paths and says it was left', () => {
  const fixture = vibeFile();
  const plan = planVibeMcpConfig(fixture, NIX_PATH);
  expect(plan.text).toBe(fixture);
  expect(plan.added).toBe(false);
  expect(plan.note).toContain(WIN_PATH);
  expect(plan.note).toContain(NIX_PATH);
  expect(plan.note).toContain('left as it is');
});

test('the file from the report (Vibe\'s own table plus a marked block with another path): nothing more is appended, and the note counts the entries', () => {
  const damaged = vibeFile() + '\n' + MARKER + '\n[[mcp_servers]]\nname = "captain-memo"\ntransport = "stdio"\ncommand = "bun"\nargs = ["' + NIX_PATH + '"]\n';
  expect(vibeCaptainMemoTables(damaged)).toEqual([[WIN_PATH], [NIX_PATH]]);
  const plan = planVibeMcpConfig(damaged, NIX_PATH);
  expect(plan.text).toBe(damaged);
  expect(plan.note).toContain('2 [[mcp_servers]] entries are named captain-memo');
  expect(plan.note).not.toContain('left as it is');   // this install's path IS one of them
});

// ---- pure: behaviour that must not change ----

test('no config yet: the managed block, exactly as before', () => {
  const expected = MARKER + '\n[[mcp_servers]]\nname = "captain-memo"\ntransport = "stdio"\ncommand = "bun"\nargs = ["' + NIX_PATH + '"]\n';
  expect(mergeVibeMcpConfig(null, NIX_PATH)).toBe(expected);
  expect(mergeVibeMcpConfig('', NIX_PATH)).toBe(expected);
  expect(planVibeMcpConfig(null, NIX_PATH).added).toBe(true);
});

test('a file with only our marked block is unchanged (marker idempotency), whatever its path says', () => {
  const marked = mergeVibeMcpConfig(null, NIX_PATH);
  expect(planVibeMcpConfig(marked, NIX_PATH)).toEqual({ text: marked, added: false });
  expect(mergeVibeMcpConfig(marked, '/elsewhere/mcp-server.js')).toBe(marked);
  const markerOnly = MARKER + '\n';   // the block itself was renamed or removed by hand: still left alone, as before
  expect(mergeVibeMcpConfig(markerOnly, NIX_PATH)).toBe(markerOnly);
});

test('other servers only: the block is appended after them, every earlier byte kept, and a re-run changes nothing', () => {
  const others = 'active_model = "x"\n\n[[mcp_servers]]\nname = "other"\ntransport = "stdio"\ncommand = "node"\nargs = ["/y.js"]\n';
  const once = mergeVibeMcpConfig(others, NIX_PATH);
  expect(once.startsWith(others + '\n' + MARKER + '\n')).toBe(true);
  expect(count(once, 'name = "captain-memo"')).toBe(1);
  expect(mergeVibeMcpConfig(once, NIX_PATH)).toBe(once);
});

test('a captain-memo name in a table that is not an [[mcp_servers]] entry does not count', () => {
  const notMcp = [
    '[[models]]', 'name = "captain-memo"', '',
    '[providers.x]', 'name = "captain-memo"', '',
    '[[providers]]', 'name = "captain-memo"', '',
    '[[mcp_servers]]', 'name = "other"', 'args = ["/y.js"]', '',
    '[mcp_servers.env]', 'name = "captain-memo"', '',
    '[mcp_servers]', 'name = "captain-memo"', '',   // a plain table, not an array entry
  ].join('\n');
  expect(vibeCaptainMemoTables(notMcp)).toEqual([]);
  const out = mergeVibeMcpConfig(notMcp, NIX_PATH);
  expect(out.startsWith(notMcp)).toBe(true);
  expect(out).toContain(MARKER + '\n[[mcp_servers]]\nname = "captain-memo"');
});

// ---- pure: the reader copes with every layout Vibe or a person might leave ----

test('recognised layouts: quote style, key order, quoted keys, comments, a one-line or multi-line args, spaced header', () => {
  const layouts: [string, string[] | null][] = [
    ["[[mcp_servers]]\nname = 'captain-memo'\nargs = ['C:\\Users\\x\\mcp-server.js']\n", ['C:\\Users\\x\\mcp-server.js']],
    ['[[mcp_servers]]\nargs = ["/a.js"]\ntransport = "stdio"\nname = "captain-memo"\n', ['/a.js']],
    ['[[mcp_servers]]\n"name" = "captain-memo"\n"args" = ["/a.js"]\n', ['/a.js']],
    ['[[ mcp_servers ]]   # ours\nname = "captain-memo"   # the name\nargs = ["/a.js"]   # the path\n', ['/a.js']],
    ['[[mcp_servers]]\nname = "captain-memo"\nargs = [\n  # run the server\n  "run", # a comment with ] in it\n  \'/a.js\',\n]\n', ['run', '/a.js']],
    ['[[mcp_servers]]\r\nname = "captain-memo"\r\nargs = [\r\n  "/a.js",\r\n]\r\n', ['/a.js']],
    ['[[mcp_servers]]\nname = "captain-memo"\ncommand = "bun"\n', null],            // no args at all
    ['[[mcp_servers]]\nname = "captain-memo"\nargs = [1, 2]\n', null],               // not strings
  ];
  for (const [toml, args] of layouts) expect(vibeCaptainMemoTables(toml)).toEqual([args]);
});

test('look-alikes that are not ours: another name, another case, a commented-out block', () => {
  const lookAlikes = [
    '[[mcp_servers]]\nname = "captain-memo-2"\n',
    '[[mcp_servers]]\nname = "Captain-Memo"\n',
    '[[mcp_servers]]\nname = "other"\nnote = "name = \\"captain-memo\\""\n',
    '# [[mcp_servers]]\n# name = "captain-memo"\n',
  ];
  for (const toml of lookAlikes) expect(vibeCaptainMemoTables(toml)).toEqual([]);
});

test('header look-alikes inside a multi-line string or array are not headers', () => {
  const lookAlikes = [
    '[prompts]\ntext = """\n[[mcp_servers]]\nname = "captain-memo"\n"""\n',
    "[prompts]\ntext = '''\n[[mcp_servers]]\nname = \"captain-memo\"\n'''\n",
    '[tool]\nlist = [\n  "[[mcp_servers]]", # [[mcp_servers]]\n]\nname = "captain-memo"\n',   // the [tool] table's own key, after an array holding header look-alikes
  ];
  for (const toml of lookAlikes) expect(vibeCaptainMemoTables(toml)).toEqual([]);
});

// ---- connect, against a temp home ----

for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
  test(`connect vibe on the real-case file (${label}): reports present and the file is byte-identical`, () => {
    writeCfg(vibeFile(eol));
    const before = readFileSync(cfgPath());
    const r = connectVibe(WIN_PATH);
    expect(r.mcp).toBe('present');
    expect(r.detail).toBeUndefined();
    expect(Buffer.compare(readFileSync(cfgPath()), before)).toBe(0);
  });
}

test('connect vibe on a file that already holds our marked block does not rewrite it (mtime unchanged)', () => {
  writeCfg(mergeVibeMcpConfig(null, NIX_PATH));
  const old = new Date(Date.UTC(2020, 0, 1));
  utimesSync(cfgPath(), old, old);
  expect(connectVibe(NIX_PATH).mcp).toBe('present');
  expect(statSync(cfgPath()).mtimeMs).toBe(old.getTime());
});

test('connect vibe with a different checkout path: present, file byte-identical, the detail says what differs and that it was left', () => {
  writeCfg(vibeFile());
  const before = readFileSync(cfgPath());
  const r = connectVibe(NIX_PATH);
  expect(r.mcp).toBe('present');
  expect(r.detail).toContain(cfgPath());
  expect(r.detail).toContain(WIN_PATH);
  expect(r.detail).toContain(NIX_PATH);
  expect(r.detail).toContain('left as it is');
  expect(Buffer.compare(readFileSync(cfgPath()), before)).toBe(0);
});

test('connect vibe on a fresh home still adds the block (once), then reports present with the file unchanged', () => {
  const first = connectVibe(NIX_PATH);
  expect(first.mcp).toBe('added');
  expect(first.detail).toBeUndefined();
  const written = readFileSync(cfgPath(), 'utf-8');
  expect(written).toBe(mergeVibeMcpConfig(null, NIX_PATH));
  const second = connectVibe(NIX_PATH);
  expect(second.mcp).toBe('present');
  expect(readFileSync(cfgPath(), 'utf-8')).toBe(written);
});

test('connect vibe after Vibe re-saved the file our block went into (comment dropped): no second block', () => {
  connectVibe(NIX_PATH);
  // Vibe's re-save: same table, our marker comment gone, its own layout.
  writeCfg('[[mcp_servers]]\nname = "captain-memo"\ntransport = "stdio"\ncommand = "bun"\nargs = [\n    "' + NIX_PATH + '",\n]\n');
  const before = readFileSync(cfgPath());
  expect(connectVibe(NIX_PATH).mcp).toBe('present');
  expect(Buffer.compare(readFileSync(cfgPath()), before)).toBe(0);
  expect(count(readFileSync(cfgPath(), 'utf-8'), 'name = "captain-memo"')).toBe(1);
});
