import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  marketplacePointsAtCheckout, marketplaceState, hadPluginBefore, looksLikeCheckout, markPluginRemoved, pluginRemovedOnPurpose, clearPluginRemoved, findClaudeBinary, PLUGIN_REMOVED_MARKER, activeCachedVersion, needsCacheRefresh, refreshPluginCacheIfStale, healPluginRegistration, pluginRegistration,
} from '../../src/cli/plugin-cache-refresh.ts';

const REPO = '/home/u/projects/captain-memo-checkout';

/** Drive the refresh with no filesystem and no `claude` — the run log IS the assertion. `cached` is what each successive
 *  read of the cache version returns (before the update, then after it). */
function harness(over: { cached?: Array<string | null> | string | null; pointsAt?: boolean; codes?: Record<string, number> } = {}) {
  const calls: string[][] = [];
  const codes = over.codes ?? {};
  const seq = Array.isArray(over.cached) ? over.cached : [over.cached === undefined ? '0.20.0' : over.cached];
  let i = 0;
  const result = refreshPluginCacheIfStale('0.49.0', REPO, {
    cachedVersion: () => seq[Math.min(i++, seq.length - 1)] ?? null,
    pointsAtCheckout: () => over.pointsAt ?? true,
    run: (args) => { calls.push(args); return codes[args[1] === 'marketplace' ? 'marketplace' : args[1] ?? ''] ?? 0; },
  });
  return { result, calls };
}

test('drift runs `marketplace update` then `plugin update`, and nothing else', () => {
  const { result, calls } = harness({ cached: ['0.20.0', '0.49.0'] });
  expect(result).toEqual({ refreshed: true, from: '0.20.0' });
  expect(calls).toEqual([
    ['plugin', 'marketplace', 'update', 'captain-memo'],
    ['plugin', 'update', 'captain-memo@captain-memo'],
  ]);
});

test('the refresh NEVER removes or uninstalls anything, on any path (removing the marketplace uninstalls the plugin)', () => {
  const scenarios: Array<Parameters<typeof harness>[0]> = [
    { cached: ['0.20.0', '0.49.0'] },                       // succeeds
    { cached: ['0.20.0', '0.20.0'] },                       // exits 0 but the cache did not move
    { cached: '0.20.0', codes: { marketplace: 1 } },        // marketplace update fails
    { cached: '0.20.0', codes: { update: 1 } },             // plugin update fails
    { cached: '0.20.0', pointsAt: false },                  // not our checkout
  ];
  for (const sc of scenarios) {
    const { calls } = harness(sc);
    for (const c of calls) {
      expect(c).not.toContain('remove');
      expect(c).not.toContain('uninstall');
      expect(c).not.toContain('install');
    }
  }
});

test('a failed `marketplace update` stops before `plugin update` and leaves the plugin alone', () => {
  const { result, calls } = harness({ codes: { marketplace: 1 } });
  expect(result).toEqual({ refreshed: false, skipped: 'marketplace update failed' });
  expect(calls).toHaveLength(1);
});

test('a failed `plugin update` is reported, not retried destructively', () => {
  const { result, calls } = harness({ codes: { update: 1 } });
  expect(result).toEqual({ refreshed: false, skipped: 'plugin update failed' });
  expect(calls).toHaveLength(2);
});

test('an update that exits 0 but leaves the cache stale is not reported as refreshed', () => {
  const { result } = harness({ cached: ['0.20.0', '0.20.0'] });
  expect(result).toEqual({ refreshed: false, skipped: 'plugin update did not move the cache' });
});

test('a cache already in step spawns nothing', () => {
  const { result, calls } = harness({ cached: '0.49.0' });
  expect(result.refreshed).toBe(false);
  expect(calls).toEqual([]);
});

test('no readable cache copy is ABSENCE, not drift — it must not create one', () => {
  const { result, calls } = harness({ cached: null });
  expect(result.refreshed).toBe(false);
  expect(calls).toEqual([]);
});

test('an install that is not a directory marketplace on this checkout is left alone', () => {
  // `marketplace update` on a git-source install would be harmless, but this routine only acts on the shape it verified.
  const { result, calls } = harness({ pointsAt: false });
  expect(result).toEqual({ refreshed: false, skipped: 'not a directory marketplace on this checkout' });
  expect(calls).toEqual([]);
});

