import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { CODEX_TOOL_NAMES, mergeCodexToolApprovals, codexApprovalState, codexHomeDir, codexConfigPath, refreshCodexToolApprovals } from '../../src/cli/cross-ai.ts';
import { codexApprovalsVerdict, codexApprovalsCheck } from '../../src/cli/commands/doctor.ts';

// refreshCodexToolApprovals WRITES a user's ~/.codex/config.toml (or $CODEX_HOME/config.toml), so every test here runs
// against its own mkdtemp home that is passed in explicitly, with an explicit env — never homedir(), never the real
// ~/.codex and never the developer's real CODEX_HOME (tests/preload.ts also unsets it).

const homes: string[] = [];
function tmpHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'cm-codex-approvals-'));
  homes.push(h);
  return h;
}
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

const MISSING = ['todo_claim', 'todo_unclaim', 'work_active', 'work_clear'] as const;   // 4 of CODEX_TOOL_NAMES, in its order

/** The config of a captain that ran `connect codex` before a release added tools: the server registered, the user's own
 *  settings and a foreign server around it, approval blocks for every tool except `without`. Ends in exactly one "\n",
 *  the way codex writes it. */
function staleConfig(without: readonly string[] = MISSING, server = true): string {
  const approvals = CODEX_TOOL_NAMES.filter((t) => !without.includes(t))
    .map((t) => `[mcp_servers.captain-memo.tools.${t}]\napproval_mode = "approve"\n`).join('\n');
  return [
    'model = "gpt-5.6-sol"',
    '',
    '[projects."/home/u/work"]',
    'trust_level = "trusted"',
    '',
    ...(server ? ['[mcp_servers.captain-memo]', 'command = "bun"', 'args = ["/opt/captain-memo/src/mcp-server.ts"]', ''] : []),
    '[mcp_servers.other-server]',
    'command = "node"',
    '',
    approvals,
  ].join('\n');
}

function writeConfig(home: string, toml: string, env: Record<string, string> = {}): string {
  const p = codexConfigPath(home, env);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, toml);
  return p;
}

const block = (tool: string) => `\n[mcp_servers.captain-memo.tools.${tool}]\napproval_mode = "approve"\n`;

// ---- codexApprovalState ------------------------------------------------------

test('codexApprovalState — registered, and names exactly the tools with no block', () => {
  const s = codexApprovalState(staleConfig());
  expect(s.registered).toBe(true);
  expect(s.missing).toEqual([...MISSING]);          // in CODEX_TOOL_NAMES order
  expect(codexApprovalState(mergeCodexToolApprovals(staleConfig())).missing).toEqual([]);
});

test('codexApprovalState — approval blocks WITHOUT the server table are not a registration', () => {
  // Every approval header also starts `[mcp_servers.captain-memo`, so a prefix match would call the leftovers of a
  // removed server "registered" and the refresh would re-create approvals for a server the user took out.
  expect(codexApprovalState(staleConfig(MISSING, false))).toEqual({ registered: false, missing: [] });
  expect(codexApprovalState(null)).toEqual({ registered: false, missing: [] });
  expect(codexApprovalState('')).toEqual({ registered: false, missing: [] });
});

test('codexApprovalState — the server header is found with CRLF line endings, an indent or a trailing comment', () => {
  expect(codexApprovalState('[mcp_servers.captain-memo]\r\ncommand = "bun"\r\n').registered).toBe(true);
  expect(codexApprovalState('  [mcp_servers.captain-memo]   # added by connect\ncommand = "bun"\n').registered).toBe(true);
  expect(codexApprovalState('# [mcp_servers.captain-memo]\n').registered).toBe(false);          // commented out
  expect(codexApprovalState('[mcp_servers.captain-memo-staging]\n').registered).toBe(false);    // a different server
});

// ---- refreshCodexToolApprovals -----------------------------------------------

