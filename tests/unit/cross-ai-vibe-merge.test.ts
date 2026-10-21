// `captain-memo connect vibe` must not append a second captain-memo block when Vibe has already saved the config.
// Vibe re-serialises ~/.vibe/config.toml and drops every comment, so the "# captain-memo (managed by ...)" marker is
// gone after Vibe's first save; the old marker-only check then appended a duplicate (found on a Windows machine,
// 2026-10-21). "Already there" is now decided by the [[mcp_servers]] TABLE named captain-memo.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, statSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mergeVibeMcpConfig, planVibeMcpConfig, vibeCaptainMemoTables, planVibeToolPermissions, vibeToolPermissions, VIBE_ALWAYS_TOOLS, VIBE_ASK_TOOLS, connectCrossAi, type Runner } from '../../src/cli/cross-ai.ts';
import { TOOLS } from '../../src/mcp-server.ts';

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

// The permission block, spelled out here on purpose: this is the format `connect vibe` must append (Vibe's own key rule
// is `[tools.<server>_<tool>]`, server = the raw config name, hyphen kept). Only the explanatory comment line is read back
// from the code, so rewording it does not break every test; one test below pins what it must NOT contain.
const PERM_COMMENT = planVibeToolPermissions('[[mcp_servers]]\nname = "captain-memo"\n').text.split('\n').find((l) => l.startsWith('#'))!;
const stanza = (tool: string, perm = 'always', eol = '\n') => `[tools.captain-memo_${tool}]${eol}permission = "${perm}"${eol}`;
const permBlock = (tools: string[], eol = '\n') => PERM_COMMENT + eol + tools.map((t) => stanza(t, 'always', eol)).join(eol);
const allPerms = (eol = '\n') => permBlock(VIBE_ALWAYS_TOOLS, eol);

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

// ---- permissions: pure ----

const PERM_AFTER_MCP = [
  'active_model = "devstral-2"', '', '[[mcp_servers]]', 'name = "captain-memo"', 'transport = "stdio"', 'command = "bun"', 'args = ["' + NIX_PATH + '"]', '',
].join('\n');

test('tool-list guard: every tool the MCP server offers is in exactly one of ALWAYS / ASK, and neither list names a tool that does not exist', () => {
  const names = TOOLS.map((t) => t.name);
  const always = new Set(VIBE_ALWAYS_TOOLS);
  const ask = new Set(VIBE_ASK_TOOLS);
  expect(always.size).toBe(VIBE_ALWAYS_TOOLS.length);   // no duplicates inside a list
  expect(ask.size).toBe(VIBE_ASK_TOOLS.length);
  const both = names.filter((n) => always.has(n) && ask.has(n));
  const neither = names.filter((n) => !always.has(n) && !ask.has(n));
  const unknown = [...always, ...ask].filter((n) => !names.includes(n));
  expect({ both, neither, unknown }).toEqual({ both: [], neither: [], unknown: [] });
  expect(VIBE_ALWAYS_TOOLS.length + VIBE_ASK_TOOLS.length).toBe(names.length);
  expect([...ask]).toEqual(['reindex']);   // the one tool that rebuilds the index keeps asking
});

