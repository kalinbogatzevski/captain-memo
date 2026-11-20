import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findRepo, projectKey, projectAliases } from '../../src/shared/project-key.ts';

// A fake home holding:
//   code/shop/.git/                         a plain repo, with two registered worktrees
//   code/shop/.claude/worktrees/feature-x   a worktree inside the repo (how Claude Code makes them)
//   code/shop-codex                         a sibling worktree (how a Codex run makes them)
//   code/plain/src                          a folder that is not in any repo
let home: string;
let shop: string, insideWt: string, siblingWt: string, plain: string;

function addWorktree(mainRoot: string, name: string, wtDir: string): void {
  const admin = join(mainRoot, '.git', 'worktrees', name);
  mkdirSync(admin, { recursive: true });
  mkdirSync(wtDir, { recursive: true });
  writeFileSync(join(admin, 'gitdir'), join(wtDir, '.git') + '\n');
  writeFileSync(join(wtDir, '.git'), `gitdir: ${admin}\n`);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'cm-projkey-'));
  shop = join(home, 'code', 'shop');
  mkdirSync(join(shop, '.git'), { recursive: true });
  mkdirSync(join(shop, 'src', 'billing'), { recursive: true });
  insideWt = join(shop, '.claude', 'worktrees', 'feature-x');
  siblingWt = join(home, 'code', 'shop-codex');
  addWorktree(shop, 'feature-x', insideWt);
  addWorktree(shop, 'shop-codex', siblingWt);
  plain = join(home, 'code', 'plain', 'src');
  mkdirSync(plain, { recursive: true });
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('findRepo', () => {
  test('a plain repo is its own main root', () => {
    expect(findRepo(join(shop, 'src', 'billing'), home)).toEqual({ mainRoot: shop, worktreeRoot: shop });
  });
  test('a worktree resolves to the repo it was made from', () => {
    expect(findRepo(insideWt, home)).toEqual({ mainRoot: shop, worktreeRoot: insideWt });
    expect(findRepo(siblingWt, home)).toEqual({ mainRoot: shop, worktreeRoot: siblingWt });
  });
  test('outside any repo there is none, and the walk stops at home', () => {
    expect(findRepo(plain, home)).toBeNull();
    mkdirSync(join(home, '.git'), { recursive: true });   // a dotfiles repo in home is not a project
    try { expect(findRepo(plain, home)).toBeNull(); } finally { rmSync(join(home, '.git'), { recursive: true }); }
  });
});

describe('projectKey', () => {
  test('every folder and worktree of one repo gets the repo\'s name', () => {
    for (const cwd of [shop, join(shop, 'src', 'billing'), insideWt, siblingWt]) {
      expect(projectKey(cwd, home)).toBe('shop');
    }
  });
  test('outside a repo it is the folder name, as before', () => {
    expect(projectKey(plain, home)).toBe('src');
    expect(projectKey('', home)).toBe('default');
  });
});

describe('projectAliases', () => {
  test('lists the repo name and the names older observations were tagged with', () => {
    const { ids, roots } = projectAliases(join(shop, 'src', 'billing'), home);
    // repo key; the cwd and its parents up to the worktree root; every worktree's folder name
    expect(new Set(ids)).toEqual(new Set(['shop', 'billing', 'src', 'feature-x', 'shop-codex']));
    expect(roots).toContain(join(shop, 'src', 'billing'));
    expect(roots).toContain(shop);
    expect(roots).toContain(insideWt);
    expect(roots).toContain(siblingWt);
  });
  test('outside a repo: just the folder', () => {
    expect(projectAliases(plain, home)).toEqual({ ids: ['src'], roots: [plain] });
  });
});
