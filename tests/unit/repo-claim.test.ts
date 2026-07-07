import { test, expect } from 'bun:test';
import { resolveRepoClaim } from '../../src/worker/repo-claim.ts';

const deps = {
  detectRepoRootSync: (p: string) => p.includes('/claude-1000/') ? '/home/u/tmp/claude-1000/x/scratchpad'
    : p.startsWith('/proj/erp') ? '/proj/erp' : null,
  detectBranchSync: () => 'master',
  detectDirtySync: () => ({ is_dirty: true, staged: false }),
};

test('stamps a real shared checkout', () => {
  expect(resolveRepoClaim(['/proj/erp/hr/functions.php'], deps)).toEqual({ repo_root: '/proj/erp', branch: 'master', is_dirty: true });
});
test('skips scratchpad paths (root contains /claude-1000/)', () => {
  expect(resolveRepoClaim(['/home/u/tmp/claude-1000/x/scratchpad/a.ts'], deps)).toEqual({});
});
test('no repo → empty', () => {
  expect(resolveRepoClaim(['/tmp/loose.txt'], deps)).toEqual({});
});
test('ignores relative globs (no absolute path to resolve)', () => {
  expect(resolveRepoClaim(['src/**', 'billing/*.ts'], deps)).toEqual({});
});

test('dedupes dirnames: probes each unique dir at most once, not once per file', () => {
  let calls = 0;
  const countingDeps = {
    detectRepoRootSync: (p: string) => { calls++; return p.startsWith('/scratch/a') || p.startsWith('/scratch/b') ? null : null; },
    detectBranchSync: () => 'master',
    detectDirtySync: () => ({ is_dirty: false, staged: false }),
  };
  const files = [
    '/scratch/a/one.ts', '/scratch/a/two.ts', '/scratch/a/three.ts',
    '/scratch/b/four.ts', '/scratch/b/five.ts',
  ];
  expect(resolveRepoClaim(files, countingDeps)).toEqual({});
  expect(calls).toBe(2); // 2 distinct dirs (/scratch/a, /scratch/b), not 5 files
});
