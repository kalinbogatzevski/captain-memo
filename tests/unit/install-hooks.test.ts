import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyHookInstall, CAPTAIN_MEMO_HOOK_MARKER, grantPluginToolPermissions, CAPTAIN_MEMO_MCP_PERMISSION } from '../../src/cli/commands/install-hooks.ts';

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
