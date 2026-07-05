import { test, expect, beforeEach, afterEach } from 'bun:test';
import { dispatchTool } from '../../src/mcp-server.ts';

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
