// Worker auth (#229): the secret file, the gate's verdicts, and that every client choke point sends the header.
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  WORKER_TOKEN_HEADER, WORKER_TOKEN_PATH, alwaysEnforced, ensureWorkerToken, makeWorkerAuthGate, readWorkerToken,
  workerAuthHeaders, workerAuthMode,
} from '../../src/shared/worker-auth.ts';
import { dispatchTool } from '../../src/mcp-server.ts';
import { workerAuthVerdict } from '../../src/cli/commands/doctor.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'cm-auth-')); dirs.push(d); return d; };
const req = (method: string, path: string, token?: string) =>
  new Request(`http://127.0.0.1${path}`, { method, headers: token === undefined ? {} : { [WORKER_TOKEN_HEADER]: token } });

test('ensureWorkerToken: creates a 0600 random secret (and its dir), then returns the same one', () => {
  const p = join(scratch(), 'sub', 'worker.token');
  const t = ensureWorkerToken(p);
  expect(t).toMatch(/^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600);
  expect(ensureWorkerToken(p)).toBe(t);
  expect(readWorkerToken(p)).toBe(t);
  expect(workerAuthHeaders(p)).toEqual({ [WORKER_TOKEN_HEADER]: t });
});

test('ensureWorkerToken tightens a file others can read, and refuses an empty one', () => {
  const d = scratch();
  const p = join(d, 'worker.token');
  writeFileSync(p, 'abc\n'); chmodSync(p, 0o644);
  expect(ensureWorkerToken(p)).toBe('abc');
  if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600);
  const e = join(d, 'empty.token'); writeFileSync(e, '\n');
  expect(() => ensureWorkerToken(e)).toThrow(/empty/);
});

test('ensureWorkerToken throws when it can neither create nor read (a directory where the file should be)', () => {
  const p = join(scratch(), 'worker.token'); mkdirSync(p);
  expect(() => ensureWorkerToken(p)).toThrow();
});

test('clients: a missing or unreadable file means no header, never a throw', () => {
  const p = join(scratch(), 'nope.token');
  expect(readWorkerToken(p)).toBeNull();
  expect(workerAuthHeaders(p)).toEqual({});
});

test('workerAuthMode: enforce only when asked; anything else is warn', () => {
  expect(workerAuthMode({})).toBe('warn');
  expect(workerAuthMode({ CAPTAIN_MEMO_WORKER_AUTH: ' Enforce ' })).toBe('enforce');
  expect(workerAuthMode({ CAPTAIN_MEMO_WORKER_AUTH: 'yes' })).toBe('warn');
});

test('gate: /health is open; right token passes; wrong token is 401 in either mode', () => {
  for (const mode of ['warn', 'enforce'] as const) {
    const g = makeWorkerAuthGate({ token: 's3cret', mode, log: () => {} });
    expect(g.check(req('GET', '/health'))).toBeNull();
    expect(g.check(req('POST', '/homework/add', 's3cret'))).toBeNull();
    expect(g.check(req('POST', '/homework/add', ' s3cret '))).toBeNull();
    expect(g.check(req('POST', '/homework/add', 's3creX'))!.status).toBe(401);
    expect(g.check(req('POST', '/homework/add', 'short'))!.status).toBe(401);
  }
});

test('gate, warn mode: a tokenless call is served, counted and logged once an hour per route', async () => {
  const lines: string[] = []; let t = 1_000;
  const g = makeWorkerAuthGate({ token: 's3cret', mode: 'warn', log: (l) => lines.push(l), now: () => t });
  expect(g.check(req('POST', '/worknote/set'))).toBeNull();
  t += 60_000;
  expect(g.check(req('POST', '/worknote/set'))).toBeNull();
  expect(g.check(req('GET', '/stats'))).toBeNull();
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('POST /worknote/set');
  expect(lines.join('\n')).not.toContain('s3cret');
  t += 3_600_000;
  g.check(req('POST', '/worknote/set'));
  expect(lines).toHaveLength(3);
  const r = g.report();
  expect(r).toEqual({ mode: 'warn', armed: true, tokenless: { 'POST /worknote/set': { count: 3, last_at: t }, 'GET /stats': { count: 1, last_at: 61_000 } } });
});

test('gate, enforce mode: a tokenless call is 401 with a message that says what to do', async () => {
  const g = makeWorkerAuthGate({ token: 's3cret', mode: 'enforce', log: () => {} });
  const r = g.check(req('POST', '/homework/add'))!;
  expect(r.status).toBe(401);
  const body = await r.json() as { error: string; detail: string };
  expect(body.error).toBe('worker_auth_required');
  expect(body.detail).toContain('restart it');
  expect(g.report().tokenless).toEqual({});
});