test(`refresh — a config with ${CODEX_TOOL_NAMES.length - MISSING.length} of ${CODEX_TOOL_NAMES.length} approvals gets exactly the missing ${MISSING.length} appended and nothing else changes`, () => {
  const home = tmpHome();
  const before = staleConfig();
  const cfg = writeConfig(home, before);
  if (process.platform !== 'win32') chmodSync(cfg, 0o600);          // codex writes it 0600
  const lines: string[] = [];

  const added = refreshCodexToolApprovals(home, {}, (l) => lines.push(l));

  expect(added).toEqual([...MISSING]);
  const after = readFileSync(cfg, 'utf-8');
  expect(after.slice(0, before.length)).toBe(before);               // every byte that was there is still there
  expect(after.slice(before.length)).toBe(MISSING.map(block).join(''));   // and the tail is those 4 blocks, nothing more
  expect(after).toBe(mergeCodexToolApprovals(before));              // same result `connect codex` would have written
  expect(codexApprovalState(after).missing).toEqual([]);
  if (process.platform !== 'win32') expect(statSync(cfg).mode & 0o777).toBe(0o600);   // mode kept
  expect(lines).toHaveLength(1);                                    // one line, and it says what was added and how to stop it
  expect(lines[0]).toContain('appended 4 missing');
  for (const t of MISSING) expect(lines[0]).toContain(t);
  expect(lines[0]).toContain('CAPTAIN_MEMO_CODEX_APPROVALS=0');
});

test('refresh — a config that has no captain-memo server is left byte-identical', () => {
  const home = tmpHome();
  const before = 'model = "gpt-5.6-sol"\n\n[mcp_servers.other-server]\ncommand = "node"\n';
  const cfg = writeConfig(home, before);
  const lines: string[] = [];
  expect(refreshCodexToolApprovals(home, {}, (l) => lines.push(l))).toEqual([]);
  expect(readFileSync(cfg, 'utf-8')).toBe(before);
  expect(lines).toEqual([]);
});

test('refresh — approval blocks left behind by a removed server do not bring the server back or add blocks', () => {
  const home = tmpHome();
  const before = staleConfig(MISSING, false);
  const cfg = writeConfig(home, before);
  expect(refreshCodexToolApprovals(home, {})).toEqual([]);
  expect(readFileSync(cfg, 'utf-8')).toBe(before);
});

test('refresh — a missing config.toml is not created, nor is the .codex directory', () => {
  const home = tmpHome();
  expect(refreshCodexToolApprovals(home, {})).toEqual([]);
  expect(existsSync(join(home, '.codex'))).toBe(false);
  mkdirSync(join(home, '.codex'));                                  // codex dir without a config
  expect(refreshCodexToolApprovals(home, {})).toEqual([]);
  expect(existsSync(codexConfigPath(home, {}))).toBe(false);
});

test('refresh — running it twice changes nothing the second time', () => {
  const home = tmpHome();
  const cfg = writeConfig(home, staleConfig());
  const lines: string[] = [];
  expect(refreshCodexToolApprovals(home, {}, (l) => lines.push(l))).toHaveLength(4);
  const once = readFileSync(cfg, 'utf-8');
  expect(refreshCodexToolApprovals(home, {}, (l) => lines.push(l))).toEqual([]);
  expect(readFileSync(cfg, 'utf-8')).toBe(once);
  expect(lines).toHaveLength(1);                                    // the second pass logged nothing
});

test('refresh — CAPTAIN_MEMO_CODEX_APPROVALS=0 leaves the file alone; any other value, or none, refreshes', () => {
  const home = tmpHome();
  const before = staleConfig();
  const cfg = writeConfig(home, before);
  expect(refreshCodexToolApprovals(home, { CAPTAIN_MEMO_CODEX_APPROVALS: '0' })).toEqual([]);
  expect(readFileSync(cfg, 'utf-8')).toBe(before);
  expect(refreshCodexToolApprovals(home, { CAPTAIN_MEMO_CODEX_APPROVALS: '1' })).toHaveLength(4);   // default is ON
});

test('refresh — a block that is already there is left alone whatever its approval_mode', () => {
  const home = tmpHome();
  const before = staleConfig(MISSING).replace(
    '[mcp_servers.captain-memo.tools.status]\napproval_mode = "approve"',
    '[mcp_servers.captain-memo.tools.status]\napproval_mode = "prompt"',
  );
  expect(before).toContain('approval_mode = "prompt"');
  const cfg = writeConfig(home, before);
  expect(refreshCodexToolApprovals(home, {})).toEqual([...MISSING]);
  const after = readFileSync(cfg, 'utf-8');
  expect(after.match(/\[mcp_servers\.captain-memo\.tools\.status\]/g)).toHaveLength(1);
  expect(after).toContain('[mcp_servers.captain-memo.tools.status]\napproval_mode = "prompt"');
});

