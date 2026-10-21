// #943: the conduct rules every session reads at start (LOCAL_ARTICLES) and the work_active tool text tell the lesson of an
// incident (two sessions in one checkout deployed over each other; a live claim taken for dead) but date it to no day and name
// no person, machine or product of the maintainer's own. Those would read as every user's history.
import { test, expect } from 'bun:test';
import { LOCAL_ARTICLES } from '../../src/hooks/local-articles.ts';
import { TOOLS } from '../../src/mcp-server.ts';

const workActive = TOOLS.find((t: { name: string }) => t.name === 'work_active')!;
// Word-bounded, so a capitalised rule ("INTERPRET") cannot trip the ERP/PHP needles.
const INCIDENT = [/\b20\d\d-\d\d-\d\d\b/, /kalin/i, /\bERP\b/, /\bPHP\b/, /erp-main/];

test('LOCAL_ARTICLES keeps the lesson of the overwrite incident and states no date or name', () => {
  expect(LOCAL_ARTICLES).toContain('Why: once, two sessions in one checkout skipped these and each deployed over the other.');
  for (const re of INCIDENT) expect(LOCAL_ARTICLES).not.toMatch(re);
});

test('the work_active tool text keeps its stale-claim warning and states no date or name', () => {
  expect(workActive.description).toContain('READ `stale` BEFORE YOU DEFER TO A CLAIM');
  expect(workActive.description).toContain('(once a live one was taken for dead and its work overwritten)');
  for (const re of INCIDENT) expect(workActive.description).not.toMatch(re);
});
