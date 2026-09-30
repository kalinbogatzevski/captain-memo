// The local articles every Claude Code session gets at start (src/hooks/local-articles.ts). Kalin 2026-09-30: the work
// board is the FOUNDATION; two sessions in one checkout skipped work_active and work_set, declared relative paths,
// cleared early and deployed over each other.
import { test, expect } from 'bun:test';
import { LOCAL_ARTICLES } from '../../src/hooks/local-articles.ts';

test('the work-board Foundation opens the articles, before article 1', () => {
  const f = LOCAL_ARTICLES.indexOf('FOUNDATION: THE WORK BOARD');
  const a1 = LOCAL_ARTICLES.indexOf('1. SEARCH BEFORE YOU ACT');
  expect(f).toBeGreaterThan(0);
  expect(f).toBeLessThan(a1);
  const foundation = LOCAL_ARTICLES.slice(f, a1);
  for (const rule of ['`work_active()` before your first edit', 'ABSOLUTE paths', 'before commit/checkout/reset/stash/add',
    'any deploy', 'remote md5', '"HEAD + my hunk"', 'never edit or deploy over', 'tell the user which', 'Stale',
    '`work_clear` only once committed AND deployed', 're-`work_set` after a long pause', 'ONE TREE PER SESSION',
    '`git add <paths>`, never -A', 'AUTO-CLAIM (Claude Code, Codex, Gemini)', 'INFERS the why', 'A LIVE Claude Code claim BLOCKS your edit',
    '`override: <file>`'])
    expect(foundation).toContain(rule);
});

test('the single-machine articles follow, in order', () => {
  const heads = ['1. SEARCH BEFORE YOU ACT', '2. NEVER GUESS', '3. COMMITTED IS NOT DEPLOYED', '4. ASK', '5. `idea:` / `todo:`',
    '6. RUN WORK NEXT TO ITS DATA', "7. THE USER'S TIME IS THE COST"];
  const at = heads.map((h) => LOCAL_ARTICLES.indexOf(h));
  expect(at.every((i) => i > 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  for (const s of ['with the WHY', 'DEFERRED SCOPE IS HOMEWORK', '`todo_claim(id)`', '`todo_done(id, note)`']) expect(LOCAL_ARTICLES).toContain(s);
});

test('no fleet content: this is the OSS single-machine build', () => {
  for (const re of [/fleet/i, /sibling/i, /co-?session/i, /cosession_/i, /⚓/, /\bhub\b/i, /\bcaptains?\b(?![- ]memo)/i])
    expect(LOCAL_ARTICLES).not.toMatch(re);
});

test('compact, and no em dashes', () => {
  expect(LOCAL_ARTICLES.length).toBeLessThan(3200);   // once per session; fed's equivalent is 3632 chars
  expect(LOCAL_ARTICLES).not.toContain('—');
});
