// src/worker/self-updater.ts — OSS opt-in self-update mechanics (git, fast-forward only).
//
// A local *git-clone* install does NOT auto-update: Claude Code only re-fetches marketplace
// installs, so a clone sits on old code until someone runs `git pull` + `captain-memo install`.
// This adds an OPT-IN autonomous updater for those installs (marketplace installs already
// self-update and are left untouched). Enable with CAPTAIN_MEMO_AUTO_UPDATE=1.
//
// Two hard safety rules, enforced here regardless of anything the caller does:
//   • never touch a DIRTY work-tree or a detached HEAD — no clobbering local edits, no surprise merge;
//   • FAST-FORWARD ONLY to a STABLE vX.Y.Z tag on the clone's OWN `origin` — never a merge/rebase,
//     never a pre-release tag, never a ref chosen by anything but the clone's own remote.
//
// All git goes through an injected port, so the whole unit is testable with NO real git. This is a
// deliberate re-lift of the federation self-updater's git path (which cannot be shared directly —
// it lives under src/worker/federation/, which the moat forbids on master), trimmed to OSS's needs:
// tag-track only, no hub trigger, no operator command path.

import { compareSemver } from '../shared/self-update.ts';

/** Default gap between update checks. A check does a `git fetch`, so running it every session
 *  would hit the network on every prompt-0; 6h keeps clones current without hammering origin. */
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Pure throttle: has enough time passed since the last check? lastCheckMs=null ⇒ never checked ⇒ due. */
export function isUpdateCheckDue(lastCheckMs: number | null, nowMs: number, intervalMs: number): boolean {
  if (lastCheckMs === null) return true;
  return nowMs - lastCheckMs >= intervalMs;
}

export interface ExecResult { code: number; stdout: string; stderr: string; }

export interface UpdaterPort {
  /** Run argv in cwd; resolve with exit code + captured output. NEVER throws (failure ⇒ nonzero code).
   *  timeoutMs is per-call: a short cap suits `git fetch` (mustn't hang session start) but `bun install`
   *  needs room — the caller passes the right budget per command. */
  run: (argv: string[], cwd: string, timeoutMs?: number) => ExecResult;
  /** Read "version" from <dir>/package.json, or null if unreadable. Reports the post-update version. */
  readPackageVersion: (dir: string) => string | null;
  /** Read "name" from <dir>/package.json. Used to confirm the resolved repo is actually captain-memo. */
  readPackageName: (dir: string) => string | null;
}

export interface UpdateTarget { ref: string; version: string; }

export interface ApplyResult {
  ok: boolean;
  from: string;
  to?: string;
  /** The pre-update HEAD sha, so the caller can `git reset --hard` back if the new code fails to boot. */
  priorSha?: string;
  /** On failure: 'not_a_checkout' | 'dirty_tree' | 'detached_head' | 'pull_failed' | 'wrong_repo' | 'no_origin'. */
  code?: string;
  reason?: string;
}

/** A ref name safe to hand to git as a positional. git parses a leading-dash argument as an OPTION
 *  even after a remote positional (`git fetch origin --upload-pack=…` → arbitrary exec), so any branch
 *  or tag whose name starts with '-' is refused outright. Belt to the argv-array's braces. */
function isSafeRefName(name: string): boolean {
  return name.length > 0 && !name.startsWith('-');
}

/** Tag names origin ACTUALLY vends right now, from `git ls-remote --tags origin`. This is the origin
 *  provenance gate: `git tag --list` returns the whole flat local tag namespace (tags fetched from ANY
 *  remote, or created locally), so a fork-added `v99.0.0` would otherwise be eligible. We only consider
 *  tags in this set — and since pickUpdateTarget just ran `git fetch --tags --force origin`, a name in
 *  this set has origin's exact sha locally. Empty set (offline / no tags) ⇒ nothing selectable. */
function originTagNames(port: UpdaterPort, installDir: string): Set<string> {
  const names = new Set<string>();
  const ls = port.run(['git', 'ls-remote', '--tags', 'origin'], installDir);
  if (ls.code !== 0) return names;
  for (const line of ls.stdout.split('\n')) {
    const m = /\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line);   // strip the ^{} deref suffix on annotated tags
    if (m && m[1]) names.add(m[1]);
  }
  return names;
}

