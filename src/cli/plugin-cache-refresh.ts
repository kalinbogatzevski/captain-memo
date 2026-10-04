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
//
// Why this only ever UPDATES: the refresh used to be `marketplace remove` → `add` → `install`. Removing a
// marketplace uninstalls its plugins, so for the length of that sequence Claude Code has no Captain Memo, and
// a hook cut off in the middle (Claude Code stops a SessionStart hook after 60 s) leaves it that way: every
// new session then starts without the plugin's MCP server, hooks and skills, and nothing is logged, because
// the log line comes after the sequence. `marketplace update` followed by `plugin update` moves a
// directory-marketplace plugin to the new version without ever removing it (checked against the real CLI: the
// plugin stays registered at every moment), so a failure leaves the installed plugin as it was. A plugin that
// went missing anyway is put back by healPluginRegistration, which the worker runs: a hook cannot run once
// the plugin it belongs to is gone.

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { readInstalledPaths, readPluginManifest, normalizePath } from '../shared/plugin-cache.ts';
import { DATA_DIR } from '../shared/paths.ts';

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
  return marketplaceState(repoRoot, home) === 'ours';
}

export type MarketplaceState = 'ours' | 'absent' | 'other' | 'unknown';

/** What known_marketplaces.json says about captain-memo: 'ours' = a directory source on THIS checkout; 'absent' = the
 *  file is readable and has no such entry; 'other' = a different source (GitHub, another path), which is never
 *  repointed; 'unknown' = the file cannot be read. */
export function marketplaceState(repoRoot: string, home: string = homedir()): MarketplaceState {
  try {
    const file = join(home, '.claude', 'plugins', 'known_marketplaces.json');
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, { source?: { source?: unknown; path?: unknown } }>;
    const entry = parsed['captain-memo'];
    if (!entry) return 'absent';
    const src = entry.source;
    return src?.source === 'directory' && typeof src.path === 'string' && normalizePath(src.path) === normalizePath(repoRoot) ? 'ours' : 'other';
  } catch { return 'unknown'; }
}

/** `captain-memo uninstall` leaves this file in the data dir and `captain-memo install` removes it. While it exists the
 *  worker's heal leaves a missing plugin alone: that is the one signal that tells a removal the user asked for from
 *  damage, because the heal otherwise sees the same state (plugin gone, cache kept) in both cases. */
export const PLUGIN_REMOVED_MARKER = 'plugin-removed';
export function pluginRemovedOnPurpose(dataDir: string = DATA_DIR): boolean { return existsSync(join(dataDir, PLUGIN_REMOVED_MARKER)); }
export function markPluginRemoved(dataDir: string = DATA_DIR): void {
  try { mkdirSync(dataDir, { recursive: true }); writeFileSync(join(dataDir, PLUGIN_REMOVED_MARKER), new Date().toISOString() + '\n'); } catch { /* best effort */ }
}
export function clearPluginRemoved(dataDir: string = DATA_DIR): void {
  try { rmSync(join(dataDir, PLUGIN_REMOVED_MARKER), { force: true }); } catch { /* best effort */ }
}

/** The `claude` binary the heal runs: on PATH, else the usual install folders. A service manager's PATH often lacks
 *  ~/.local/bin, where the native installer puts it, and the heal would otherwise never be armed. */
