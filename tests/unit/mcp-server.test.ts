import { test, expect, beforeEach, afterEach } from 'bun:test';
import { dispatchTool, resolveWorkBoardSessionId, absoluteClaimFiles } from '../../src/mcp-server.ts';

// THE SELF-OVERLAP BUG. The PreToolUse auto-claim publishes under CLAUDE_CODE_SESSION_ID; minting an
// unrelated `mcp-…` id put one session on the board twice, and work-notes.ts excludes self by EXACT
// session_id — so every auto-claimed edit warned the session about itself.
test('work-board session id adopts the host session id when Claude Code supplies one', () => {
  expect(resolveWorkBoardSessionId({ CLAUDE_CODE_SESSION_ID: 'edac35d8-d744-4b54-a0d9-85d793abc9f1' }))
    .toBe('edac35d8-d744-4b54-a0d9-85d793abc9f1');
});

// Codex/Gemini/Cursor set no such var. They must still get a stable per-process id — nothing
// auto-claims for them, so there is no second row to collide with.
test('work-board session id falls back to a stable mcp- id for non-Claude hosts', () => {
  expect(resolveWorkBoardSessionId({})).toMatch(/^mcp-[0-9a-z]{10}$/);
  expect(resolveWorkBoardSessionId({ CLAUDE_CODE_SESSION_ID: '' })).toMatch(/^mcp-/);
});

let server: ReturnType<typeof Bun.serve> | undefined;
let port: number;

beforeEach(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/stats') return Response.json({ chunks: 42 });
      if (url.pathname === '/search/all') return Response.json({ results: ['ok'] });
      return new Response('not found', { status: 404 });
    },
  });
  port = server.port!;
});

afterEach(() => { server?.stop(true); });

test('dispatchTool — routes search_all to the given workerBase', async () => {
  const result = await dispatchTool(
    'search_all',
    { query: 'foo' },
    { workerBase: `http://127.0.0.1:${port}`, sessionId: 's1', cwd: () => '/tmp' },
  );
  expect(result.isError).toBeUndefined();
  const parsed = JSON.parse(result.content[0]!.text);
  expect(parsed.results).toEqual(['ok']);
});

test('dispatchTool — routes stats to the given workerBase', async () => {
  const result = await dispatchTool(
    'stats',
    {},
    { workerBase: `http://127.0.0.1:${port}`, sessionId: 's1', cwd: () => '/tmp' },
  );
  const parsed = JSON.parse(result.content[0]!.text);
  expect(parsed.chunks).toBe(42);
});

test('dispatchTool — unknown tool name returns an MCP error, not a throw', async () => {
  const result = await dispatchTool(
    'not_a_real_tool',
    {},
    { workerBase: `http://127.0.0.1:${port}`, sessionId: 's1', cwd: () => '/tmp' },
  );
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain('unknown tool');
});

test('dispatchTool — a worker error (e.g. 500) surfaces as an MCP error, not a throw', async () => {
  server?.stop(true);
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch() { return new Response('boom', { status: 500 }); },
  });
  const badPort = server.port!;
  const result = await dispatchTool(
    'search_all',
    { query: 'foo' },
    { workerBase: `http://127.0.0.1:${badPort}`, sessionId: 's1', cwd: () => '/tmp' },
  );
  expect(result.isError).toBe(true);
});

// 2026-09-30: a relative work_set path never matched the hook's absolute claims, so two declared claims on the same
// file were invisible to each other. Relative paths resolve against the session's repository root.
test('work_set: relative files resolve against the repo root; absolute ones, and a cwd of /, pass through', () => {
  const root = require('node:child_process').execSync('git rev-parse --show-toplevel', { cwd: import.meta.dir, encoding: 'utf-8' }).trim();
  expect(absoluteClaimFiles(['src/a.ts', 'docs/', '/abs/x.php', '**', '.'], `${root}/tests`)).toEqual([`${root}/src/a.ts`, `${root}/docs/`, '/abs/x.php', `${root}/**`, `${root}/**`]);
  expect(absoluteClaimFiles(['src/a.ts'], '/')).toEqual(['src/a.ts']);
});

test('work_set dispatch sends absolute files to the worker', async () => {
  let body: { files?: string[] } = {};
  const srv = Bun.serve({ port: 0, async fetch(req) { body = await req.json() as typeof body; return Response.json({ ok: true }); } });
  const root = require('node:child_process').execSync('git rev-parse --show-toplevel', { cwd: import.meta.dir, encoding: 'utf-8' }).trim();
  try {
    await dispatchTool('work_set', { what: 'x', files: ['src/mcp-server.ts'] }, { workerBase: `http://localhost:${srv.port}`, sessionId: 's', cwd: () => root });
    expect(body.files).toEqual([`${root}/src/mcp-server.ts`]);
  } finally { srv.stop(); }
});
