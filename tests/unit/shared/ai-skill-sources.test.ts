import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
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

test('kimi 2.x skills are discovered in ~/.kimi-code (or $KIMI_CODE_HOME) and attributed to kimi', () => {
  const home = mkdtempSync(join(tmpdir(), 'captain-memo-skill-home-'));
  try {
    const kimi2 = join(home, '.kimi-code');
    mkdirSync(join(kimi2, 'skills'), { recursive: true });
    expect(discoverSkillGlobs(home, {})).toEqual([`${kimi2}/skills/*/SKILL.md`]);
    expect(skillToolFromPath(`${home}/.kimi-code/skills/x/SKILL.md`, {})).toBe('kimi');

    const alt = join(home, 'kimi-alt');
    mkdirSync(join(alt, 'skills'), { recursive: true });
    expect(discoverSkillGlobs(home, { KIMI_CODE_HOME: alt })).toEqual([`${alt}/skills/*/SKILL.md`]);   // the relocated home replaces the default one
    expect(skillToolFromPath(join(alt, 'skills', 'x', 'SKILL.md'), { KIMI_CODE_HOME: alt })).toBe('kimi');
    expect(skillToolFromPath('/srv/shared/x/SKILL.md', { KIMI_CODE_HOME: alt })).toBe('other');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('codex skills are discovered in ~/.codex (or $CODEX_HOME, which replaces it) and attributed to codex', () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-skill-home-'));
  try {
    const dflt = join(home, '.codex');
    mkdirSync(join(dflt, 'skills', '.system'), { recursive: true });
    expect(discoverSkillGlobs(home, {})).toEqual([`${home}/.codex/skills/*/SKILL.md`, `${home}/.codex/skills/.system/*/SKILL.md`]);
    expect(discoverSkillGlobs(home, { CODEX_HOME: '' })).toEqual(discoverSkillGlobs(home, {}));   // blank = unset

    const alt = join(home, 'codex-alt');
    mkdirSync(join(alt, 'skills'), { recursive: true });
    expect(discoverSkillGlobs(home, { CODEX_HOME: alt })).toEqual([`${alt}/skills/*/SKILL.md`]);   // codex ignores ~/.codex once it is set
    expect(skillToolFromPath(join(alt, 'skills', 'x', 'SKILL.md'), { CODEX_HOME: alt })).toBe('codex');
    expect(skillToolFromPath('/srv/shared/x/SKILL.md', { CODEX_HOME: alt })).toBe('other');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
