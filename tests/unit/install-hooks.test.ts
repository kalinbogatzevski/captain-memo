import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyHookInstall, EVENT_TIMEOUT_S, CAPTAIN_MEMO_HOOK_MARKER, grantPluginToolPermissions, CAPTAIN_MEMO_MCP_PERMISSION } from '../../src/cli/commands/install-hooks.ts';

let workDir: string;
let settingsPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-install-'));
  settingsPath = join(workDir, 'settings.json');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test('applyHookInstall — empty file: writes 4 hooks all marked', () => {
  applyHookInstall({ settingsPath, hookCommand: '/usr/bin/captain-memo-hook' });
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  expect(settings.hooks).toBeDefined();
  for (const event of ['UserPromptSubmit', 'SessionStart', 'PostToolUse', 'Stop']) {
    expect(settings.hooks[event]).toBeDefined();
    const found = JSON.stringify(settings.hooks[event]);
    expect(found).toContain('captain-memo-hook');
    expect(found).toContain(CAPTAIN_MEMO_HOOK_MARKER);
  }
});

test('applyHookInstall — idempotent: re-running does not duplicate entries', () => {
  applyHookInstall({ settingsPath, hookCommand: '/usr/bin/captain-memo-hook' });
  applyHookInstall({ settingsPath, hookCommand: '/usr/bin/captain-memo-hook' });
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  for (const event of ['UserPromptSubmit', 'SessionStart', 'PostToolUse', 'Stop']) {
    const groupCount = settings.hooks[event].length;
    expect(groupCount).toBe(1);
  }
});

test('applyHookInstall — preserves foreign hook entries', () => {
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: '/some/other/hook' }] },
      ],
    },
  }, null, 2));
  applyHookInstall({ settingsPath, hookCommand: '/usr/bin/captain-memo-hook' });
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  const ups = JSON.stringify(settings.hooks.UserPromptSubmit);
  expect(ups).toContain('/some/other/hook');
  expect(ups).toContain('/usr/bin/captain-memo-hook');
});

test('applyHookInstall — warns and skips a foreign command at our marker if present', () => {
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: `/foreign/path #${CAPTAIN_MEMO_HOOK_MARKER}` }] },
      ],
    },
  }, null, 2));
  const result = applyHookInstall({ settingsPath, hookCommand: '/usr/bin/captain-memo-hook' });
  expect(result.warnings.length).toBeGreaterThan(0);
});

test('applyHookInstall — preserves non-hook keys in settings.json', () => {
  writeFileSync(settingsPath, JSON.stringify({
    permissions: { allow: ['Read'] },
    statusLine: { type: 'static', text: 'foo' },
  }, null, 2));
  applyHookInstall({ settingsPath, hookCommand: '/usr/bin/captain-memo-hook' });
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  expect(settings.permissions.allow).toEqual(['Read']);
  expect(settings.statusLine.text).toBe('foo');
});

test('grantPluginToolPermissions — adds the MCP wildcard to permissions.allow', () => {
  grantPluginToolPermissions(settingsPath);
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  expect(settings.permissions.allow).toContain(CAPTAIN_MEMO_MCP_PERMISSION);
});

test('grantPluginToolPermissions — idempotent + preserves existing allow and other keys', () => {
  writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, model: 'opus' }, null, 2));
  const r1 = grantPluginToolPermissions(settingsPath);
  const r2 = grantPluginToolPermissions(settingsPath);
  expect(r1.added).toBe(true);
  expect(r2.added).toBe(false);  // already present → no duplicate
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  expect(settings.permissions.allow).toContain('Bash(ls)');          // preserved
  expect(settings.permissions.allow).toContain(CAPTAIN_MEMO_MCP_PERMISSION);
  expect(settings.permissions.allow.filter((p: string) => p === CAPTAIN_MEMO_MCP_PERMISSION).length).toBe(1);
  expect(settings.model).toBe('opus');                               // other keys untouched
});

test('grantPluginToolPermissions — refuses to overwrite a corrupt settings.json (no silent data loss)', () => {
  // A present-but-unparseable file (e.g. a trailing comma mid-edit) must NOT be
  // treated as empty and overwritten — that would destroy the user's hooks/model.
  const original = '{ "model": "opus", "hooks": {} ,}';   // trailing comma → invalid JSON
  writeFileSync(settingsPath, original);
  expect(() => grantPluginToolPermissions(settingsPath)).toThrow(/not valid JSON/);
  expect(readFileSync(settingsPath, 'utf-8')).toBe(original);   // left byte-for-byte untouched
});

// #951(2): the settings.json install wrote no timeout key, so its hooks ran under Claude Code's default instead of the cut the
// plugin registers. Each written entry carries hooks.json's timeout for its event, and an entry written before gets it too.
test('applyHookInstall — every entry carries the timeout plugin/hooks/hooks.json registers for its event', () => {
  const plugin = JSON.parse(readFileSync(join(import.meta.dir, '../../plugin/hooks/hooks.json'), 'utf-8')).hooks as Record<string, Array<{ hooks: Array<{ timeout?: number }> }>>;
  const check = () => {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    for (const [event, groups] of Object.entries(settings.hooks as Record<string, Array<{ hooks: Array<{ timeout?: number }> }>>)) {
      expect(groups[0]!.hooks[0]!.timeout).toBe(plugin[event]![0]!.hooks[0]!.timeout);
      expect(EVENT_TIMEOUT_S[event as keyof typeof EVENT_TIMEOUT_S]).toBe(plugin[event]![0]!.hooks[0]!.timeout);
    }
  };
  applyHookInstall({ settingsPath, hookCommand: '/usr/bin/captain-memo-hook' });
  check();
  const old = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  delete old.hooks.SessionStart[0].hooks[0].timeout;   // as an older install wrote it
  writeFileSync(settingsPath, JSON.stringify(old));
  applyHookInstall({ settingsPath, hookCommand: '/usr/bin/captain-memo-hook' });
  check();
  expect(EVENT_TIMEOUT_S.SessionStart).toBe(60);
});
