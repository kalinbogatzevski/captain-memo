// Re-snapshot the plugin CACHE copy after the checkout moves under it.
//
// A git-clone install advances by git: `git pull`, or the opt-in self-updater (CAPTAIN_MEMO_AUTO_UPDATE=1)
// fast-forwarding to a release tag. Both move the checkout and stop there — neither re-copies the
// plugin into Claude Code's cache at ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/, because
// only `captain-memo install` does that (via pluginRegistrationSteps: marketplace remove → add → install).
//
// Measured 2026-08-29, and this is the whole bug: a checkout on 0.49.0 with a cache copy still on 0.20.0
// from 2026-07-08 — and the Claude Desktop plugin snapshot materialized on Aug 25 came out 0.20.0, on a
// day when the repo said 0.49.0 and the cache said 0.20.0. The cache is not a spare copy; it is what the
// next Desktop session is built from.
//
// This runs from SessionStart rather than from inside the updater's success branch, deliberately: gating
// it there would make it conditional on an env var, a due interval, a won lock, a clean fast-forward AND
// a healthy restart — so a plain `git pull`, the commonest way a clone moves, would never trigger it.
// Watching the RESULT instead — cache version ≠ checkout version — catches every path without having to
// know which one ran.

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { readInstalledPaths, readPluginManifest, normalizePath } from '../shared/plugin-cache.ts';
import { pluginRegistrationSteps } from './commands/install.ts';

/** This checkout's root — resolved from THIS module, so callers at different depths (the hook, the CLI)
 *  cannot each drift to a different answer. */
export const REPO_ROOT = join(import.meta.dir, '..', '..');

/** Is captain-memo installed from a `directory` marketplace pointing at THIS checkout?
 *
 *  The gate on acting at all. The refresh below re-runs `claude plugin marketplace add <REPO_ROOT>`,
 *  which is only the right thing to do when that is already where this install comes from. On a
 *  git-source marketplace (or any shape we did not verify) it would silently repoint the install at a
 *  local path — so anything but an exact match means: do nothing. */
export function marketplacePointsAtCheckout(repoRoot: string, home: string = homedir()): boolean {
  try {
    const file = join(home, '.claude', 'plugins', 'known_marketplaces.json');
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, { source?: { source?: unknown; path?: unknown } }>;
    const src = parsed['captain-memo']?.source;
    return src?.source === 'directory' && typeof src.path === 'string'
      && normalizePath(src.path) === normalizePath(repoRoot);
  } catch { return false; }
}

/** The version the ACTIVE cache copy carries, or null when there is none we can read.
 *
 *  "Active" is whichever tree installed_plugins.json points at — never the newest by name. A stray
 *  orphaned tree with a higher version would otherwise mask real drift. */
export function activeCachedVersion(home: string = homedir()): string | null {
  const installed = readInstalledPaths(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  if (installed === null) return null;
  for (const path of installed) {
    const m = readPluginManifest(path);
    if (m?.name === 'captain-memo') return m.version;
  }
  return null;
}

/** Pure: is a refresh warranted?
 *
 *  ONLY on observed drift. A null cached version means there is no readable cache copy — a shape we have
 *  not verified (a fresh install, a non-directory source, an unreadable inventory), and creating one from
 *  a background hook is not this function's job. Absence is not drift. */
export function needsCacheRefresh(cachedVersion: string | null, runningVersion: string): boolean {
  return cachedVersion !== null && cachedVersion !== runningVersion;
}

export interface RefreshResult {
  refreshed: boolean;
  /** The stale version we found in the cache, when we acted. */
  from?: string;
  /** Why we did nothing — for the log, never thrown. */
  skipped?: string;
}

export interface CacheRefreshDeps {
  cachedVersion?: (home?: string) => string | null;
  pointsAtCheckout?: (repoRoot: string) => boolean;
  /** Runs one `claude …` argv. Must never throw; a non-zero code aborts the remaining steps. */
  run?: (args: string[]) => number;
}

/** Bring the cache copy back in step with the checkout. Best-effort in every direction: a failure leaves
 *  today's behaviour (a stale cache), never a broken session start.
 *
 *  Verified 2026-08-29 that `claude plugin …` subcommands do NOT fire hooks, so calling this from inside
 *  a SessionStart hook cannot recurse. The remove→add window during which the marketplace is unregistered
 *  is pre-existing (install.ts has the same one) — it is kept tight and user-scoped, so a project/local
 *  declaration is never touched. */
export function refreshPluginCacheIfStale(
  runningVersion: string, repoRoot: string = REPO_ROOT, deps: CacheRefreshDeps = {},
): RefreshResult {
  const cachedVersion = (deps.cachedVersion ?? activeCachedVersion)();
  if (!needsCacheRefresh(cachedVersion, runningVersion)) return { refreshed: false, skipped: 'cache is in step' };

  const pointsAt = deps.pointsAtCheckout ?? ((r: string) => marketplacePointsAtCheckout(r));
  if (!pointsAt(repoRoot)) return { refreshed: false, skipped: 'not a directory marketplace on this checkout' };

  const run = deps.run ?? ((args: string[]) => {
    const r = spawnSync('claude', args, { stdio: 'pipe', timeout: 120_000 });
    return r.status ?? 1;
  });

  // Same three steps `captain-memo install` runs, in the same order and for the same reason: a bare
  // `marketplace add` is a no-op on an existing entry, so without the remove first the cache stays
  // frozen — which is precisely the bug being fixed here.
  const steps = pluginRegistrationSteps(repoRoot);
  run(steps[0]!);                          // remove: best-effort, non-zero is normal on a fresh install
  if (run(steps[1]!) !== 0) return { refreshed: false, skipped: 'marketplace add failed' };
  if (run(steps[2]!) !== 0) return { refreshed: false, skipped: 'plugin install failed' };
  return { refreshed: true, from: cachedVersion! };
}

export const CACHE_REFRESH_LOCK = '.plugin-cache-refresh.lock';