export function findClaudeBinary(home: string = homedir()): string | null {
  const onPath = Bun.which('claude');
  if (onPath) return onPath;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const p of [join(home, '.local', 'bin', exe), join(home, '.claude', 'local', exe), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Has Claude Code ever held a Captain Memo copy on this host? Its cache keeps a tree per version (an updated or
 *  removed one is only marked orphaned and kept for a while), so a non-empty cache directory is the evidence that
 *  the plugin was installed here. Without it a host that never used the plugin would be given one by the heal. */
export function hadPluginBefore(home: string = homedir()): boolean {
  try { return readdirSync(join(home, '.claude', 'plugins', 'cache', 'captain-memo', 'captain-memo')).length > 0; }
  catch { return false; }
}

/** Is `repoRoot` a real git clone of this project, and not a copy inside Claude Code's own plugin cache? Only a clone
 *  may be registered as a directory marketplace; a marketplace install runs from the cache and must never be
 *  pointed at itself. */
export function looksLikeCheckout(repoRoot: string): boolean {
  return existsSync(join(repoRoot, '.git')) && existsSync(join(repoRoot, '.claude-plugin', 'marketplace.json'))
    && !normalizePath(repoRoot).includes('/.claude/plugins/');
}

/** The version the ACTIVE cache copy carries, or null when there is none we can read.
 *
 *  "Active" is whichever tree installed_plugins.json points at — never the newest by name. A stray
 *  orphaned tree with a higher version would otherwise mask real drift. */
export function activeCachedVersion(home: string = homedir(), runningVersion?: string): string | null {
  const installed = readInstalledPaths(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  if (installed === null) return null;
  let first: string | null = null;
  for (const path of installed) {
    const m = readPluginManifest(path);
    if (m?.name !== 'captain-memo') continue;
    // A second registration (a project-scope copy an update did not touch) can sit ahead of the user-scope one in
    // the file. If ANY registered copy already carries the running version the cache is in step; otherwise every
    // session start would spawn the refresh again for ever.
    if (runningVersion !== undefined && m.version === runningVersion) return m.version;
    first ??= m.version;
  }
  return first;
}

/** Is the plugin registered with Claude Code? 'unknown' when the inventory cannot be read at all, so a caller never
 *  acts on a file it could not read. A registration whose cache copy is gone reads as 'no': nothing would load. */
export function pluginRegistration(home: string = homedir()): 'yes' | 'no' | 'unknown' {
  const installed = readInstalledPaths(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  if (installed === null) return 'unknown';
  for (const path of installed) if (readPluginManifest(path)?.name === 'captain-memo') return 'yes';
  return 'no';
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

/** Bring the cache copy back in step with the checkout, WITHOUT ever uninstalling the plugin. Best-effort in every
 *  direction: a failure leaves today's behaviour (a stale cache and a working plugin), never a broken session start.
 *
 *  `claude plugin …` subcommands do NOT fire hooks (verified 2026-08-29), so calling this from a SessionStart hook
 *  cannot recurse. The two commands below never remove anything: on failure the installed plugin is untouched. */
export function refreshPluginCacheIfStale(
  runningVersion: string, repoRoot: string = REPO_ROOT, deps: CacheRefreshDeps = {},
): RefreshResult {
  const cachedVersion = deps.cachedVersion ?? (() => activeCachedVersion(undefined, runningVersion));
  const before = cachedVersion();
  if (!needsCacheRefresh(before, runningVersion)) return { refreshed: false, skipped: 'cache is in step' };

  const pointsAt = deps.pointsAtCheckout ?? ((r: string) => marketplacePointsAtCheckout(r));
  if (!pointsAt(repoRoot)) return { refreshed: false, skipped: 'not a directory marketplace on this checkout' };

  const run = deps.run ?? ((args: string[]) => {
    const r = spawnSync('claude', args, { stdio: 'pipe', timeout: 120_000 });
    return r.status ?? 1;
  });

  // Re-read the marketplace listing from the checkout, then update the plugin in place. A bare `marketplace add` is
  // a no-op on an existing entry, which is why the cache once froze; `marketplace update` is the call that re-reads it.
  if (run(['plugin', 'marketplace', 'update', 'captain-memo']) !== 0) return { refreshed: false, skipped: 'marketplace update failed' };
  if (run(['plugin', 'update', 'captain-memo@captain-memo']) !== 0) return { refreshed: false, skipped: 'plugin update failed' };
  if (needsCacheRefresh(cachedVersion(), runningVersion)) return { refreshed: false, skipped: 'plugin update did not move the cache' };
  return { refreshed: true, from: before! };
}

export interface HealResult {
  healed: boolean;
  /** Why we did nothing, for the log. 'installed' = nothing to do. */
  skipped?: string;
}

export interface HealDeps {
  registration?: () => 'yes' | 'no' | 'unknown';
  marketplace?: () => MarketplaceState;
  hadPlugin?: () => boolean;
  isCheckout?: (repoRoot: string) => boolean;
  removedOnPurpose?: () => boolean;
  clearRemoved?: () => void;
  /** Runs one `claude …` argv; resolves to its exit code and never rejects. */
  run?: (args: string[]) => Promise<number>;
  retryDelayMs?: number;
}

/** Put the plugin back when it is missing from Claude Code. Run by the worker, not by a hook: a hook cannot run
 *  once the plugin is gone, and Claude Code stops a hook after 60 s. Never throws.
 *   - marketplace still on this checkout: install the plugin (three attempts, a few seconds apart);
 *   - marketplace gone too (an interrupted `marketplace remove` takes both): add it again, then install, but only
 *     when this is a real git clone and the cache shows the plugin was installed here before, so a host that never
 *     used the plugin is not given one and a plugin-cache copy is never registered as a marketplace;
 *   - any other marketplace source (the GitHub marketplace refetches on its own), or an unreadable inventory: nothing.
 *  A removal the user asked for is respected: `captain-memo uninstall` leaves a marker that this function honours and
 *  `captain-memo install` clears (and a plugin found installed clears a stale marker). A plugin or marketplace removed
 *  by hand with `claude plugin …` leaves no marker, so it IS put back while the worker runs; CAPTAIN_MEMO_PLUGIN_HEAL=0
 *  turns the worker's call off for good. */
export async function healPluginRegistration(repoRoot: string = REPO_ROOT, deps: HealDeps = {}): Promise<HealResult> {
  const state = (deps.registration ?? (() => pluginRegistration()))();
  if (state === 'yes') { (deps.clearRemoved ?? (() => clearPluginRemoved()))(); return { healed: false, skipped: 'installed' }; }
  if (state === 'unknown') return { healed: false, skipped: 'installed_plugins.json is missing or unreadable' };
  if ((deps.removedOnPurpose ?? (() => pluginRemovedOnPurpose()))()) return { healed: false, skipped: 'removed on purpose' };
  const mk = (deps.marketplace ?? (() => marketplaceState(repoRoot)))();
  if (mk === 'other' || mk === 'unknown') return { healed: false, skipped: 'not a directory marketplace on this checkout' };
  if (mk === 'absent') {
    if (!(deps.isCheckout ?? looksLikeCheckout)(repoRoot)) return { healed: false, skipped: 'not a git checkout' };
    if (!(deps.hadPlugin ?? (() => hadPluginBefore()))()) return { healed: false, skipped: 'never installed here' };
  }
  const run = deps.run ?? (async (args: string[]) => {
    try { return await Bun.spawn(['claude', ...args], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env } }).exited; } catch { return 1; }
  });
  if (mk === 'absent' && await run(['plugin', 'marketplace', 'add', repoRoot]) !== 0) return { healed: false, skipped: 'marketplace add failed' };
  for (let i = 0; i < 3; i++) {
    if (await run(['plugin', 'install', 'captain-memo@captain-memo', '--scope', 'user']) === 0) return { healed: true };
    if (i < 2) await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 3_000));
  }
  return { healed: false, skipped: 'plugin install failed' };
}

export const CACHE_REFRESH_LOCK = '.plugin-cache-refresh.lock';
