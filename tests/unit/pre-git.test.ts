import { test, expect } from 'bun:test';
import { parseGitOp } from '../../src/hooks/pre-git.ts';

test('parseGitOp detects mutating subcommands, ignores read-only + non-git', () => {
  expect(parseGitOp('git checkout master')).toBe('checkout');
  expect(parseGitOp('git switch -c feat')).toBe('switch');
  expect(parseGitOp('cd /proj && git commit -m x')).toBe('commit');
  expect(parseGitOp('GIT_PAGER=cat git reset --hard')).toBe('reset');
  expect(parseGitOp('git status')).toBeNull();
  expect(parseGitOp('git log --oneline')).toBeNull();
  expect(parseGitOp('ls -la')).toBeNull();
  expect(parseGitOp('echo git commit')).toBeNull();   // not an invoked git
});

test('parseGitOp skips value-taking global flags (-C <dir>, -c <name=value>) to find the subcommand', () => {
  expect(parseGitOp('git -C /repo checkout main')).toBe('checkout');
  expect(parseGitOp('git -c user.name=x commit')).toBe('commit');
});
