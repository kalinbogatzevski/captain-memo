// Text a user or an AI reads that had gone stale because nothing pinned it: `captain-memo help` was missing two commands
// and half the connect targets (the site points people at it for the full list).
import { test, expect, beforeAll } from 'bun:test';
import { join } from 'path';
import { ADAPTERS } from '../../src/cli/cross-ai.ts';

const ROOT = join(import.meta.dir, '../..');

// The real CLI entry: `help` prints the banner and HELP and exits 0 without touching the worker or any data.
let help = '';
beforeAll(async () => {
  const p = Bun.spawn(['bun', join(ROOT, 'src/cli/index.ts'), 'help'], {
    env: { ...process.env, NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0);
  help = out;
}, 20_000);

const helpLine = (cmd: string): string => help.split('\n').find((l) => new RegExp(`^  ${cmd}\\s`).test(l)) ?? '';

test('captain-memo help lists queue and maintenance, both of which index.ts dispatches', () => {
  expect(helpLine('queue')).toMatch(/dedupe/);
  expect(helpLine('queue')).toMatch(/retry/);
  expect(helpLine('maintenance')).toMatch(/--apply/);
});

test('captain-memo help names every target `connect` really supports (ADAPTERS), not a hand-kept subset', () => {
  const line = helpLine('connect');
  expect(line).not.toBe('');
  for (const a of ADAPTERS) expect(line).toContain(a.id);
});
