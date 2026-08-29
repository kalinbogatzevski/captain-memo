import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  marketplacePointsAtCheckout, needsCacheRefresh, refreshPluginCacheIfStale,
} from '../../src/cli/plugin-cache-refresh.ts';
import { pluginRegistrationSteps } from '../../src/cli/commands/install.ts';

const REPO = '/home/u/projects/captain-memo-fed';

/** Drive the refresh with no filesystem and no `claude` — the run log IS the assertion. */
function harness(over: { cached?: string | null; pointsAt?: boolean; codes?: Record<string, number> } = {}) {
  const calls: string[][] = [];
  const codes = over.codes ?? {};
  const result = refreshPluginCacheIfStale('0.49.0', REPO, {
    cachedVersion: () => (over.cached === undefined ? '0.20.0' : over.cached),
    pointsAtCheckout: () => over.pointsAt ?? true,
    run: (args) => { calls.push(args); return codes[args[1] ?? ''] ?? 0; },
  });
  return { result, calls };
}

test('drift re-runs the exact registration sequence install.ts uses', () => {
  const { result, calls } = harness();
  expect(result).toEqual({ refreshed: true, from: '0.20.0' });
  // Locked to install.ts rather than hardcoded: if that sequence changes, this must change with it.
  expect(calls).toEqual(pluginRegistrationSteps(REPO));
  // The remove MUST come first — a bare `add` is a no-op on an existing entry, so without it the
  // cache stays frozen, which is the entire bug.
  expect(calls[0]).toContain('remove');
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
  // Re-running `marketplace add <local path>` against a git-source install would silently repoint it.
  const { result, calls } = harness({ pointsAt: false });
  expect(result).toEqual({ refreshed: false, skipped: 'not a directory marketplace on this checkout' });
  expect(calls).toEqual([]);
});

test('a failed `marketplace add` aborts before the install step', () => {
  const { result, calls } = harness({ codes: { marketplace: 1 } });
  expect(result).toEqual({ refreshed: false, skipped: 'marketplace add failed' });
  expect(calls.some(c => c[1] === 'install')).toBe(false);
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
