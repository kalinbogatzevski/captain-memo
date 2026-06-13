import { test, expect } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import {
  ENV_REMEMBER_DIR, DEFAULT_REMEMBER_DIR,
  ENV_PROMOTE_ENABLE,
  ENV_PROMOTE_INTERVAL_MS, DEFAULT_PROMOTE_INTERVAL_MS,
  ENV_PROMOTE_MAX_PER_RUN, DEFAULT_PROMOTE_MAX_PER_RUN,
  ENV_REMEMBER_DEDUP_THRESHOLD, DEFAULT_REMEMBER_DEDUP_THRESHOLD,
  projectSlugFromCwd,
} from '../../../src/shared/paths.ts';

test('env-var names match the CAPTAIN_MEMO_* contract verbatim', () => {
  expect(ENV_REMEMBER_DIR).toBe('CAPTAIN_MEMO_REMEMBER_DIR');
  expect(ENV_PROMOTE_ENABLE).toBe('CAPTAIN_MEMO_PROMOTE_ENABLE');
  expect(ENV_PROMOTE_INTERVAL_MS).toBe('CAPTAIN_MEMO_PROMOTE_INTERVAL_MS');
  expect(ENV_PROMOTE_MAX_PER_RUN).toBe('CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN');
  expect(ENV_REMEMBER_DEDUP_THRESHOLD).toBe('CAPTAIN_MEMO_REMEMBER_DEDUP_THRESHOLD');
});

test('defaults match spec §8', () => {
  expect(DEFAULT_REMEMBER_DIR).toBe(join(homedir(), '.claude', 'memory'));
  expect(DEFAULT_PROMOTE_INTERVAL_MS).toBe(21_600_000);
  expect(DEFAULT_PROMOTE_MAX_PER_RUN).toBe(5);
  expect(DEFAULT_REMEMBER_DEDUP_THRESHOLD).toBe(0.85);
});

test('projectSlugFromCwd — real observed dirs: slash→dash, case + digits preserved', () => {
  expect(projectSlugFromCwd('/home/kalin/projects/captain-memo'))
    .toBe('-home-kalin-projects-captain-memo');
  expect(projectSlugFromCwd('/home/kalin/projects/123net-aelita'))
    .toBe('-home-kalin-projects-123net-aelita');
  expect(projectSlugFromCwd('/home/kalin/projects/ERP-UNIFIED-DOCS'))
    .toBe('-home-kalin-projects-ERP-UNIFIED-DOCS');
});

test('projectSlugFromCwd — adjacent separators each map to a dash, no run-collapse', () => {
  // Real source path is a `.claude-worktrees` hidden dir: the `/.` run (slash + dot)
  // = two separators → '--'. A run-collapsing encoder would wrongly emit a single '-'.
  expect(projectSlugFromCwd('/home/kalin/projects/erp-platform/.claude-worktrees-status-workflow-graph-editor'))
    .toBe('-home-kalin-projects-erp-platform--claude-worktrees-status-workflow-graph-editor');
});

test('projectSlugFromCwd — dots encoded to dash (Claude Code scheme)', () => {
  expect(projectSlugFromCwd('/home/kalin/.config/captain-memo'))
    .toBe('-home-kalin--config-captain-memo');
  expect(projectSlugFromCwd('/home/kalin/projects/my.app.v2'))
    .toBe('-home-kalin-projects-my-app-v2');
});

test('projectSlugFromCwd — underscores encoded to dash (Claude Code scheme)', () => {
  expect(projectSlugFromCwd('/home/kalin/projects/_archive/123net_erp'))
    .toBe('-home-kalin-projects--archive-123net-erp');
});

test('projectSlugFromCwd — trailing slash yields trailing dash', () => {
  expect(projectSlugFromCwd('/home/kalin/projects/captain-memo/'))
    .toBe('-home-kalin-projects-captain-memo-');
});

test('projectSlugFromCwd — leading slash root only', () => {
  expect(projectSlugFromCwd('/')).toBe('-');
  expect(projectSlugFromCwd('/tmp')).toBe('-tmp');
});

