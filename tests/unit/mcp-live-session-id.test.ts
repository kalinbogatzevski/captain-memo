// CLAUDE_CODE_SESSION_ID is fixed when the MCP server starts, but a resumed (`claude -r`), Remote Control or /clear'd
// session continues under another id, which its hooks report. liveSessionId reads Claude Code's own runtime file for the
// parent process, so the work claims and homework the MCP server files under "this session" match the hooks.
import { test, expect } from 'bun:test';
import { liveSessionId } from '../../src/mcp-server.ts';

test('under Claude Code the runtime file wins over the start-time env id, and is re-read after 5 s', () => {
  let t = 0, runtime = 'runtime-2';
  const reads: number[] = [];
  const sid = liveSessionId('env-1', { CLAUDE_CODE_SESSION_ID: 'env-1' }, (pid) => { reads.push(pid); return runtime; }, 4242, () => t);
  expect(sid()).toBe('runtime-2');
  expect(reads).toEqual([4242]);
  runtime = 'runtime-3';   // /clear moves the session to a new id
  t = 4_000; expect(sid()).toBe('runtime-2');   // cached
  t = 5_000; expect(sid()).toBe('runtime-3');
});

test('no file, a throwing reader, or not under Claude Code: the process id stands', () => {
  expect(liveSessionId('env-1', { CLAUDE_CODE_SESSION_ID: 'env-1' }, () => null, 1)()).toBe('env-1');
  expect(liveSessionId('env-1', { CLAUDE_CODE_SESSION_ID: 'env-1' }, () => { throw new Error('x'); }, 1)()).toBe('env-1');
  let read = false;
  expect(liveSessionId('mcp-abc', {}, () => { read = true; return 'nope'; }, 1)()).toBe('mcp-abc');
  expect(read).toBe(false);   // codex, gemini, ...: never reads a Claude file
});

test('the default reader takes sessionId from <CLAUDE_CONFIG_DIR>/sessions/<ppid>.json', () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('fs') as typeof import('fs');
  const dir = mkdtempSync(require('path').join(require('os').tmpdir(), 'cm-live-sid-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    mkdirSync(`${dir}/sessions`);
    writeFileSync(`${dir}/sessions/4242.json`, JSON.stringify({ pid: 4242, sessionId: 'resumed-9', kind: 'interactive' }));
    process.env.CLAUDE_CONFIG_DIR = dir;
    expect(liveSessionId('env-1', { CLAUDE_CODE_SESSION_ID: 'env-1' }, undefined, 4242)()).toBe('resumed-9');
    expect(liveSessionId('env-1', { CLAUDE_CODE_SESSION_ID: 'env-1' }, undefined, 4243)()).toBe('env-1');   // no file
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tool call with the default deps files under the live id, read when the call runs', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = require('fs') as typeof import('fs');
  const dir = mkdtempSync(require('path').join(require('os').tmpdir(), 'cm-live-sid-'));
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  const srv = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url);
    seen.push({ path: url.pathname, body: req.method === 'GET' ? Object.fromEntries(url.searchParams) : await req.json() as Record<string, unknown> });
    return Response.json({ ok: true, claims: [] });
  } });
  try {
    mkdirSync(`${dir}/sessions`);
    // The child's parent is this test process, so its runtime file is sessions/<ppid>.json. It is written AFTER the
    // import: a server that read the id once at load would still file under start-1.
    const src = require('path').join(__dirname, '../../src/mcp-server.ts');
    const file = JSON.stringify(`${dir}/sessions/`);
    const child = Bun.spawn(['bun', '-e', `const m = await import(${JSON.stringify(src)});
      await Bun.write(${file} + process.ppid + '.json', JSON.stringify({ sessionId: 'resumed-9' }));
      await m.dispatchTool('work_set', { what: 'x' });
      await m.dispatchTool('todo_add', { text: 't', project: 'p' });
      await m.dispatchTool('todo_claim', { id: '1' });
      await m.dispatchTool('work_active', {});
      await m.dispatchTool('work_clear', {});`], {
      env: { ...process.env, CAPTAIN_MEMO_WORKER_PORT: String(srv.port), CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_SESSION_ID: 'start-1' },
      stdout: 'ignore', stderr: 'ignore',
    });
    expect(await child.exited).toBe(0);
    expect(seen.map((s) => [s.path, s.body.session_id ?? s.body.by])).toEqual([
      ['/worknote/set', 'resumed-9'], ['/homework/add', 'resumed-9'], ['/homework/claim', 'resumed-9'],
      ['/worknote/active', 'resumed-9'], ['/worknote/clear', 'resumed-9'],
    ]);
  } finally {
    srv.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
