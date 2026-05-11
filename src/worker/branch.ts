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
