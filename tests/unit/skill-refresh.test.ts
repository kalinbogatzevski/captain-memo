import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { refreshMemoSkills, resolveMemoSkillSource, MEMO_SKILL_RELPATHS } from '../../src/cli/skill-refresh.ts';

const SRC = '/repo/skills/captain-memo/SKILL.md';
const HOME = '/home/x';

function fakeFs(present: string[]) {
  const set = new Set([SRC, ...present.map((p) => join(HOME, ...p.split('/')))]);
  const copies: Array<[string, string]> = [];
  return { copies, deps: { exists: (p: string) => set.has(p), copy: (a: string, b: string) => { copies.push([a, b]); } } };
}

test('resolves the shipped skill from the checkout', () => {
  expect(resolveMemoSkillSource()).toMatch(/skills[\\/]captain-memo[\\/]SKILL\.md$/);
});

test('refreshes existing copies only — never creates one for a CLI that was not connected here', () => {
  const fs = fakeFs(['.codex/skills/captain-memo/SKILL.md', '.cursor/rules/captain-memo.md']);
  const out = refreshMemoSkills(SRC, HOME, fs.deps);
  expect(out.sort()).toEqual([join(HOME, '.codex/skills/captain-memo/SKILL.md'), join(HOME, '.cursor/rules/captain-memo.md')].sort());
  expect(fs.copies.length).toBe(2);
});

test('a non-checkout install (no source file) is a no-op, not a crash', () => {
  const fs = fakeFs(['.codex/skills/captain-memo/SKILL.md']);
  expect(refreshMemoSkills('/nowhere/SKILL.md', HOME, fs.deps)).toEqual([]);
});

test('a failing copy is isolated — the remaining destinations still refresh', () => {
  const present = ['.codex/skills/captain-memo/SKILL.md', '.vibe/skills/captain-memo/SKILL.md'];
  const set = new Set([SRC, ...present.map((p) => join(HOME, ...p.split('/')))]);
  const copies: string[] = [];
  const out = refreshMemoSkills(SRC, HOME, {
    exists: (p) => set.has(p),
    copy: (_a, b) => { if (b.includes('.codex')) throw new Error('EACCES'); copies.push(b); },
  });
  expect(out).toEqual([join(HOME, '.vibe/skills/captain-memo/SKILL.md')]);
});

// DRIFT GUARD: the list duplicates the destinations in cross-ai.ts; parse the adapter source and fail if
// they ever disagree — including a NEW adapter whose destination never gets a refresh entry.
test('the refresh list covers every captain-memo destination in cross-ai.ts', () => {
  const src = readFileSync(new URL('../../src/cli/cross-ai.ts', import.meta.url), 'utf8');
  const found = new Set<string>();
  const re = /copySkill\(\s*ctx\.skillSource\s*,\s*join\(\s*ctx\.home\s*,\s*([^)]*)\)/g;
  for (const m of src.matchAll(re)) {
    const segs = [...m[1]!.matchAll(/'([^']+)'/g)].map((s) => s[1]!);
    if (segs.length) found.add(segs.join('/'));
  }
  expect(found.size).toBeGreaterThan(0);
  const declared = new Set(MEMO_SKILL_RELPATHS);
  expect({ missing: [...found].filter((p) => !declared.has(p)), stale: [...declared].filter((p) => !found.has(p)) }).toEqual({ missing: [], stale: [] });
});