/** Is this install a git checkout we can fast-forward? Best-effort over the port. */
export function isGitCheckout(port: UpdaterPort, installDir: string): boolean {
  const top = port.run(['git', 'rev-parse', '--show-toplevel'], installDir);
  return top.code === 0 && top.stdout.trim().length > 0;
}

/** The clone's `origin` URL, or null. OSS auto-update fetches tags from origin; without one there
 *  is nothing to update from. (Unlike federation, OSS does NOT care whether origin is GitHub — the
 *  release tags live wherever the user cloned from; pickUpdateTarget simply finds none if absent.) */
export function originUrl(port: UpdaterPort, installDir: string): string | null {
  const r = port.run(['git', 'remote', 'get-url', 'origin'], installDir);
  const url = r.code === 0 ? r.stdout.trim() : '';
  return url.length > 0 ? url : null;
}

/**
 * Resolve the newest ff-safe, STRICTLY-newer stable release tag to advance to, or null if already
 * current / nothing ff-reachable / not a checkout. Fetches tags first (best-effort) so it sees remote
 * state. We advance the current BRANCH pointer by fast-forward — never detach onto the tag.
 */
export function pickUpdateTarget(port: UpdaterPort, installDir: string, runningVersion: string): UpdateTarget | null {
  const branchRes = port.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], installDir);
  const branch = branchRes.stdout.trim();
  if (branchRes.code !== 0 || !branch || branch === 'HEAD') return null;   // detached / unknown → don't touch
  if (!isSafeRefName(branch)) return null;                                 // dash-named branch → refuse (arg-injection)

  // Fetch tags from origin only (NO branch positional — dropping it removes the arg-injection surface
  // entirely, and tag discovery doesn't need it). --force so origin's tags win over any local shadow.
  port.run(['git', 'fetch', '--tags', '--force', 'origin'], installDir, 20_000);   // best-effort
  const originTags = originTagNames(port, installDir);
  if (originTags.size === 0) return null;                                  // origin vends no tags we can trust

  let best: UpdateTarget | null = null;
  for (const tag of originTags) {
    // STABLE vX.Y.Z only. The `$` anchor rejects pre-release / build tags (v0.11.0-rc1, v0.11.0+build):
    // compareSemver strips a -suffix, so without this an rc could out-rank (or mask) the stable release.
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) continue;
    if (compareSemver(tag, runningVersion) !== 1) continue;             // strictly newer than running
    if (best && compareSemver(tag, best.version) !== 1) continue;       // keep the newest candidate
    const anc = port.run(['git', 'merge-base', '--is-ancestor', 'HEAD', tag], installDir);
    if (anc.code !== 0) continue;                                       // HEAD must fast-forward to the tag
    best = { ref: tag, version: tag };
  }
  return best;
}

/** Reset the regenerable plugin/dist bundle to HEAD before the clean-tree gate. A clone never builds
 *  dist (the worker runs from src, the plugin loads the committed bundle), so any local dist diff is
 *  stale build output — safe to discard, and it would otherwise false-trip the clean-tree gate on
 *  every update. SURGICAL: only plugin/dist. Best-effort. */
function resetBuildOutput(port: UpdaterPort, installDir: string): void {
  port.run(['git', 'checkout', '--', 'plugin/dist'], installDir);
}

/** Fast-forward the current branch to `ref` (a stable tag from pickUpdateTarget). Same hard gates as
 *  the design promises: clean tree, never detached, ff-ONLY. NEVER throws. On ok:true the caller runs
 *  `bun install` then restarts the worker so the new code loads. */
