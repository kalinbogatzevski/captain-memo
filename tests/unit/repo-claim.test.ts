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
