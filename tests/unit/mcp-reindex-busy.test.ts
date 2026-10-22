// The worker refuses a second /reindex with 409 reindex_running (single-flight). The MCP `reindex` tool hands the AI
// the worker's own short sentence (start time included) as plain text: nothing failed, so no isError to retry on.
import { test, expect, afterAll } from 'bun:test';
import { dispatchTool, reindexBusyText } from '../../src/mcp-server.ts';

const DETAIL = 'a reindex is already running, started 09:51:48, wait for it';
const BUSY_BODY = { error: 'reindex_running', started_at: '2026-10-22T06:51:48.000Z', channel: 'all', force: true, detail: DETAIL };

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterAll(() => { for (const s of servers) s.stop(true); });
function worker(respond: () => Response) {
  const calls: string[] = [];
  const srv = Bun.serve({ port: 0, fetch: (req) => { calls.push(new URL(req.url).pathname); return respond(); } });
  servers.push(srv);
  return { calls, deps: { workerBase: `http://localhost:${srv.port}`, sessionId: 'sess-1', cwd: () => '/p' } };
}

test('reindex: a 409 reindex_running reaches the AI as the worker\'s own short sentence, not an error to retry', async () => {
  const w = worker(() => Response.json(BUSY_BODY, { status: 409 }));
  const out = await dispatchTool('reindex', { channel: 'all', force: true }, w.deps);
  expect(out.isError).toBeUndefined();
  expect(out.content[0]!.text).toBe(DETAIL);
  expect(w.calls).toEqual(['/reindex']);
});

test('reindex: any OTHER worker failure is still an error', async () => {
  const w = worker(() => Response.json({ error: 'invalid_request' }, { status: 400 }));
  const out = await dispatchTool('reindex', { channel: 'all' }, w.deps);
  expect(out.isError).toBe(true);
  expect(out.content[0]!.text).toContain('400');
});

test('reindexBusyText: the detail sentence; a generic one when the body has none; null for anything else', () => {
  const msg = (body: unknown) => `worker /reindex returned 409: ${typeof body === 'string' ? body : JSON.stringify(body)}`;
  expect(reindexBusyText(msg(BUSY_BODY))).toBe(DETAIL);
  expect(reindexBusyText(msg({ error: 'reindex_running' }))).toBe('a reindex is already running, wait for it');
  expect(reindexBusyText(msg('{"error":"reindex_running", broken'))).toBe('a reindex is already running, wait for it');
  expect(reindexBusyText(msg({ error: 'ambiguous' }))).toBeNull();
  expect(reindexBusyText('worker /reindex returned 500: boom')).toBeNull();
});