test('a file with the MCP table and no permissions: every ALWAYS tool is appended after every original byte, no ASK tool is', () => {
  const plan = planVibeToolPermissions(PERM_AFTER_MCP);
  expect(plan.text).toBe(PERM_AFTER_MCP + '\n' + allPerms());
  expect(plan.added).toEqual(VIBE_ALWAYS_TOOLS);
  for (const t of VIBE_ASK_TOOLS) expect(plan.text).not.toContain(`captain-memo_${t}]`);
  const parsed = Bun.TOML.parse(plan.text) as { tools: Record<string, { permission: string }> };   // and it is valid TOML, with Vibe's key spelling
  expect(Object.keys(parsed.tools).sort()).toEqual(VIBE_ALWAYS_TOOLS.map((t) => `captain-memo_${t}`).sort());
  expect(Object.values(parsed.tools).every((v) => v.permission === 'always')).toBe(true);
  expect(plan.text).not.toContain(MARKER);   // the permission comment must not read as the MCP marker
  expect(PERM_COMMENT).toMatch(/^# \S/);   // there is an explanatory comment line (its wording is free)
});

test('some tables present with ask or never (kept), some missing (added): nothing existing is edited, reordered or deleted', () => {
  const mine = '[tools.captain-memo_search_memory]\npermission = "ask"\n\n[tools.bash]\npermission = "ask"\n\n[tools.captain-memo_stats]\npermission = "never"\n\n[tools.captain-memo_status]\npermission = "always"\n';
  const base = PERM_AFTER_MCP + '\n' + mine;
  const plan = planVibeToolPermissions(base);
  const missing = VIBE_ALWAYS_TOOLS.filter((t) => !['search_memory', 'stats', 'status'].includes(t));
  expect(plan.text).toBe(base + '\n' + permBlock(missing));
  expect(plan.added).toEqual(missing);
  expect(plan.note).toContain(`${missing.length} captain-memo tools set to always`);
  expect(plan.note).toContain('existing permission for search_memory, stats left as it is');   // not status: it already says always
  const parsed = Bun.TOML.parse(plan.text) as { tools: Record<string, { permission: string }> };
  expect(parsed.tools['captain-memo_search_memory']!.permission).toBe('ask');
  expect(parsed.tools['captain-memo_stats']!.permission).toBe('never');
  expect(parsed.tools['bash']!.permission).toBe('ask');
});

test('the plan\'s sentence: how many were set, which still ask, which of the person\'s own were left; "already present" when nothing is added', () => {
  const first = planVibeToolPermissions(PERM_AFTER_MCP);
  expect(first.note).toBe(`${VIBE_ALWAYS_TOOLS.length} captain-memo tools set to always; reindex still asks`);
  const again = planVibeToolPermissions(first.text);
  expect(again.text).toBe(first.text);
  expect(again.added).toEqual([]);
  expect(again.note).toBe('captain-memo tool permissions already present; reindex still asks');
  // a tool the person already allowed (or denied) is no longer one that "still asks"; the file is not touched for it
  const owned = first.text + '\n' + stanza('reindex', 'never');
  const third = planVibeToolPermissions(owned);
  expect(third.text).toBe(owned);
  expect(third.note).toBe('captain-memo tool permissions already present');
});

test('CRLF file: the appended block uses CRLF throughout and the original bytes are kept', () => {
  const base = PERM_AFTER_MCP.replace(/\n/g, '\r\n');
  const plan = planVibeToolPermissions(base);
  expect(plan.text).toBe(base + '\r\n' + allPerms('\r\n'));
  expect(plan.text.slice(base.length).replace(/\r\n/g, '')).not.toContain('\n');   // no bare LF in what was appended
  expect(planVibeToolPermissions(plan.text).text).toBe(plan.text);
});

test('a file that does not end in a newline gets a blank line before the block; an LF file with no CR stays LF', () => {
  const noNl = PERM_AFTER_MCP.trimEnd();
  expect(planVibeToolPermissions(noNl).text).toBe(noNl + '\n\n' + allPerms());
});

test('look-alikes do not count: a table inside a multi-line string, a comment, another table kind, a longer tool name, a sibling server', () => {
  const lookAlikes = [
    '[prompts]\ntext = """\n[tools.captain-memo_search_memory]\npermission = "never"\n"""\n',
    "[prompts]\ntext = '''\n[tools.captain-memo_search_memory]\n'''\n",
    '# [tools.captain-memo_search_memory]\n# permission = "never"\n',
    '[providers.captain-memo_search_memory]\npermission = "never"\n',
    '[[models]]\nname = "tools.captain-memo_search_memory"\n',
    '[tools.captain-memo_search_memory_extra]\npermission = "never"\n',
    '[tools.captain_memo_search_memory]\npermission = "never"\n',   // a different server spelling is a different server
    '[tools.other-server_search_memory]\npermission = "never"\n',
    '[other.tools.captain-memo_search_memory]\npermission = "never"\n',
  ];
  for (const extra of lookAlikes) {
    const base = PERM_AFTER_MCP + '\n' + extra;
    expect(vibeToolPermissions(base).tools.has('search_memory')).toBe(false);
    const plan = planVibeToolPermissions(base);
    expect(plan.added).toContain('search_memory');
    expect(plan.text.startsWith(base)).toBe(true);
  }
});

test('every form that already defines a tool counts as present (appending a second table would be invalid TOML): quoted or spaced headers, sub-table, array of tables, dotted or inline key', () => {
  const taken = [
    '[tools."captain-memo_search_memory"]\npermission = "ask"\n',
    "[ tools . 'captain-memo_search_memory' ]\npermission = \"ask\"\n",
    '[tools.captain-memo_search_memory.extra]\nk = 1\n',
    '[[tools.captain-memo_search_memory]]\npermission = "ask"\n',
    '[tools]\ncaptain-memo_search_memory.permission = "ask"\n',
    '[tools]\ncaptain-memo_search_memory = { permission = "ask" }\n',
    '[tools]\n"captain-memo_search_memory" = { permission = "ask" }\n',
  ];
  for (const extra of taken) {
    const base = PERM_AFTER_MCP + '\n' + extra;
    expect([extra, vibeToolPermissions(base).tools.has('search_memory')]).toEqual([extra, true]);
    const plan = planVibeToolPermissions(base);
    expect(plan.added).not.toContain('search_memory');
    expect(plan.text.startsWith(base)).toBe(true);
    expect(count(plan.text, 'captain-memo_search_memory')).toBe(count(base, 'captain-memo_search_memory'));
  }
  // a dotted key BEFORE the first header is a root key (after one it would belong to that table, so it is not ours)
  const rootDotted = 'tools.captain-memo_search_memory.permission = "ask"\n\n' + PERM_AFTER_MCP;
  expect(vibeToolPermissions(rootDotted).tools.get('search_memory')).toBe('ask');
  expect(planVibeToolPermissions(rootDotted).added).not.toContain('search_memory');
  expect(vibeToolPermissions(PERM_AFTER_MCP + '\ntools.captain-memo_search_memory.permission = "ask"\n').tools.has('search_memory')).toBe(false);   // inside [[mcp_servers]]
  expect(vibeToolPermissions(PERM_AFTER_MCP + '\n[tools."captain-memo_search_memory"]\npermission = "ask"\n').tools.get('search_memory')).toBe('ask');
  expect(vibeToolPermissions(PERM_AFTER_MCP + '\n[tools]\ncaptain-memo_search_memory = { permission = "ask" }\n').tools.get('search_memory')).toBeNull();   // present, value not readable
});

test('`tools` set as a plain root value: nothing can be appended, nothing is written, and the sentence says so', () => {
  for (const base of ['tools = {}\n' + PERM_AFTER_MCP, PERM_AFTER_MCP.replace('active_model', 'tools = { bash = { permission = "ask" } }\nactive_model')]) {
    const plan = planVibeToolPermissions(base);
    expect(plan.text).toBe(base);
    expect(plan.added).toEqual([]);
    expect(plan.note).toContain('none written');
  }
});

test('MCP entry absent: no permissions, the text comes back as it is', () => {
  for (const base of ['', 'active_model = "x"\n', '[[models]]\nname = "captain-memo"\n', '[[mcp_servers]]\nname = "other"\nargs = ["/y.js"]\n', MARKER + '\n']) {
    const plan = planVibeToolPermissions(base);
    expect(plan.text).toBe(base);
    expect(plan.added).toEqual([]);
    expect(plan.note).toContain('no tool permissions written');
  }
});

// ---- permissions: connect, against a temp home ----

test('connect vibe on a fresh home: the MCP block then every ALWAYS stanza, in ONE write, with the sentence in the detail', () => {
  const r = connectVibe(NIX_PATH);
  expect(r.mcp).toBe('added');
  expect(readFileSync(cfgPath(), 'utf-8')).toBe(mergeVibeMcpConfig(null, NIX_PATH) + '\n' + allPerms());
  expect(r.detail).toBe(`${cfgPath()}: ${VIBE_ALWAYS_TOOLS.length} captain-memo tools set to always; reindex still asks`);
});

test('connect vibe when Vibe saved the file after login (comments gone, MCP table kept, no permissions): permissions appended, every earlier byte kept, a re-run changes nothing', () => {
  writeCfg(vibeFile());
  const before = readFileSync(cfgPath(), 'utf-8');
  const r = connectVibe(WIN_PATH);
  expect(r.mcp).toBe('present');
  const after = readFileSync(cfgPath(), 'utf-8');
  expect(after).toBe(before + '\n' + allPerms());
  expect(r.detail).toContain(`${VIBE_ALWAYS_TOOLS.length} captain-memo tools set to always`);
  const old = new Date(Date.UTC(2020, 0, 1));
  utimesSync(cfgPath(), old, old);
  const again = connectVibe(WIN_PATH);
  expect(again.mcp).toBe('present');
  expect(again.detail).toContain('captain-memo tool permissions already present');
  expect(Buffer.compare(readFileSync(cfgPath()), Buffer.from(after))).toBe(0);
  expect(statSync(cfgPath()).mtimeMs).toBe(old.getTime());   // no write at all
});

test('connect vibe on a CRLF file: the permissions follow the file\'s line ends', () => {
  writeCfg(vibeFile('\r\n'));
  const before = readFileSync(cfgPath(), 'utf-8');
  expect(connectVibe(WIN_PATH).mcp).toBe('present');
  expect(readFileSync(cfgPath(), 'utf-8')).toBe(before + '\r\n' + allPerms('\r\n'));
});

test('connect vibe keeps a person\'s own ask, adds only the missing, and names what it left', () => {
  const own = vibeFile() + '\n' + stanza('remember', 'ask') + '\n' + stanza('todo_add', 'never');
  writeCfg(own);
  const r = connectVibe(WIN_PATH);
  const after = readFileSync(cfgPath(), 'utf-8');
  expect(after).toBe(own + '\n' + permBlock(VIBE_ALWAYS_TOOLS.filter((t) => t !== 'remember' && t !== 'todo_add')));
  expect(r.detail).toContain(`${VIBE_ALWAYS_TOOLS.length - 2} captain-memo tools set to always`);
  expect(r.detail).toContain('existing permission for remember, todo_add left as it is');
});

test('connect vibe after Vibe re-saved the file our blocks went into (every comment dropped): nothing is added a second time, byte for byte', () => {
  connectVibe(NIX_PATH);
  const resaved = readFileSync(cfgPath(), 'utf-8').split('\n').filter((l) => !l.startsWith('#')).join('\n');
  writeCfg(resaved);
  expect(connectVibe(NIX_PATH).mcp).toBe('present');
  const after = readFileSync(cfgPath(), 'utf-8');
  expect(after).toBe(resaved);
  expect(count(after, 'name = "captain-memo"')).toBe(1);
  expect(count(after, '[tools.captain-memo_search_memory]')).toBe(1);
});

test('connect vibe on a file with our permission stanzas but no MCP table (entry removed by hand): the MCP block is added again, not mistaken for already there', () => {
  writeCfg(allPerms());   // the explanatory comment above the stanzas must not read as the MCP marker
  const r = connectVibe(NIX_PATH);
  expect(r.mcp).toBe('added');
  const after = readFileSync(cfgPath(), 'utf-8');
  expect(vibeCaptainMemoTables(after)).toEqual([[NIX_PATH]]);
  expect(count(after, '[tools.captain-memo_search_memory]')).toBe(1);
});

test('connect vibe when the MCP entry cannot be added (config.toml unreadable): no permissions, no write, reported failed', () => {
  mkdirSync(cfgPath(), { recursive: true });   // config.toml is a directory: reading it throws
  const r = connectVibe(NIX_PATH);
  expect(r.mcp).toBe('failed');
  expect(statSync(cfgPath()).isDirectory()).toBe(true);
});

// ---- connect, against a temp home (MCP entry; the permission block rides along) ----

for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
  test(`connect vibe on the real-case file (${label}): reports present, the MCP table is untouched, the file only grows by the permission block`, () => {
    writeCfg(vibeFile(eol));
    const before = readFileSync(cfgPath(), 'utf-8');
    const r = connectVibe(WIN_PATH);
    expect(r.mcp).toBe('present');
    expect(r.detail).not.toContain('left as it is');   // no note about the MCP entry: same path
    const after = readFileSync(cfgPath(), 'utf-8');
    expect(after.startsWith(before)).toBe(true);
    expect(count(after, 'name = "captain-memo"')).toBe(2);   // the [[models]] one and the MCP table: no second MCP block
    expect(count(after, '[[mcp_servers]]')).toBe(3);
  });
}

