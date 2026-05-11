import { describe, test, expect, beforeEach } from 'bun:test';
import {
  detectBranchSync,
  detectBranchSyncCached,
  _resetBranchCache,
  branchCache,
  BRANCH_CACHE_TTL_MS,
} from '../../src/worker/branch.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Flush the TTL cache before each test so cases don't bleed into each other.
beforeEach(() => _resetBranchCache());

describe('detectBranchSync', () => {
  test('returns branch name inside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-branch-test-'));
    try {
      execSync('git init -b feature/widget', { cwd: dir });
      execSync('git commit --allow-empty -m init', { cwd: dir });
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
      execSync('git init', { cwd: dir });
      execSync('git commit --allow-empty -m init', { cwd: dir });
      const sha = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
      execSync(`git checkout ${sha}`, { cwd: dir });
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
      execSync('git init -b feature/cached', { cwd: dir });
      execSync('git commit --allow-empty -m init', { cwd: dir });

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
    execSync('git init -b feature/cached', { cwd: dir });
    execSync('git commit --allow-empty -m init', { cwd: dir });

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
      execSync('git init -b feature/cached', { cwd: dir });
      execSync('git commit --allow-empty -m init', { cwd: dir });

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