test('marketplacePointsAtCheckout matches only a directory source on THIS checkout', () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-mkt-'));
  const dir = join(home, '.claude', 'plugins');
  mkdirSync(dir, { recursive: true });
  const write = (o: unknown) => writeFileSync(join(dir, 'known_marketplaces.json'), JSON.stringify(o));

  write({ 'captain-memo': { source: { source: 'directory', path: REPO } } });
  expect(marketplacePointsAtCheckout(REPO, home)).toBe(true);
  expect(marketplacePointsAtCheckout(REPO + '/', home)).toBe(true);   // trailing slash is the same path

  write({ 'captain-memo': { source: { source: 'directory', path: '/somewhere/else' } } });
  expect(marketplacePointsAtCheckout(REPO, home)).toBe(false);

  write({ 'captain-memo': { source: { source: 'github', repo: 'x/y' } } });
  expect(marketplacePointsAtCheckout(REPO, home)).toBe(false);

  write({ other: {} });
  expect(marketplacePointsAtCheckout(REPO, home)).toBe(false);
  rmSync(join(dir, 'known_marketplaces.json'));
  expect(marketplacePointsAtCheckout(REPO, home)).toBe(false);        // unreadable ⇒ do nothing
  rmSync(home, { recursive: true, force: true });
});

test('needsCacheRefresh fires on difference only', () => {
  expect(needsCacheRefresh('0.20.0', '0.49.0')).toBe(true);
  expect(needsCacheRefresh('0.49.0', '0.49.0')).toBe(false);
  expect(needsCacheRefresh(null, '0.49.0')).toBe(false);
  // A cache AHEAD of the checkout is still drift — a rollback must re-snapshot too.
  expect(needsCacheRefresh('0.50.0', '0.49.0')).toBe(true);
});

// ─── heal: put the plugin back when it is missing ─────────────────────────────────────────────────────────────
function healHarness(over: { reg?: 'yes' | 'no' | 'unknown'; mk?: 'ours' | 'absent' | 'other' | 'unknown'; had?: boolean; checkout?: boolean; removed?: boolean; cleared?: { n: number }; codes?: number[] } = {}) {
  const calls: string[][] = [];
  const codes = [...(over.codes ?? [0])];
  return {
    calls,
    go: () => healPluginRegistration(REPO, {
      registration: () => over.reg ?? 'no',
      marketplace: () => over.mk ?? 'ours',
      hadPlugin: () => over.had ?? true,
      isCheckout: () => over.checkout ?? true,
      removedOnPurpose: () => over.removed ?? false,
      clearRemoved: () => { if (over.cleared) over.cleared.n++; },
      retryDelayMs: 1,
      run: async (args) => { calls.push(args); return codes.length > 1 ? codes.shift()! : codes[0]!; },
    }),
  };
}

test('heal: a missing plugin on our directory marketplace is installed again, at user scope', async () => {
  const h = healHarness();
  expect(await h.go()).toEqual({ healed: true });
  expect(h.calls).toEqual([['plugin', 'install', 'captain-memo@captain-memo', '--scope', 'user']]);
});

test('heal: nothing to do when the plugin is registered, the inventory is unreadable, or the marketplace is someone else\'s', async () => {
  for (const sc of [{ reg: 'yes' as const }, { reg: 'unknown' as const }, { mk: 'other' as const }, { mk: 'unknown' as const }]) {
    const h = healHarness(sc);
    expect((await h.go()).healed).toBe(false);
    expect(h.calls).toEqual([]);
  }
});

test('heal: an interrupted `marketplace remove` takes the marketplace too; it is added back, then the plugin installed', async () => {
  const h = healHarness({ mk: 'absent', had: true });
  expect(await h.go()).toEqual({ healed: true });
  expect(h.calls).toEqual([
    ['plugin', 'marketplace', 'add', REPO],
    ['plugin', 'install', 'captain-memo@captain-memo', '--scope', 'user'],
  ]);
});

test('heal: a host that never had the plugin is NOT given one', async () => {
  const h = healHarness({ mk: 'absent', had: false });
  expect(await h.go()).toEqual({ healed: false, skipped: 'never installed here' });
  expect(h.calls).toEqual([]);
});