test('connect vibe on a file that already holds our marked block and every stanza does not rewrite it (mtime unchanged)', () => {
  writeCfg(mergeVibeMcpConfig(null, NIX_PATH) + '\n' + allPerms());
  const old = new Date(Date.UTC(2020, 0, 1));
  utimesSync(cfgPath(), old, old);
  expect(connectVibe(NIX_PATH).mcp).toBe('present');
  expect(statSync(cfgPath()).mtimeMs).toBe(old.getTime());
});

test('connect vibe with a different checkout path: present, the MCP table untouched, the detail says what differs and that it was left', () => {
  writeCfg(vibeFile() + '\n' + allPerms());
  const before = readFileSync(cfgPath());
  const r = connectVibe(NIX_PATH);
  expect(r.mcp).toBe('present');
  expect(r.detail).toContain(cfgPath());
  expect(r.detail).toContain(WIN_PATH);
  expect(r.detail).toContain(NIX_PATH);
  expect(r.detail).toContain('left as it is');
  expect(Buffer.compare(readFileSync(cfgPath()), before)).toBe(0);
});

test('connect vibe on a fresh home adds the MCP block once, then reports present with the file unchanged', () => {
  const first = connectVibe(NIX_PATH);
  expect(first.mcp).toBe('added');
  const written = readFileSync(cfgPath(), 'utf-8');
  expect(written.startsWith(mergeVibeMcpConfig(null, NIX_PATH))).toBe(true);
  const second = connectVibe(NIX_PATH);
  expect(second.mcp).toBe('present');
  expect(readFileSync(cfgPath(), 'utf-8')).toBe(written);
});
