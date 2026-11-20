import { test, expect, describe } from 'bun:test';
import { join } from 'path';
import { resolveRecallScope, filterHitsToProject } from '../../src/worker/recall-scope.ts';
import { projectSlugFromCwd } from '../../src/shared/paths.ts';

// Fixture paths are built with join() so they read as native paths on every platform.
const HOME = join('/', 'home', 'k');
const PROJECTS = join(HOME, '.claude', 'projects');
const SHOP = join(HOME, 'work', 'shop');
const BILLING = join(HOME, 'work', 'billing');

const memoryAt = (path: string) => ({ channel: 'memory', source_path: path, metadata: {} });
const projectMemory = (cwd: string, file = 'feedback_x.md') =>
  memoryAt(join(PROJECTS, projectSlugFromCwd(cwd), 'memory', file));
const obs = (projectId: unknown) => ({ channel: 'observation', source_path: 'observation:1', metadata: { project_id: projectId } });
const skill = { channel: 'skill', source_path: join(HOME, '.claude', 'skills', 'seo', 'SKILL.md'), metadata: {} };

const ctx = (cwd: string, projectIds?: string[], roots?: string[]) =>
  ({ cwd, home: HOME, claudeProjectsDir: PROJECTS, ...(projectIds ? { projectIds } : {}), ...(roots ? { roots } : {}) });

describe('resolveRecallScope', () => {
  test('unset, empty or unknown keeps today\'s behaviour (all)', () => {
    expect(resolveRecallScope({})).toBe('all');
    expect(resolveRecallScope({ CAPTAIN_MEMO_RECALL_SCOPE: '' })).toBe('all');
    expect(resolveRecallScope({ CAPTAIN_MEMO_RECALL_SCOPE: 'everything' })).toBe('all');
  });
  test('"project" turns scoping on, case- and space-insensitive', () => {
    expect(resolveRecallScope({ CAPTAIN_MEMO_RECALL_SCOPE: 'project' })).toBe('project');
    expect(resolveRecallScope({ CAPTAIN_MEMO_RECALL_SCOPE: ' Project ' })).toBe('project');
  });
});

describe('filterHitsToProject', () => {
  test('keeps the current project\'s Claude memory, drops another project\'s', () => {
    const mine = projectMemory(SHOP);
    const theirs = projectMemory(BILLING);
    expect(filterHitsToProject([mine, theirs], ctx(SHOP))).toEqual([mine]);
  });

  test('a session in a subfolder or worktree still sees its project\'s memory', () => {
    const mine = projectMemory(SHOP);
    const worktree = join(SHOP, '.claude', 'worktrees', 'feature-x');
    expect(filterHitsToProject([mine], ctx(worktree))).toEqual([mine]);
  });

  test('a sibling whose name only starts the same is another project', () => {
    const shop2 = projectMemory(join(HOME, 'work', 'shop2'));
    expect(filterHitsToProject([shop2], ctx(SHOP))).toEqual([]);
  });

  test('observations: same project kept, other project dropped, untagged kept', () => {
    const hits = [obs('shop'), obs('billing'), obs(undefined), obs('default')];
    expect(filterHitsToProject(hits, ctx(SHOP))).toEqual([obs('shop'), obs(undefined), obs('default')]);
  });

  test('skills, capabilities and user-global memory are never project-owned', () => {
    const global = [
      skill,
      { channel: 'capability', source_path: join(HOME, '.codex', 'plugins', 'x', 'plugin.json'), metadata: {} },
      memoryAt(join(HOME, '.claude', 'CLAUDE.md')),
      memoryAt(join(HOME, '.claude', 'memory', 'feedback_y.md')),
      memoryAt(join(HOME, '.codex', 'AGENTS.md')),
      memoryAt(join('/', 'srv', 'notes', 'custom.md')),
    ];
    expect(filterHitsToProject(global, ctx(SHOP))).toEqual(global);
  });

  test('repo-level instruction files under a code root belong to their repo', () => {
    const shopRules = memoryAt(join(SHOP, 'AGENTS.md'));
    const billingRules = memoryAt(join(BILLING, '.github', 'copilot-instructions.md'));
    expect(filterHitsToProject([shopRules, billingRules], ctx(SHOP))).toEqual([shopRules]);
  });

  test('Windows paths match case-insensitively', () => {
    const winHome = 'C:\\Users\\me';
    const winProjects = `${winHome}\\.claude\\projects`;
    const cwd = 'C:\\Users\\me\\Documents\\web\\shop';
    const mine = memoryAt(`${winProjects}\\c--Users-me-Documents-web-shop\\memory\\a.md`);
    const theirs = memoryAt(`${winProjects}\\C--Users-me-Documents-web-yasido\\memory\\b.md`);
    const winCtx = { cwd, projectIds: ['shop'], home: winHome, claudeProjectsDir: winProjects, caseInsensitive: true };
    expect(filterHitsToProject([mine, theirs], winCtx)).toEqual([mine]);
  });

  test('a worktree outside the repo: the repo\'s memory, old worktree tags and repo rules are its own', () => {
    const wt = join(HOME, 'work', 'shop-codex');
    const scoped = ctx(wt, ['shop', 'shop-codex', 'feature-x'], [wt, SHOP]);
    const keep = [projectMemory(SHOP), projectMemory(wt), obs('shop'), obs('feature-x'), memoryAt(join(SHOP, 'AGENTS.md'))];
    const drop = [projectMemory(BILLING), obs('billing'), memoryAt(join(BILLING, 'AGENTS.md'))];
    expect(filterHitsToProject([...keep, ...drop], scoped)).toEqual(keep);
  });

  test('without a cwd nothing is filtered', () => {
    const hits = [projectMemory(BILLING), obs('billing')];
    expect(filterHitsToProject(hits, { ...ctx(SHOP), cwd: '' })).toEqual(hits);
  });
});