test('heal: a removal the user asked for (marker left by `captain-memo uninstall`) is NOT undone, in either marketplace state', async () => {
  for (const mk of ['ours', 'absent'] as const) {
    const h = healHarness({ mk, removed: true });
    expect(await h.go()).toEqual({ healed: false, skipped: 'removed on purpose' });
    expect(h.calls).toEqual([]);
  }
});

test('heal: a plugin found installed clears a stale removal marker', async () => {
  const cleared = { n: 0 };
  const h = healHarness({ reg: 'yes', cleared });
  expect((await h.go()).skipped).toBe('installed');
  expect(cleared.n).toBe(1);
});

test('the removal marker: written by uninstall, seen by the heal, cleared by install', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-marker-'));
  expect(pluginRemovedOnPurpose(dir)).toBe(false);
  markPluginRemoved(join(dir, 'not-yet-created'));                       // creates the data dir if it is missing
  expect(pluginRemovedOnPurpose(join(dir, 'not-yet-created'))).toBe(true);
  markPluginRemoved(dir);
  expect(pluginRemovedOnPurpose(dir)).toBe(true);
  expect(existsSync(join(dir, PLUGIN_REMOVED_MARKER))).toBe(true);
  clearPluginRemoved(dir);
  expect(pluginRemovedOnPurpose(dir)).toBe(false);
  clearPluginRemoved(dir);                                               // clearing twice is fine
  rmSync(dir, { recursive: true, force: true });
});

test('findClaudeBinary: PATH first, then the usual install folders, else null', () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-claude-'));
  const onPath = Bun.which('claude');
  if (onPath) expect(findClaudeBinary(home)).toBe(onPath);               // a claude on PATH wins whatever the home holds
  else {
    expect(findClaudeBinary(home)).not.toBe(join(home, '.local', 'bin', 'claude'));
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const exe = join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    writeFileSync(exe, '');
    expect(findClaudeBinary(home)).toBe(exe);
  }
  rmSync(home, { recursive: true, force: true });
});

test('heal: a copy inside the plugin cache (not a git clone) is never registered as a marketplace', async () => {
  const h = healHarness({ mk: 'absent', checkout: false });
  expect(await h.go()).toEqual({ healed: false, skipped: 'not a git checkout' });
  expect(h.calls).toEqual([]);
});

test('heal: a failed `marketplace add` stops before the install', async () => {
  const h = healHarness({ mk: 'absent', codes: [1] });
  expect(await h.go()).toEqual({ healed: false, skipped: 'marketplace add failed' });
  expect(h.calls).toHaveLength(1);
});

test('heal: retries the install and gives up after three attempts without throwing', async () => {
  const flaky = healHarness({ codes: [1, 1, 0] });
  expect(await flaky.go()).toEqual({ healed: true });
  expect(flaky.calls).toHaveLength(3);
  const dead = healHarness({ codes: [1] });
  expect(await dead.go()).toEqual({ healed: false, skipped: 'plugin install failed' });
  expect(dead.calls).toHaveLength(3);
});

test('heal never removes or uninstalls anything either', async () => {
  for (const sc of [{}, { mk: 'absent' as const }, { codes: [1] }]) {
    const h = healHarness(sc);
    await h.go();
    for (const c of h.calls) { expect(c).not.toContain('remove'); expect(c).not.toContain('uninstall'); }
  }
});

test('a second, stale registration does not make the cache look stale for ever (the refresh would run on every session start)', () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-scope-'));
  const plugins = join(home, '.claude', 'plugins');
  mkdirSync(plugins, { recursive: true });
  const tree = (name: string, version: string) => {
    const dir = join(home, 'cache', name);
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'captain-memo', version }));
    return dir;
  };
  // project-scope copy is listed FIRST and was never updated; the user-scope copy is current
  writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: { 'captain-memo@captain-memo': [
    { scope: 'project', installPath: tree('old', '0.20.0') }, { scope: 'user', installPath: tree('new', '0.49.0') },
  ] } }));
  expect(activeCachedVersion(home, '0.49.0')).toBe('0.49.0');   // in step: some registered copy matches
  expect(activeCachedVersion(home, '0.50.0')).toBe('0.20.0');   // real drift: nothing matches, first copy reported
  expect(activeCachedVersion(home)).toBe('0.20.0');             // no running version given: today's behaviour
  rmSync(home, { recursive: true, force: true });
});

