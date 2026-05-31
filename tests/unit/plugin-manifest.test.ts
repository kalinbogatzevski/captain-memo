import { test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { VERSION } from '../../src/shared/version.ts';

const ROOT = join(import.meta.dir, '../..');

function readJson(rel: string): any {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf-8'));
}

// ONE version, everywhere. package.json is the source of truth; plugin.json and
// marketplace.json must match it exactly. Drift here is what froze the directory
// marketplace cache (marketplace.json sat at 0.1.0 while plugin.json moved on) —
// keeping all three in lockstep makes the plugin-cache key advance every release,
// so a stale cache can't survive, and any future drift is a CI failure not a field
// break. Bump the version in package.json and mirror it in the two manifests.
test('all three manifest versions are identical (package.json = plugin.json = marketplace.json)', () => {
  const pkg = readJson('package.json');
  const plugin = readJson('plugin/.claude-plugin/plugin.json');
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const entry = marketplace.plugins?.find((p: { name?: string }) => p.name === 'captain-memo');
  expect(entry).toBeDefined();
  expect(plugin.version).toBe(pkg.version);
  expect(entry.version).toBe(pkg.version);
});

// The runtime VERSION global (imported by the CLI banner, worker /stats, and MCP
// serverInfo) must resolve to the same number — no hardcoded literal anywhere
// (mcp-server.ts used to carry a stray '0.1.0-alpha'). This proves the single
// source is actually wired, not just that the manifests agree on paper.
test('runtime VERSION global equals package.json version', () => {
  const pkg = readJson('package.json');
  expect(VERSION).toBe(pkg.version);
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

// The committed MCP bundle inlines the version at build time (it imports VERSION
// → package.json). If someone bumps the version but forgets `bun run build:plugin`,
// the manifests agree (other tests pass) yet the shipped serverInfo reports a stale
// version. Assert the committed bundle embeds the current version so that drift is
// a CI failure, not a silent stale-artifact release.
test('committed mcp-server bundle embeds the current version (no stale dist after a bump)', () => {
  const pkg = readJson('package.json');
  const bundle = readFileSync(join(ROOT, 'plugin/dist/mcp-server.js'), 'utf-8');
  expect(bundle).toContain(pkg.version);
});
