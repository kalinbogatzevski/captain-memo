// Text a user or an AI reads that had gone stale because nothing pinned it: `captain-memo help` was missing two commands
// and half the connect targets (the site points people at it for the full list).
import { test, expect, beforeAll } from 'bun:test';
import { join } from 'path';
import { readFileSync } from 'fs';
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

test('captain-memo help has a line for every command index.ts dispatches (the watchdog action is internal, by design)', () => {
  const src = readFileSync(join(ROOT, 'src/cli/index.ts'), 'utf-8');
  const dispatched = [...src.matchAll(/^    case '([a-z][a-z-]*)':/gm)].map((m) => m[1]!).filter((c) => c !== 'worker-watchdog');
  expect(dispatched.length).toBeGreaterThan(30);
  expect(dispatched.filter((c) => helpLine(c) === '')).toEqual([]);
});

test('captain-memo help names every target `connect` really supports (ADAPTERS), not a hand-kept subset', () => {
  const line = helpLine('connect');
  expect(line).not.toBe('');
  for (const a of ADAPTERS) expect(line).toContain(a.id);
});

test('todo_add says Claude Code, Codex and Gemini sessions see open items at start; its schema is unchanged', async () => {
  const { TOOLS } = await import('../../src/mcp-server.ts');
  const t = TOOLS.find((x: { name: string }) => x.name === 'todo_add')!;
  expect(t.description).toMatch(/Claude Code, Codex and Gemini sessions see the open items at start/);
  expect(Object.keys(t.inputSchema.properties as object).sort()).toEqual(['due', 'project', 'text', 'topics']);
  expect((t.inputSchema as { required: string[] }).required).toEqual(['text']);
});

test('package.json description mirrors the plugin manifest and no longer says Voyage-embedded', () => {
  const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf-8')) as { description: string };
  const pkg = read('package.json').description;
  expect(pkg).toBe(read('plugin/.claude-plugin/plugin.json').description);
  expect(pkg).not.toMatch(/voyage/i);
});
