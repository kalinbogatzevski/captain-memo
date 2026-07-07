import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Resolve the current git branch for a working directory.
 * Returns null when:
 *   - the path doesn't exist
 *   - the path is not inside a git repo
 *   - git is not installed
 *   - any error occurs (we never throw — branch capture is best-effort)
 *
 * Detached HEAD returns the literal "HEAD" — that's what `git rev-parse
 * --abbrev-ref HEAD` produces in that state. We store it as-is rather than
 * inventing a different convention.
 */
export function detectBranchSync(cwd: string): string | null {
  if (!existsSync(cwd)) return null;
  try {
    const result = spawnSync(
      'git',
      ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf-8', timeout: 2000 },
    );
    if (result.status !== 0) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// ─── TTL cache for detectBranchSync ──────────────────────────────────────────
// Repeated calls within BRANCH_CACHE_TTL_MS skip the git spawn entirely.
// Cache key is the cwd string; value holds the resolved branch and an expiry.
// The uncached detectBranchSync is kept for callers that need a fresh read
// every time (e.g. hook capture in post-tool-use.ts).

export const BRANCH_CACHE_TTL_MS = 60_000;

interface BranchCacheEntry {
  branch: string | null;
  expires_at_ms: number;
}

// Exported so tests can flush it between cases via _resetBranchCache().
export const branchCache = new Map<string, BranchCacheEntry>();

/** Test-only helper — clears the in-memory TTL cache. */
export function _resetBranchCache(): void {
  branchCache.clear();
}

/**
 * Like detectBranchSync, but memoises the result per cwd for BRANCH_CACHE_TTL_MS.
 * Use this on hot search paths to avoid a git spawn per request.
 * Hook-capture paths should keep using the uncached detectBranchSync.
 */
export function detectBranchSyncCached(cwd: string): string | null {
  const now = Date.now();
  const cached = branchCache.get(cwd);
  if (cached && cached.expires_at_ms > now) return cached.branch;
  const branch = detectBranchSync(cwd);
  branchCache.set(cwd, { branch, expires_at_ms: now + BRANCH_CACHE_TTL_MS });
  return branch;
}

/** Resolve the physical working-tree root for a path (git rev-parse --show-toplevel).
 *  null when the path is missing, not in a git repo, git absent, or any error. Never throws. */
export function detectRepoRootSync(cwd: string): string | null {
  if (!existsSync(cwd)) return null;
  try {
    const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8', timeout: 2000 });
    if (result.status !== 0) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch { return null; }
}

/** Working-tree dirtiness via `git status --porcelain`. is_dirty = any output; staged = any entry
 *  whose first (index) column is not space or '?'. Never throws → {false,false} on any error. */
export function detectDirtySync(repoRoot: string): { is_dirty: boolean; staged: boolean } {
  if (!existsSync(repoRoot)) return { is_dirty: false, staged: false };
  try {
    const result = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf-8', timeout: 2000 });
    if (result.status !== 0) return { is_dirty: false, staged: false };
    const lines = result.stdout.split('\n').filter((l) => l.length > 0);
    const is_dirty = lines.length > 0;
    const staged = lines.some((l) => l[0] !== ' ' && l[0] !== '?');
    return { is_dirty, staged };
  } catch { return { is_dirty: false, staged: false }; }
}
