// src/shared/plugin-cache.ts — which Claude Code plugin-cache trees are safe to reclaim.
//
// A self-upgrade (git fast-forward, or `captain-memo install`) re-points Claude Code at a NEW version
// directory under ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ and leaves the old tree on
// disk. Verified on captain `dev` 2026-08-29: captain-memo held 0.20.0 (584K) beside 0.49.0 (636K).
//
// Claude Code is not silent about this — on re-point it writes an `.orphaned_at` file (epoch ms) into
// the superseded tree and documents a 7-day grace period after which it collects it. What it does NOT
// do is actually collect: on this host `claude-mem/13.15.0` has been marked since 2026-08-16 and
// `skill-creator/6770de3f4db4` since 2026-08-17 — 13 and 12 days, both still on disk. So the marker is
// reliable evidence that a tree is superseded; only the reclaim is missing.
//
// That marker is what we prune on, NOT a version sort. It is Claude Code's own statement about its own
// cache, it carries an exact timestamp, and it works for the hash-named version dirs (`6770de3f4db4`)
// that no semver comparison can order. A "keep the active version and N-1" rule was the plan before
// the marker was found; the grace window subsumes it with real evidence instead of a heuristic.
//
// planPrune() is pure over injected facts so the delete predicate is testable without a plugin cache.
// The filesystem readers below it are the impure half; the CALLER does the deleting, never this module.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** One version directory under a plugin's cache dir. */
export interface CacheTree {
  /** Plugin dir name, e.g. 'captain-memo'. */
  plugin: string;
  /** `name` from the tree's own .claude-plugin/plugin.json — the only trustworthy identity, since a
   *  marketplace dir name need not match the plugin it vends. null when unreadable. */
  manifestName: string | null;
  /** Version dir name — semver ('0.20.0') or a commit hash ('6770de3f4db4'). Not parsed. */
  version: string;
  /** Absolute path to the version dir. */
  path: string;
  /** Epoch ms from `.orphaned_at`, or null when the file is absent/unreadable/not a number. */
  orphanedAtMs: number | null;
}

export interface PlanEntry {
  tree: CacheTree;
  prune: boolean;
  /** Why — printed verbatim in the dry-run, so every KEEP says which gate held it. */
  reason: string;
}

export interface PlanOpts {
  trees: CacheTree[];
  /** Every installPath in installed_plugins.json — ALL plugins, ALL scopes. A tree Claude Code still
   *  points at is never a candidate, whatever its marker says. */
  installedPaths: ReadonlySet<string>;
  /** Plugin roots live processes are running from. `null` means we could not look (no /proc), which
   *  is NOT the same as "none" — it protects everything rather than deleting blind. */
  livePins: ReadonlySet<string> | null;
  nowMs: number;
  /** How long a tree must have carried `.orphaned_at` before it is collectable. */
  graceMs: number;
}

const DAY_MS = 86_400_000;

/** Claude Code's own documented grace period for an orphaned version dir. Matching it means this
 *  reclaims exactly what Claude Code already promised to reclaim — nothing sooner, nothing extra. */
export const DEFAULT_GRACE_DAYS = 7;

/** Trailing separators off, backslashes to forward. Both sides of a path comparison here come from
 *  different producers (installed_plugins.json vs. a process's environ vs. readdir), and a lone
 *  trailing slash on one side would silently turn a KEEP into a DELETE. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** installPaths from installed_plugins.json. Returns null when the file cannot be parsed or carries no
 *  `plugins` map — the caller must treat that as "cannot tell what is active" and prune NOTHING. An
 *  empty set from a parseable file legitimately means no installs; null means no knowledge. */
export function parseInstalledPaths(json: string): Set<string> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (!plugins || typeof plugins !== 'object') return null;
  const out = new Set<string>();
  for (const installs of Object.values(plugins as Record<string, unknown>)) {
    if (!Array.isArray(installs)) continue;
    for (const install of installs) {
      const p = (install as { installPath?: unknown })?.installPath;
      if (typeof p === 'string' && p.length > 0) out.add(normalizePath(p));
    }
  }
  // A file that parses, lists plugins, and yields NO installPaths means the schema moved under us
  // (renamed field, nested differently — this file is already at "version": 2). Returning an empty set
  // there would silently retire the active-tree veto, which is the one gate that must never fail open.
  if (out.size === 0 && Object.keys(plugins as object).length > 0) return null;
  return out;
}

/** The CLAUDE_PLUGIN_ROOT of one process, from its raw NUL-separated environ block. */
export function pluginRootFromEnviron(environ: string): string | null {
  for (const kv of environ.split('\0')) {
    if (kv.startsWith('CLAUDE_PLUGIN_ROOT=')) {
      const v = kv.slice('CLAUDE_PLUGIN_ROOT='.length);
      return v.length > 0 ? normalizePath(v) : null;
    }
  }
  return null;
}