test('gate: internal routes (/_…) never accept a missing token, even in warn mode', () => {
  const g = makeWorkerAuthGate({ token: 's3cret', mode: 'warn', log: () => {} });
  expect(alwaysEnforced('/homework/_internal')).toBe(true);
  expect(alwaysEnforced('/homework/add')).toBe(false);
  expect(g.check(req('POST', '/homework/_internal'))!.status).toBe(401);
  expect(g.check(req('POST', '/homework/_internal', 's3cret'))).toBeNull();
});

test('gate without a token (the file could not be made): a sent token is 503, tokenless follows the mode', () => {
  const warn = makeWorkerAuthGate({ token: null, mode: 'warn', log: () => {} });
  expect(warn.check(req('POST', '/remember', 'anything'))!.status).toBe(503);
  expect(warn.check(req('POST', '/remember'))).toBeNull();
  expect(warn.report().armed).toBe(false);
  expect(makeWorkerAuthGate({ token: null, mode: 'enforce' }).check(req('POST', '/remember'))!.status).toBe(401);
  expect(warn.check(req('GET', '/health'))).toBeNull();
});

test('MCP tools and the CLI client send the token from CONFIG_DIR/worker.token', async () => {
  const token = ensureWorkerToken();   // the preload's scratch home: WORKER_TOKEN_PATH is never the real one here
  expect(WORKER_TOKEN_PATH).toContain('cm-test-home-');
  const seen: Array<string | null> = [];
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => { seen.push(r.headers.get(WORKER_TOKEN_HEADER)); return Response.json({ items: [], results: [] }); } });
  const prev = process.env.CAPTAIN_MEMO_WORKER_PORT;
  process.env.CAPTAIN_MEMO_WORKER_PORT = String(srv.port);
  try {
    const deps = { workerBase: `http://127.0.0.1:${srv.port}`, sessionId: 's', cwd: () => '/' };
    await dispatchTool('search_memory', { query: 'x' }, deps);
    await dispatchTool('todo_list', {}, deps);
    const client = await import(`../../src/cli/client.ts?auth=${Date.now()}`) as typeof import('../../src/cli/client.ts');
    await client.workerGet('/stats');
    await client.workerPost('/remember', {});
    await client.workerGetOptional('/stats', 2_000);
    expect(seen).toEqual([token, token, token, token, token]);
  } finally {
    if (prev === undefined) delete process.env.CAPTAIN_MEMO_WORKER_PORT; else process.env.CAPTAIN_MEMO_WORKER_PORT = prev;
    srv.stop(true);
  }
});

test('hook workerFetch sends the token', async () => {
  const token = ensureWorkerToken();
  const seen: Array<string | null> = [];
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => { seen.push(r.headers.get(WORKER_TOKEN_HEADER)); return Response.json({}); } });
  const prev = process.env.CAPTAIN_MEMO_WORKER_PORT;
  process.env.CAPTAIN_MEMO_WORKER_PORT = String(srv.port);
  try {
    const { workerFetch } = await import(`../../src/hooks/shared.ts?auth=${Date.now()}`) as typeof import('../../src/hooks/shared.ts');
    expect((await workerFetch('/worknote/set', { method: 'POST', body: {}, timeoutMs: 2_000 })).ok).toBe(true);
    expect((await workerFetch('/stats', { timeoutMs: 2_000 })).ok).toBe(true);
    expect(seen).toEqual([token, token]);
  } finally {
    if (prev === undefined) delete process.env.CAPTAIN_MEMO_WORKER_PORT; else process.env.CAPTAIN_MEMO_WORKER_PORT = prev;
    srv.stop(true);
  }
});

test('doctor verdict: missing file, loose perms, refused token, tokenless callers, clean', () => {
  const base = { token: true, looseMode: false, statsStatus: null, now: 100_000_000 };
  expect(workerAuthVerdict({ ...base, token: false }).status).toBe('FAIL');
  expect(workerAuthVerdict({ ...base, looseMode: true }).status).toBe('WARN');
  expect(workerAuthVerdict({ ...base, statsStatus: 401 }).status).toBe('FAIL');
  expect(workerAuthVerdict({ ...base, report: { mode: 'warn', armed: false, tokenless: {} } }).status).toBe('FAIL');
  const stale = { 'GET /stats': { count: 4, last_at: 1 } };
  expect(workerAuthVerdict({ ...base, report: { mode: 'warn', armed: true, tokenless: stale } }).status).toBe('PASS');
  const live = workerAuthVerdict({ ...base, report: { mode: 'warn', armed: true, tokenless: { 'POST /worknote/set': { count: 2, last_at: 99_999_000 } } } });
  expect(live.status).toBe('WARN');
  expect(live.detail).toContain('POST /worknote/set x2');
  expect(workerAuthVerdict({ ...base, report: { mode: 'enforce', armed: true, tokenless: {} } }).status).toBe('PASS');
});
