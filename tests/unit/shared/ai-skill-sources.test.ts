import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  allSkillSources, discoverSkillGlobs, resolveSkillWatchSetting, skillToolFromPath,
} from '../../../src/shared/ai-skill-sources.ts';

test('skill watching defaults to auto but an explicit empty value opts out', () => {
  expect(resolveSkillWatchSetting(undefined)).toBe('auto');
  expect(resolveSkillWatchSetting('auto')).toBe('auto');
  expect(resolveSkillWatchSetting('')).toBe('');
});

test('skill source globs are structurally limited to SKILL.md', () => {
  const sources = allSkillSources('/home/tester');
  expect(sources.length).toBeGreaterThan(0);
  for (const source of sources) {
    expect(source.glob).toEndWith('/SKILL.md');
    expect(source.glob).toContain('*');
  }
});

test('discoverSkillGlobs includes only roots that exist', () => {
  const home = mkdtempSync(join(tmpdir(), 'captain-memo-skill-home-'));
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
  const globs = discoverSkillGlobs(home);
  expect(globs).toContain(`${home}/.claude/skills/*/SKILL.md`);
  expect(globs).toContain(`${home}/.agents/skills/*/SKILL.md`);
  expect(globs.some((g) => g.includes('/.gemini/'))).toBe(false);
});

test('skillToolFromPath records cross-AI provenance', () => {
  expect(skillToolFromPath('/h/.claude/skills/review/SKILL.md')).toBe('claude-code');
  expect(skillToolFromPath('/h/.agents/skills/review/SKILL.md')).toBe('codex');
  expect(skillToolFromPath('/h/.gemini/skills/review/SKILL.md')).toBe('gemini');
  expect(skillToolFromPath('/srv/shared/review/SKILL.md')).toBe('other');
});
