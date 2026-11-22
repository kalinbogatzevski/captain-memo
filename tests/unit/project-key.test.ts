import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import { findRepo, projectKey, projectAliases } from '../../src/shared/project-key.ts';

// A fake home holding:
//   code/shop/.git/                         a plain repo, with two registered worktrees
//   code/shop/.claude/worktrees/feature-x   a worktree inside the repo (how Claude Code makes them)
//   code/shop-codex                         a sibling worktree (how a Codex run makes them), written with relative paths
//   code/api.git + code/api-main            a bare repository and a worktree of it
//   code/shop/vendor/lib                    a submodule
//   code/plain/src                          a folder that is not in any repo
let home: string;
let shop: string, insideWt: string, siblingWt: string, plain: string, bare: string, bareWt: string, submodule: string;

/** What `git worktree add` writes: <common>/worktrees/<name>/{gitdir,commondir} and the worktree's .git file. */
function addWorktree(commonDir: string, name: string, wtDir: string, opts: { relative?: boolean; slashes?: boolean } = {}): void {
  const admin = join(commonDir, 'worktrees', name);
  mkdirSync(admin, { recursive: true });
  mkdirSync(wtDir, { recursive: true });
  const fmt = (p: string) => (opts.slashes ? p.replace(/\\/g, '/') : p);
  writeFileSync(join(admin, 'commondir'), fmt(relative(admin, commonDir)) + '\n');
  writeFileSync(join(admin, 'gitdir'), fmt(opts.relative ? relative(admin, join(wtDir, '.git')) : join(wtDir, '.git')) + '\n');
  writeFileSync(join(wtDir, '.git'), `gitdir: ${fmt(opts.relative ? relative(wtDir, admin) : admin)}\n`);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'cm-projkey-'));
  shop = join(home, 'code', 'shop');
  mkdirSync(join(shop, '.git'), { recursive: true });
  mkdirSync(join(shop, 'src', 'billing'), { recursive: true });
  insideWt = join(shop, '.claude', 'worktrees', 'feature-x');
  siblingWt = join(home, 'code', 'shop-codex');
  addWorktree(join(shop, '.git'), 'feature-x', insideWt, { slashes: true });   // real git on Windows writes C:/…
  addWorktree(join(shop, '.git'), 'shop-codex', siblingWt, { relative: true });   // worktree.useRelativePaths
  bare = join(home, 'code', 'api.git');
  bareWt = join(home, 'code', 'api-main');
  mkdirSync(bare, { recursive: true });
  addWorktree(bare, 'main', bareWt);
  submodule = join(shop, 'vendor', 'lib');
  mkdirSync(join(shop, '.git', 'modules', 'lib'), { recursive: true });
  mkdirSync(submodule, { recursive: true });
  writeFileSync(join(submodule, '.git'), 'gitdir: ../../.git/modules/lib\n');
  plain = join(home, 'code', 'plain', 'src');
  mkdirSync(plain, { recursive: true });
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('findRepo', () => {
  test('a plain repo is its own main root', () => {
    expect(findRepo(join(shop, 'src', 'billing'), home)).toMatchObject({ mainRoot: shop, worktreeRoot: shop });
  });
  test('a worktree resolves to the repo it was made from, with absolute, forward-slash or relative gitdir paths', () => {
    expect(findRepo(insideWt, home)).toMatchObject({ mainRoot: shop, worktreeRoot: insideWt });
    expect(findRepo(siblingWt, home)).toMatchObject({ mainRoot: shop, worktreeRoot: siblingWt });
  });
  test('a worktree of a bare repository resolves to the bare repository', () => {
    expect(findRepo(bareWt, home)).toMatchObject({ mainRoot: bare, worktreeRoot: bareWt });
  });
  test('a submodule is its own project', () => {
    expect(findRepo(submodule, home)).toMatchObject({ mainRoot: submodule, worktreeRoot: submodule });
  });
  test('outside any repo there is none, and the walk stops at home', () => {
    expect(findRepo(plain, home)).toBeNull();
    mkdirSync(join(home, '.git'), { recursive: true });   // a dotfiles repo in home is not a project
    try { expect(findRepo(plain, home)).toBeNull(); } finally { rmSync(join(home, '.git'), { recursive: true }); }
  });
  test.if(process.platform === 'win32')('on Windows the home stop ignores case', () => {
    mkdirSync(join(home, '.git'), { recursive: true });
    try { expect(findRepo(plain, home.toUpperCase())).toBeNull(); } finally { rmSync(join(home, '.git'), { recursive: true }); }
  });
});

describe('projectKey', () => {
  test('every folder and worktree of one repo gets the repo\'s name', () => {
    for (const cwd of [shop, join(shop, 'src', 'billing'), insideWt, siblingWt]) {
      expect(projectKey(cwd, home)).toBe('shop');
    }
  });
  test('a bare repository keys without its .git suffix; a submodule by its folder', () => {
    expect(projectKey(bareWt, home)).toBe('api');
    expect(projectKey(submodule, home)).toBe('lib');
  });
  test('outside a repo it is the folder name, as before', () => {
    expect(projectKey(plain, home)).toBe('src');
    expect(projectKey('', home)).toBe('default');
  });
});

describe('projectAliases', () => {
  test('lists the repo name, cwd folder name and worktree folder names', () => {
    const { ids, roots } = projectAliases(join(shop, 'src', 'billing'), home);
    expect(new Set(ids)).toEqual(new Set(['shop', 'billing', 'feature-x', 'shop-codex']));
    expect(roots).toContain(join(shop, 'src', 'billing'));
    expect(roots).toContain(shop);
    expect(roots).toContain(insideWt);
    expect(roots).toContain(siblingWt);
    expect(new Set(roots).size).toBe(roots.length);
  });
  test('outside a repo: just the folder', () => {
    expect(projectAliases(plain, home)).toEqual({ ids: ['src'], roots: [plain] });
  });
});
