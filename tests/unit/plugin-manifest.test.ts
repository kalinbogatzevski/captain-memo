import { test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '../..');

function readJson(rel: string): any {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf-8'));
}

// Guards the regression where marketplace.json silently sat at 0.1.0 while
// plugin.json moved to 0.2.4. A `directory`-source marketplace caches the plugin
// at the version it was added with, so a stale marketplace version freezes the
// cache (and with it, an out-of-date hooks.json). Keep the two manifests in
// lockstep — bump them together — and this stays a CI failure, not a field break.
test('marketplace.json plugin version matches plugin.json version', () => {
  const plugin = readJson('plugin/.claude-plugin/plugin.json');
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const entry = marketplace.plugins?.find((p: { name?: string }) => p.name === 'captain-memo');
  expect(entry).toBeDefined();
  expect(entry.version).toBe(plugin.version);
});

// Guards the exact failure that paged us: hooks must launch the COMMITTED bundle
// (plugin/dist/*.js), never the `bin/captain-memo-hook` symlink that the Windows
// work deleted. If anyone reverts the hook command or the bundle goes missing,
// this fails before it can reach a user's cache.
test('plugin hooks reference the committed dist bundle, not the deleted symlink', () => {
  const hooks = readFileSync(join(ROOT, 'plugin/hooks/hooks.json'), 'utf-8');
  expect(hooks).toContain('dist/captain-memo-hook.js');
  expect(hooks).not.toContain('/bin/captain-memo-hook');
  expect(existsSync(join(ROOT, 'plugin/dist/captain-memo-hook.js'))).toBe(true);
  expect(existsSync(join(ROOT, 'plugin/dist/mcp-server.js'))).toBe(true);
});