/** Classify every tree. Order matters: each rule is a veto, and the "cannot tell" rule fires BEFORE
 *  the live-pin rule so an unreadable process table protects the cache instead of emptying it. */
export function planPrune(opts: PlanOpts): PlanEntry[] {
  const { trees, livePins, nowMs, graceMs } = opts;
  const graceDays = Math.round(graceMs / DAY_MS);
  // Normalize the SETS here, not just the tree path. Every producer normalizes on its way out, so this
  // is belt — but the failure it guards is asymmetric: one trailing slash on a protecting path silently
  // turns a KEEP into a DELETE, and nothing downstream would notice.
  const installedPaths = new Set([...opts.installedPaths].map(normalizePath));
  const pins = livePins === null ? null : new Set([...livePins].map(normalizePath));
  return trees.map((tree) => {
    const path = normalizePath(tree.path);
    if (installedPaths.has(path)) {
      return { tree, prune: false, reason: 'active — installed_plugins.json points here' };
    }
    if (pins === null) {
      return { tree, prune: false, reason: 'cannot check live sessions on this platform — refusing to delete' };
    }
    if (pins.has(path)) {
      return { tree, prune: false, reason: 'a running process is loaded from it (CLAUDE_PLUGIN_ROOT)' };
    }
    if (tree.orphanedAtMs === null) {
      return { tree, prune: false, reason: 'not marked .orphaned_at by Claude Code' };
    }
    const ageDays = Math.floor((nowMs - tree.orphanedAtMs) / DAY_MS);
    if (nowMs - tree.orphanedAtMs < graceMs) {
      return { tree, prune: false, reason: `orphaned ${ageDays}d ago — inside the ${graceDays}d grace period` };
    }
    return { tree, prune: true, reason: `orphaned ${ageDays}d ago, past the ${graceDays}d grace period` };
  });
}

// ── filesystem readers ────────────────────────────────────────────────────────────────────────────

export const CACHE_ROOT = join(homedir(), '.claude', 'plugins', 'cache');
export const INSTALLED_PLUGINS_PATH = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');

const dirsIn = (p: string): string[] => {
  try { return readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
};

/** `name`/`version` from a plugin root's manifest, or null. */
export function readPluginManifest(root: string): { name: string; version: string | null } | null {
  try {
    const m = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf-8')) as { name?: unknown; version?: unknown };
    if (typeof m.name !== 'string') return null;
    return { name: m.name, version: typeof m.version === 'string' ? m.version : null };
  } catch { return null; }
}

/** Every version dir in the cache, across every marketplace and plugin.
 *
 *  The layout is cache/<marketplace>/<plugin>/<version>/ — a fixed depth, so this is a bounded 3-level
 *  scan rather than a general walker. Anything at that depth WITHOUT a plugin manifest (the stray
 *  `temp_git_*` checkouts Claude Code leaves in the same cache root) yields manifestName null and is
 *  therefore never matched by a name filter. */
export function readCacheTrees(cacheRoot: string = CACHE_ROOT): CacheTree[] {
  const out: CacheTree[] = [];
  for (const marketplace of dirsIn(cacheRoot)) {
    for (const plugin of dirsIn(join(cacheRoot, marketplace))) {
      for (const version of dirsIn(join(cacheRoot, marketplace, plugin))) {
        const path = join(cacheRoot, marketplace, plugin, version);
        let orphanedAtMs: number | null = null;
        try {
          const raw = readFileSync(join(path, '.orphaned_at'), 'utf-8').trim();
          const n = Number(raw);
          // `Number('')` is 0, and 0 reads as "orphaned in 1970" — past EVERY grace window. So a marker
          // truncated to zero bytes (a crash between create and write, a full disk, a read inside Claude
          // Code's own write) would delete a tree orphaned seconds ago, with no grace at all: the exact
          // tree just-re-pointed sessions are likeliest to still hold. Require a plausible ms epoch —
          // which also rejects the '0x10'/'1e5' strings that coerce to a number but mean nothing here.
          orphanedAtMs = raw !== '' && Number.isFinite(n) && n > 1_000_000_000_000 ? n : null;
        } catch { /* not orphaned, or unreadable — either way we have no marker */ }
        out.push({ plugin, manifestName: readPluginManifest(path)?.name ?? null, version, path, orphanedAtMs });
      }
    }
  }
  return out;
}

/** Active installPaths, or null when the inventory cannot be read at all (⇒ prune nothing). */
export function readInstalledPaths(file: string = INSTALLED_PLUGINS_PATH): Set<string> | null {
  try { return parseInstalledPaths(readFileSync(file, 'utf-8')); }
  catch { return null; }
}

/** One process running from a plugin root. */
export interface PluginPin { pid: number; root: string; }

/** Who owns a pinning process, from Claude Code's own session registry (~/.claude/sessions/<pid>.json).
 *
 *  The pin lands on the plugin CHILD (an MCP server), so the session is normally its PARENT — try the
 *  parent first, then the pid itself. Returns null when neither is registered.
 *
 *  `entrypoint` is the field that matters and the reason this exists: 'claude-desktop' sessions are
 *  spawned by the Desktop app and 'sdk-cli' ones by the `claude rc` daemon, so restarting rc leaves
 *  every Desktop session running its old plugin copy. Telling an operator to "restart those sessions"
 *  without naming which is how a correct remedy gets applied to the wrong daemon. */
export function describeSessionOf(
  pid: number, sessionsDir: string = join(homedir(), '.claude', 'sessions'), procRoot = '/proc',
): { entrypoint: string; name: string } | null {
  let ppid: number | null = null;
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf-8');
    // Field 4 is ppid, but comm (field 2) may contain spaces/parens — split after the final ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const n = Number(fields[1]);
    ppid = Number.isInteger(n) && n > 0 ? n : null;
  } catch { /* gone, or no /proc */ }
  for (const candidate of [ppid, pid]) {
    if (candidate === null) continue;
    try {
      const d = JSON.parse(readFileSync(join(sessionsDir, `${candidate}.json`), 'utf-8')) as { entrypoint?: unknown; name?: unknown };
      return {
        entrypoint: typeof d.entrypoint === 'string' ? d.entrypoint : 'unknown',
        name: typeof d.name === 'string' ? d.name : String(candidate),
      };
    } catch { /* not a registered session */ }
  }
  return null;
}

