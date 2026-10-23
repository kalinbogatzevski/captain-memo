// The per-clone pre-push moat hook (.githooks/pre-push) must judge the COMMIT a ref points at: not the ref's name and not the working tree.
// 2026-10-23 a tag named v0.58.6 on a federation commit slipped through (the hook matched only `*/federation` and `fed-v*`, and for a new
// ref compared the sha with the working tree) and published 1347 federation commits to github. Each case builds a throwaway repo; the hook
// is run directly with the stdin git gives it. POSIX only: it is a bash script.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOOK = join(import.meta.dir, '..', '..', '.githooks', 'pre-push');
const ZERO = '0'.repeat(40);
const GITHUB = 'https://github.com/example/repo.git';
const GITLAB = 'https://gitlab.example.com/example/repo.git';

describe.skipIf(process.platform === 'win32')('pre-push moat hook', () => {
  function repo(): { dir: string; git: (...a: string[]) => string; commit: (msg: string, files: Record<string, string | null>) => string } {
    const dir = mkdtempSync(join(tmpdir(), 'prepush-'));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', HOME: dir };
    const git = (...a: string[]): string => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { cwd: dir, env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    const commit = (msg: string, files: Record<string, string | null>): string => {
      for (const [p, body] of Object.entries(files)) {
        if (body === null) git('rm', '-q', p);
        else { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), body); git('add', p); }
      }
      git('commit', '-q', '-m', msg);
      return git('rev-parse', 'HEAD');
    };
    return { dir, git, commit };
  }
  const run = (dir: string, remote: string, url: string, line: string): number =>
    spawnSync('bash', [HOOK, remote, url], { cwd: dir, input: line + '\n', encoding: 'utf8' }).status ?? -1;

  test('blocks a tag with an innocent name whose tip carries federation code, and allows a clean one', () => {
    const r = repo();
    try {
      const clean = r.commit('oss', { 'a.txt': 'a' });
      const fed = r.commit('fed', { 'src/worker/federation/x.ts': 'x' });
      expect(run(r.dir, 'github', GITHUB, `refs/tags/v9.9.9 ${fed} refs/tags/v9.9.9 ${ZERO}`)).toBe(1);
      expect(run(r.dir, 'github', GITHUB, `refs/heads/whatever ${fed} refs/heads/whatever ${ZERO}`)).toBe(1);
      expect(run(r.dir, 'github', GITHUB, `refs/tags/v9.9.9 ${clean} refs/tags/v9.9.9 ${ZERO}`)).toBe(0);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  test('judges an annotated tag by the commit it points at', () => {
    const r = repo();
    try {
      const clean = r.commit('oss', { 'a.txt': 'a' });
      r.git('tag', '-a', 'v1', '-m', 'v1', clean);
      const cleanTag = r.git('rev-parse', 'v1');
      const fed = r.commit('fed', { 'src/worker/federation/x.ts': 'x' });
      r.git('tag', '-a', 'v2', '-m', 'v2', fed);
      const fedTag = r.git('rev-parse', 'v2');
      expect(run(r.dir, 'github', GITHUB, `refs/tags/v1 ${cleanTag} refs/tags/v1 ${ZERO}`)).toBe(0);
      expect(run(r.dir, 'github', GITHUB, `refs/tags/v2 ${fedTag} refs/tags/v2 ${ZERO}`)).toBe(1);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  test('blocks a clean tip whose history ever added federation code, whatever a local remote-tracking ref claims', () => {
    const r = repo();
    try {
      r.commit('oss', { 'a.txt': 'a' });
      r.commit('fed', { 'src/worker/federation/x.ts': 'x' });
      const tip = r.commit('drop fed', { 'src/worker/federation/x.ts': null });
      expect(run(r.dir, 'github', GITHUB, `refs/heads/main ${tip} refs/heads/main ${ZERO}`)).toBe(1);
      expect(run(r.dir, 'github', GITHUB, `refs/heads/main ${tip} refs/heads/main ${tip}`)).toBe(1);
      r.git('update-ref', 'refs/remotes/github/main', tip);   // a stale or hand-made tracking ref must not excuse it
      expect(run(r.dir, 'github', GITHUB, `refs/heads/main ${tip} refs/heads/main ${ZERO}`)).toBe(1);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  test('sees federation commits on the side of a merge that git log would simplify away', () => {
    const r = repo();
    try {
      r.commit('oss', { 'a.txt': 'a' });
      r.git('checkout', '-q', '-b', 'side');
      r.commit('fed', { 'src/worker/federation/x.ts': 'x' });
      r.commit('drop fed', { 'src/worker/federation/x.ts': null });
      r.git('checkout', '-q', 'main');
      r.commit('more oss', { 'a.txt': 'b' });
      r.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      const tip = r.git('rev-parse', 'HEAD');
      // the merge result is TREESAME to its first parent for the federation directory: `git log -- dir` follows that parent only
      expect(r.git('log', '--format=%h', '-n', '1', tip, '--', 'src/worker/federation')).toBe('');
      expect(run(r.dir, 'github', GITHUB, `refs/heads/main ${tip} refs/heads/main ${ZERO}`)).toBe(1);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  test('refuses a ref to anything but a commit (a tag of a tree or a blob cannot be judged)', () => {
    const r = repo();
    try {
      r.commit('fed', { 'src/worker/federation/x.ts': 'x' });
      const tree = r.git('rev-parse', 'HEAD^{tree}');
      const blob = r.git('rev-parse', 'HEAD:src/worker/federation/x.ts');
      r.git('tag', 't-tree', tree);
      r.git('tag', '-a', 't-blob', '-m', 'b', blob);
      const tagObj = r.git('rev-parse', 't-blob');
      expect(run(r.dir, 'github', GITHUB, `refs/tags/t-tree ${tree} refs/tags/t-tree ${ZERO}`)).toBe(1);
      expect(run(r.dir, 'github', GITHUB, `refs/tags/t-blob ${tagObj} refs/tags/t-blob ${ZERO}`)).toBe(1);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  test('keeps the name rules, lets deletions and non-github remotes through', () => {
    const r = repo();
    try {
      const clean = r.commit('oss', { 'a.txt': 'a' });
      const fed = r.commit('fed', { 'src/worker/federation/x.ts': 'x' });
      expect(run(r.dir, 'github', GITHUB, `refs/heads/federation ${clean} refs/heads/federation ${ZERO}`)).toBe(1);
      expect(run(r.dir, 'github', GITHUB, `refs/tags/fed-v1.0.0 ${clean} refs/tags/fed-v1.0.0 ${ZERO}`)).toBe(1);
      expect(run(r.dir, 'github', GITHUB, `(delete) ${ZERO} refs/tags/old ${clean}`)).toBe(0);
      expect(run(r.dir, 'gitlab', GITLAB, `refs/tags/fed-v1.0.0 ${fed} refs/tags/fed-v1.0.0 ${ZERO}`)).toBe(0);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
});
