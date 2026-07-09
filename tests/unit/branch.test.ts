import { describe, test, expect, beforeEach } from 'bun:test';
import {
  detectBranchSync,
  detectBranchSyncCached,
  _resetBranchCache,
  branchCache,
  BRANCH_CACHE_TTL_MS,
  detectRepoRootSync,
  detectRepoRootSyncCached,
  _resetRepoRootCache,
  repoRootCache,
  detectDirtySync,
  detectDirtySyncCached,
  _resetDirtyCache,
  dirtyCache,
  DIRTY_CACHE_TTL_MS,
} from '../../src/worker/branch.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';

// CI runners have no git user.name/email configured and — unlike a dev box —
// git won't auto-derive one there, so `git commit` aborts with "Please tell me
// who you are." Supply an identity via env on every git call so these tests are
// hermetic: they pass regardless of the runner's global/system git config.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Captain Memo Test',
  GIT_AUTHOR_EMAIL: 'test@captain-memo.local',
  GIT_COMMITTER_NAME: 'Captain Memo Test',
  GIT_COMMITTER_EMAIL: 'test@captain-memo.local',
};
function git(cmd: string, dir: string): Buffer {
  return execSync(cmd, { cwd: dir, env: GIT_ENV });
}

// Flush the TTL caches before each test so cases don't bleed into each other.
beforeEach(() => {
  _resetBranchCache();
  _resetRepoRootCache();
  _resetDirtyCache();
});