test('looksLikeCheckout wants a git clone with the marketplace manifest, and refuses a path inside the plugin cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-clone-'));
  expect(looksLikeCheckout(root)).toBe(false);                                            // nothing there
  mkdirSync(join(root, '.git'), { recursive: true });
  expect(looksLikeCheckout(root)).toBe(false);                                            // no manifest
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), '{}');
  expect(looksLikeCheckout(root)).toBe(true);
  const cached = join(root, '.claude', 'plugins', 'cache', 'captain-memo', 'captain-memo', '0.57.3');
  mkdirSync(join(cached, '.git'), { recursive: true });
  mkdirSync(join(cached, '.claude-plugin'), { recursive: true });
  writeFileSync(join(cached, '.claude-plugin', 'marketplace.json'), '{}');
  expect(looksLikeCheckout(cached)).toBe(false);                                          // a plugin-cache copy is not a clone
  rmSync(root, { recursive: true, force: true });
});

test('marketplaceState tells ours from absent, someone else\'s and unreadable; hadPluginBefore reads the cache dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-mkst-'));
  const dir = join(home, '.claude', 'plugins');
  mkdirSync(dir, { recursive: true });
  const write = (o: unknown) => writeFileSync(join(dir, 'known_marketplaces.json'), JSON.stringify(o));
  expect(marketplaceState(REPO, home)).toBe('unknown');                                   // no file
  write({ other: {} });
  expect(marketplaceState(REPO, home)).toBe('absent');
  write({ 'captain-memo': { source: { source: 'directory', path: REPO } } });
  expect(marketplaceState(REPO, home)).toBe('ours');
  write({ 'captain-memo': { source: { source: 'github', repo: 'x/y' } } });
  expect(marketplaceState(REPO, home)).toBe('other');
  expect(hadPluginBefore(home)).toBe(false);
  mkdirSync(join(dir, 'cache', 'captain-memo', 'captain-memo', '0.49.0'), { recursive: true });
  expect(hadPluginBefore(home)).toBe(true);
  rmSync(home, { recursive: true, force: true });
});

test('pluginRegistration: yes when a registered tree is captain-memo, no when it is not or is gone, unknown without an inventory', () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-reg-'));
  const plugins = join(home, '.claude', 'plugins');
  mkdirSync(plugins, { recursive: true });
  expect(pluginRegistration(home)).toBe('unknown');                                // no inventory file
  const tree = join(home, 'cache', 'captain-memo');
  mkdirSync(join(tree, '.claude-plugin'), { recursive: true });
  writeFileSync(join(tree, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'captain-memo', version: '0.57.3' }));
  const inv = (o: unknown) => writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify(o));
  inv({ plugins: { 'captain-memo@captain-memo': [{ scope: 'user', installPath: tree }] } });
  expect(pluginRegistration(home)).toBe('yes');
  inv({ plugins: { 'captain-memo@captain-memo': [{ scope: 'user', installPath: join(home, 'cache', 'gone') }] } });
  expect(pluginRegistration(home)).toBe('no');                                     // registered, but nothing would load
  inv({ plugins: {} });
  expect(pluginRegistration(home)).toBe('no');                                     // readable inventory with no captain-memo entry
  writeFileSync(join(plugins, 'installed_plugins.json'), 'not json');
  expect(pluginRegistration(home)).toBe('unknown');
  rmSync(home, { recursive: true, force: true });
});

test('wiring: uninstall leaves the removal marker and install clears it (the heal depends on both)', async () => {
  const { readFileSync } = await import('fs');
  const uninstall = readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', 'commands', 'uninstall.ts'), 'utf-8');
  const install = readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', 'commands', 'install.ts'), 'utf-8');
  expect(uninstall).toMatch(/markPluginRemoved\(\)/);
  expect(install).toMatch(/function registerPlugin[^{]*\{\s*clearPluginRemoved\(\)/);
});