test('refresh — never throws: an unreadable config is one log line and no change', () => {
  const home = tmpHome();
  mkdirSync(codexConfigPath(home, {}), { recursive: true });        // config.toml is a DIRECTORY: readFileSync throws EISDIR
  const lines: string[] = [];
  expect(() => refreshCodexToolApprovals(home, {}, (l) => lines.push(l))).not.toThrow();
  expect(refreshCodexToolApprovals(home, {}, (l) => lines.push(l))).toEqual([]);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('could not refresh');
});

// ---- doctor ------------------------------------------------------------------

const CFG = '/home/u/.codex/config.toml';

test('doctor — N/A (no check at all) with no config file, or with captain-memo not registered in it', () => {
  expect(codexApprovalsVerdict(null, CFG)).toBeNull();
  expect(codexApprovalsVerdict('model = "gpt-5.6-sol"\n[mcp_servers.other-server]\ncommand = "node"\n', CFG)).toBeNull();
  expect(codexApprovalsVerdict(staleConfig(MISSING, false), CFG)).toBeNull();
});

test('doctor — PASS when every tool in CODEX_TOOL_NAMES has its approval block', () => {
  const c = codexApprovalsVerdict(mergeCodexToolApprovals(staleConfig()), CFG)!;
  expect(c.status).toBe('PASS');
  expect(c.detail).toContain(`all ${CODEX_TOOL_NAMES.length} captain-memo tools approved`);
  expect(c.remedy).toBeUndefined();
});

test('doctor — WARN names the missing tools and gives `captain-memo connect codex` as the remedy', () => {
  const c = codexApprovalsVerdict(staleConfig(), CFG)!;
  expect(c.status).toBe('WARN');
  expect(c.name).toBe('codex approvals');
  expect(c.name.length).toBeLessThanOrEqual(22);                    // doctor pads the name column to 22
  expect(c.detail).toContain(`4 of ${CODEX_TOOL_NAMES.length}`);
  for (const t of MISSING) expect(c.detail).toContain(t);
  expect(c.detail).not.toContain('todo_add');                       // an approved tool is not named
  expect(c.detail).toContain(CFG);
  expect(c.remedy).toBe('captain-memo connect codex');
});

test('doctor — the verdict changes nothing: it takes text, not a path', () => {
  const before = staleConfig();
  codexApprovalsVerdict(before, CFG);
  expect(before).toBe(staleConfig());
});

// ---- CODEX_HOME --------------------------------------------------------------
// Codex reads config.toml from $CODEX_HOME when it is set; connect, doctor and the refresh
// have to read that same file or the approvals sit in one that codex never opens.

test('codexHomeDir — $CODEX_HOME when set and non-empty, else <home>/.codex; codex itself reads an empty one as unset', () => {
  const home = tmpHome();
  const cx = join(home, 'cx');
  for (const env of [{}, { CODEX_HOME: undefined }, { CODEX_HOME: '' }]) {
    expect(codexHomeDir(home, env)).toBe(join(home, '.codex'));
    expect(codexConfigPath(home, env)).toBe(join(home, '.codex', 'config.toml'));
  }
  expect(codexHomeDir(home, { CODEX_HOME: cx })).toBe(cx);
  expect(codexConfigPath(home, { CODEX_HOME: cx })).toBe(join(cx, 'config.toml'));     // join, not '/' — an absolute C:\... path too
});

test('refresh — CODEX_HOME set: the config there is brought current; <home>/.codex is neither read nor created', () => {
  const home = tmpHome();
  const env = { CODEX_HOME: join(home, 'cx') };
  const before = staleConfig();
  const cfg = writeConfig(home, before, env);
  const lines: string[] = [];

  expect(refreshCodexToolApprovals(home, env, (l) => lines.push(l))).toEqual([...MISSING]);

  expect(cfg).toBe(join(home, 'cx', 'config.toml'));
  expect(readFileSync(cfg, 'utf-8')).toBe(mergeCodexToolApprovals(before));
  expect(lines[0]).toContain(cfg);                                  // the log line names the file it really wrote
  expect(existsSync(join(home, '.codex'))).toBe(false);
});