export function applyUpdateToRef(port: UpdaterPort, installDir: string, ref: string, fromVersion: string): ApplyResult {
  if (!isGitCheckout(port, installDir)) return { ok: false, from: fromVersion, code: 'not_a_checkout', reason: 'not a git checkout' };
  if (!isSafeRefName(ref)) return { ok: false, from: fromVersion, code: 'pull_failed', reason: 'unsafe ref name' };  // defense-in-depth
  resetBuildOutput(port, installDir);

  const status = port.run(['git', 'status', '--porcelain'], installDir);
  if (status.code !== 0) return { ok: false, from: fromVersion, code: 'dirty_tree', reason: 'git status failed' };
  if (status.stdout.trim().length > 0) return { ok: false, from: fromVersion, code: 'dirty_tree', reason: 'working tree not clean — refusing to auto-update over local edits' };

  const branchRes = port.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], installDir);
  const branch = branchRes.stdout.trim();
  if (branchRes.code !== 0 || !branch || branch === 'HEAD') return { ok: false, from: fromVersion, code: 'detached_head', reason: 'detached HEAD or unknown branch' };

  // Capture the pre-merge HEAD so the caller can roll back if the new code fails to boot.
  const headRes = port.run(['git', 'rev-parse', 'HEAD'], installDir);
  const priorSha = headRes.code === 0 ? headRes.stdout.trim() : '';

  const merge = port.run(['git', 'merge', '--ff-only', ref], installDir);
  if (merge.code !== 0) return { ok: false, from: fromVersion, code: 'pull_failed', reason: ((merge.stderr || merge.stdout) || '').slice(0, 240) };

  const to = port.readPackageVersion(installDir);
  return { ok: true, from: fromVersion, ...(to ? { to } : {}), ...(priorSha ? { priorSha } : {}) };
}

/** `bun install` after a fast-forward, so new/changed deps are present before the worker restart.
 *  Spawns via the ABSOLUTE bunPath (the caller passes process.execPath — the running interpreter) —
 *  NEVER the bare name 'bun', which resolves via PATH and exits 127 under a service whose PATH lacks
 *  ~/.bun/bin. Its OWN generous timeout — a real dep install pulls from the registry and must not be
 *  killed at the short `git fetch` budget (which would leave node_modules half-written). NEVER throws. */
export function installDeps(port: UpdaterPort, installDir: string, bunPath: string): ExecResult {
  return port.run([bunPath, 'install'], installDir, 300_000);
}

/** Roll the checkout back to `sha` (the pre-update HEAD) after a failed boot. Hard reset — the tree was
 *  clean before we touched it (the clean-tree gate guaranteed that), so nothing of the user's is lost.
 *  Reinstalls old deps too, since the failed update's `bun install` may have changed node_modules. */
export function rollbackTo(port: UpdaterPort, installDir: string, sha: string, bunPath: string): boolean {
  if (!isSafeRefName(sha)) return false;
  const reset = port.run(['git', 'reset', '--hard', sha], installDir);
  if (reset.code !== 0) return false;
  installDeps(port, installDir, bunPath);   // best-effort — restore the old lockfile's deps
  return true;
}

/**
 * Orchestrate one opt-in auto-update pass: confirm this is the captain-memo checkout, pick the newest
 * ff-safe stable tag on origin, fast-forward, `bun install`. Returns from/to/priorSha on success (caller
 * restarts the worker, verifies health, and rolls back via priorSha if it doesn't boot), or null when
 * there's nothing to do. NEVER throws. `installFailed` marks a successful ff whose deps step failed.
 */
export function runAutoUpdate(
  port: UpdaterPort, installDir: string, runningVersion: string, bunPath: string,
): (ApplyResult & { installFailed?: boolean }) | null {
  try {
    if (!isGitCheckout(port, installDir)) return null;                 // marketplace / non-git install → not our job
    // Repo-identity gate: `git rev-parse --show-toplevel` from a marketplace install nested inside an
    // unrelated git repo (e.g. ~/.claude under dotfiles VCS) would resolve to THAT repo. Only ever
    // touch a checkout whose package.json says it's captain-memo.
    if (port.readPackageName(installDir) !== 'captain-memo') return null;
    if (originUrl(port, installDir) === null) return null;             // nothing to fetch from
    const target = pickUpdateTarget(port, installDir, runningVersion);
    if (!target) return null;                                          // already current or nothing ff-reachable
    const applied = applyUpdateToRef(port, installDir, target.ref, runningVersion);
    if (!applied.ok) return applied;                                   // gate refused (dirty, detached, …) — caller logs
    const deps = installDeps(port, installDir, bunPath);
    return deps.code === 0 ? applied : { ...applied, installFailed: true };
  } catch {
    return null;   // fail-open: an auto-update pass must never break session start
  }
}