/** Plugin roots that live processes are running from, by scanning each process's environ for
 *  CLAUDE_PLUGIN_ROOT — the variable Claude Code exports into every hook and MCP-server child, so a
 *  session's plugin tree is visible from the outside without asking Claude Code anything.
 *
 *  Returns null where there is no /proc (macOS, Windows) — "unknown", which planPrune treats as a veto.
 *
 *  CEILING: this sees plugin CHILD processes, not the `claude` process itself (which SETS the variable
 *  for its children and does not carry it). A plugin with no long-lived child would therefore leave no
 *  pin. captain-memo always has one — its manifest declares an MCP server, so every session running
 *  from a tree holds a bun child pinning it (measured: such children alive for 3+ days on this host) —
 *  so the gate is sound for the trees this prunes. It would NOT be sound for a hooks-only plugin.
 *  ponytail: /proc only; a non-Linux captain that needs to prune needs a ps/WMI reader here. */
export function readLivePluginPins(procRoot = '/proc'): PluginPin[] | null {
  if (!existsSync(procRoot)) return null;
  const pins: PluginPin[] = [];
  for (const pid of dirsIn(procRoot)) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const root = pluginRootFromEnviron(readFileSync(join(procRoot, pid, 'environ'), 'utf-8'));
      if (root) pins.push({ pid: Number(pid), root });
    } catch { /* process exited mid-scan, or not ours to read */ }
  }
  return pins;
}

/** Just the distinct roots — what the prune's veto needs. */
export function readLivePluginRoots(procRoot = '/proc'): Set<string> | null {
  const pins = readLivePluginPins(procRoot);
  return pins === null ? null : new Set(pins.map(p => p.root));
}

/** Bytes that deleting EXACTLY `dirs` would actually give back.
 *
 *  Not a sum of file sizes. Claude Code populates a new version dir by HARDLINKING the files it shares
 *  with the previous one — measured 2026-08-29: 2056 of 2151 files in `claude-mem/13.15.0` carry more
 *  than one link, which is why `du` reports 529 MB for seven trees that are 467 MB EACH by apparent
 *  size. Summing sizes would have told an operator that removing them frees 1.4 GB when the real figure
 *  is a fraction of that — a deletion talked into on a number that cannot come true.
 *
 *  So: each inode counted once, and only when every one of its links lies inside `dirs` (removing a
 *  file the ACTIVE tree still links frees nothing). Best-effort — an unreadable child contributes 0. */
export function reclaimableBytes(dirs: string[]): number {
  const inodes = new Map<string, { size: number; nlink: number; links: number }>();
  const walk = (p: string): void => {
    let entries: import('fs').Dirent[] = [];
    try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = join(p, e.name);
      if (e.isDirectory()) { walk(child); continue; }
      if (!e.isFile()) continue;                       // symlinks are not followed and free nothing here
      try {
        const st = statSync(child);
        const key = `${st.dev}:${st.ino}`;
        const seen = inodes.get(key);
        if (seen) seen.links++;
        else inodes.set(key, { size: st.size, nlink: st.nlink, links: 1 });
      } catch { /* vanished mid-walk */ }
    }
  };
  for (const dir of dirs) walk(dir);
  let total = 0;
  for (const e of inodes.values()) if (e.links >= e.nlink) total += e.size;
  return total;
}