test('refresh — CODEX_HOME set: a stale config in <home>/.codex is left byte-identical (the file codex does not read)', () => {
  const home = tmpHome();
  const env = { CODEX_HOME: join(home, 'cx') };
  const decoy = writeConfig(home, staleConfig());                   // <home>/.codex/config.toml, 4 approvals short
  const lines: string[] = [];

  // CODEX_HOME has no config at all, then one that never registered captain-memo: nothing to do either way
  mkdirSync(env.CODEX_HOME);
  expect(refreshCodexToolApprovals(home, env, (l) => lines.push(l))).toEqual([]);
  const other = writeConfig(home, 'model = "gpt-5.6-sol"\n', env);
  expect(refreshCodexToolApprovals(home, env, (l) => lines.push(l))).toEqual([]);

  expect(readFileSync(decoy, 'utf-8')).toBe(staleConfig());
  expect(readFileSync(other, 'utf-8')).toBe('model = "gpt-5.6-sol"\n');
  expect(lines).toEqual([]);
});

test('refresh — an empty CODEX_HOME is unset: it goes to <home>/.codex', () => {
  const home = tmpHome();
  const cfg = writeConfig(home, staleConfig());
  expect(refreshCodexToolApprovals(home, { CODEX_HOME: '' })).toEqual([...MISSING]);
  expect(readFileSync(cfg, 'utf-8')).toBe(mergeCodexToolApprovals(staleConfig()));
});

test('doctor — reads the config.toml codex reads: CODEX_HOME when set, <home>/.codex otherwise', () => {
  const home = tmpHome();
  const env = { CODEX_HOME: join(home, 'cx') };
  writeConfig(home, mergeCodexToolApprovals(staleConfig()));        // <home>/.codex: every approval there  => PASS
  const cfg = writeConfig(home, staleConfig(), env);                // CODEX_HOME: 4 short                   => WARN

  const warn = codexApprovalsCheck(home, env)!;
  expect(warn.status).toBe('WARN');
  expect(warn.detail).toContain(`4 of ${CODEX_TOOL_NAMES.length}`);
  expect(warn.detail).toContain(cfg);                               // names the file it read
  for (const t of MISSING) expect(warn.detail).toContain(t);
  expect(codexApprovalsCheck(home, {})!.status).toBe('PASS');
  expect(codexApprovalsCheck(home, { CODEX_HOME: '' })!.status).toBe('PASS');

  writeFileSync(cfg, 'model = "gpt-5.6-sol"\n');                   // CODEX_HOME never registered captain-memo
  expect(codexApprovalsCheck(home, env)).toBeNull();                // N/A — not the PASS the fully approved <home>/.codex would give
  rmSync(cfg);
  expect(codexApprovalsCheck(home, env)).toBeNull();
});

test('doctor — an unreadable config under CODEX_HOME is one WARN naming it, not a throw', () => {
  const home = tmpHome();
  const env = { CODEX_HOME: join(home, 'cx') };
  mkdirSync(codexConfigPath(home, env), { recursive: true });       // config.toml is a DIRECTORY
  const c = codexApprovalsCheck(home, env)!;
  expect(c.status).toBe('WARN');
  expect(c.detail).toContain(`could not read ${join(home, 'cx', 'config.toml')}`);
});

test('codexConfigPath and doctor take CODEX_HOME from the process environment by default (connect has no env to pass)', () => {
  const home = tmpHome();
  const cx = join(home, 'cx');
  const cfg = join(cx, 'config.toml');                              // spelled out, not asked of the helper under test
  mkdirSync(cx);
  writeFileSync(cfg, staleConfig());
  const saved = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = cx;
    expect(codexConfigPath(home)).toBe(cfg);
    expect(codexApprovalsCheck(home)!.detail).toContain(cfg);
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved;
  }
  expect(codexConfigPath(home)).toBe(join(home, '.codex', 'config.toml'));
});

// ---- wiring ------------------------------------------------------------------

// The worker's boot is the only caller. A unit test cannot boot a worker, so pin the lines that make the refresh run:
// both boots (the threaded one and the single-threaded one) call it right after clearTransition(), i.e. only once the
// port is bound, and it hands the real environment (the opt-out) and the real home to refreshCodexToolApprovals.
test('worker boot — both boots run the refresh, after the port is bound', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/worker/index.ts'), 'utf-8');
  expect(src).toMatch(/refreshCodexToolApprovals\(homedir\(\), process\.env, /);
  const calls = [...src.matchAll(/^( *)clearTransition\(\);[^\n]*\n\1void refreshCodexApprovals\(\);/gm)];
  expect(calls).toHaveLength(2);                                    // the threaded and the single-threaded boot
  expect(src.match(/void refreshCodexApprovals\(\)/g)).toHaveLength(2);   // and nowhere else
});