describe('detectBranchSync', () => {
  test('returns branch name inside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-branch-test-'));
    try {
      git('git init -b feature/widget', dir);
      git('git commit --allow-empty -m init', dir);
      expect(detectBranchSync(dir)).toBe('feature/widget');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null when cwd is not a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-branch-test-'));
    try {
      expect(detectBranchSync(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null when cwd does not exist', () => {
    expect(detectBranchSync('/nonexistent/path/captain-memo-test')).toBeNull();
  });

  test('returns HEAD literal when detached', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-branch-test-'));
    try {
      git('git init', dir);
      git('git commit --allow-empty -m init', dir);
      const sha = git('git rev-parse HEAD', dir).toString().trim();
      git(`git checkout ${sha}`, dir);
      expect(detectBranchSync(dir)).toBe('HEAD');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('detectBranchSyncCached', () => {
  test('first call misses cache and resolves branch from git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-branch-cache-'));
    try {
      git('git init -b feature/cached', dir);
      git('git commit --allow-empty -m init', dir);

      expect(branchCache.has(dir)).toBe(false);
      const branch = detectBranchSyncCached(dir);
      expect(branch).toBe('feature/cached');
      // Cache is now populated
      expect(branchCache.has(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('second call within TTL returns cached value without spawning git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-branch-cache-'));
    git('git init -b feature/cached', dir);
    git('git commit --allow-empty -m init', dir);

    const first = detectBranchSyncCached(dir);
    expect(first).toBe('feature/cached');

    // Delete the repo. If the cache works, the next call within TTL still
    // returns the cached value without trying to re-spawn git.
    rmSync(dir, { recursive: true, force: true });
    const second = detectBranchSyncCached(dir);
    expect(second).toBe('feature/cached');
  });

  test('after TTL expires the cache entry is refreshed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-branch-cache-'));
    try {
      git('git init -b feature/cached', dir);
      git('git commit --allow-empty -m init', dir);

      detectBranchSyncCached(dir);

      // Manually backdate the cached entry so it looks expired.
      const entry = branchCache.get(dir)!;
      branchCache.set(dir, { ...entry, expires_at_ms: Date.now() - 1 });

      // The next call must re-resolve from git (branch still exists, so it
      // should return the same value — what matters is it didn't use the stale entry).
      const refreshed = detectBranchSyncCached(dir);
      expect(refreshed).toBe('feature/cached');

      // Confirm the cache entry was refreshed with a new expiry.
      const updated = branchCache.get(dir)!;
      expect(updated.expires_at_ms).toBeGreaterThan(Date.now() + BRANCH_CACHE_TTL_MS - 1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function tmpRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'wb-repo-'));
  execFileSync('git', ['-C', d, 'init', '-q']);
  execFileSync('git', ['-C', d, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', d, 'config', 'user.name', 't']);
  writeFileSync(join(d, 'a.txt'), 'x');
  execFileSync('git', ['-C', d, 'add', 'a.txt']);
  execFileSync('git', ['-C', d, 'commit', '-qm', 'init']);
  // Return git's OWN canonical form of the root, not the raw mkdtemp path: on Windows CI, tmpdir() is the 8.3
  // short name (…\RUNNER~1\…) with backslashes while `git rev-parse --show-toplevel` emits the long name with
  // forward slashes, so comparing detectRepoRootSync() output against a raw temp path mismatches. Canonicalising
  // here makes every `.toBe(root)` assertion platform-robust (also handles a symlinked /tmp on macOS).
  return detectRepoRootSync(d) ?? d;
}

test('detectRepoRootSync returns the working-tree root, null outside a repo', () => {
  const d = tmpRepo();
  mkdirSync(join(d, 'sub'));
  expect(detectRepoRootSync(join(d, 'sub'))).toBe(d);          // resolves from a subdir
  expect(detectRepoRootSync(tmpdir())).toBeNull();             // tmpdir itself is not a repo
});

test('detectDirtySync reports clean, dirty, and staged', () => {
  const d = tmpRepo();
  expect(detectDirtySync(d)).toEqual({ is_dirty: false, staged: false });
  writeFileSync(join(d, 'b.txt'), 'y');                        // untracked → dirty, not staged
  expect(detectDirtySync(d)).toEqual({ is_dirty: true, staged: false });
  execFileSync('git', ['-C', d, 'add', 'b.txt']);             // staged
  expect(detectDirtySync(d)).toEqual({ is_dirty: true, staged: true });
});

describe('detectRepoRootSyncCached', () => {
  test('first call misses cache and resolves root from git', () => {
    const d = tmpRepo();
    try {
      expect(repoRootCache.has(d)).toBe(false);
      const root = detectRepoRootSyncCached(d);
      expect(root).toBe(d);
      expect(repoRootCache.has(d)).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('second call within TTL returns cached value without re-spawning git', () => {
    const d = tmpRepo();
    const first = detectRepoRootSyncCached(d);
    expect(first).toBe(d);

    // Delete the repo. If the cache works, the next call within TTL still
    // returns the cached value without trying to re-spawn git.
    rmSync(d, { recursive: true, force: true });
    const second = detectRepoRootSyncCached(d);
    expect(second).toBe(d);
  });

  test('after TTL expires the cache entry is refreshed', () => {
    const d = tmpRepo();
    try {
      detectRepoRootSyncCached(d);

      // Manually backdate the cached entry so it looks expired.
      const entry = repoRootCache.get(d)!;
      repoRootCache.set(d, { ...entry, expires_at_ms: Date.now() - 1 });

      const refreshed = detectRepoRootSyncCached(d);
      expect(refreshed).toBe(d);

      const updated = repoRootCache.get(d)!;
      expect(updated.expires_at_ms).toBeGreaterThan(Date.now() + BRANCH_CACHE_TTL_MS - 1000);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('detectDirtySyncCached', () => {
  test('first call misses cache and resolves dirty state from git', () => {
    const d = tmpRepo();
    try {
      expect(dirtyCache.has(d)).toBe(false);
      const result = detectDirtySyncCached(d);
      expect(result).toEqual({ is_dirty: false, staged: false });
      expect(dirtyCache.has(d)).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('second call within TTL returns cached value without re-spawning git', () => {
    const d = tmpRepo();
    try {
      const first = detectDirtySyncCached(d);
      expect(first).toEqual({ is_dirty: false, staged: false });

      // Dirty the tree. If the cache works, the next call within TTL still
      // returns the stale cached result rather than re-probing git.
      writeFileSync(join(d, 'b.txt'), 'y');
      const second = detectDirtySyncCached(d);
      expect(second).toEqual({ is_dirty: false, staged: false });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('after TTL expires the cache entry is refreshed', () => {
    const d = tmpRepo();
    try {
      detectDirtySyncCached(d);
      writeFileSync(join(d, 'b.txt'), 'y');

      // Manually backdate the cached entry so it looks expired.
      const entry = dirtyCache.get(d)!;
      dirtyCache.set(d, { ...entry, expires_at_ms: Date.now() - 1 });

      const refreshed = detectDirtySyncCached(d);
      expect(refreshed).toEqual({ is_dirty: true, staged: false });

      const updated = dirtyCache.get(d)!;
      expect(updated.expires_at_ms).toBeGreaterThan(Date.now() + DIRTY_CACHE_TTL_MS - 1000);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
