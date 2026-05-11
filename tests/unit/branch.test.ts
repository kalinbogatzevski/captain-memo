import { describe, test, expect } from 'bun:test';
import { detectBranchSync } from '../../src/worker/branch.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

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
