// Worker auth (#229) on a real worker: the inline listener and the threaded main both gate, /health stays open,
// the threaded /stats reports tokenless callers, and the token file is created 0600 in CONFIG_DIR.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { WORKER_TOKEN_HEADER, WORKER_TOKEN_PATH, workerAuthHeaders } from '../../src/shared/worker-auth.ts';

const opts = {
  projectId: 'test-project', metaDbPath: ':memory:', embedderEndpoint: 'http://localhost:0/unused', embedderModel: 'fake',
  vectorDbPath: ':memory:', embeddingDimension: 8, skipEmbed: true,
} as const;
let warn: WorkerHandle; let enforce: WorkerHandle;
const procs: Array<{ kill: () => void }> = []; const dirs: string[] = [];
beforeAll(async () => {
  warn = await startWorker({ ...opts, port: 0 });
  process.env.CAPTAIN_MEMO_WORKER_AUTH = 'enforce';
  try { enforce = await startWorker({ ...opts, port: 0 }); } finally { delete process.env.CAPTAIN_MEMO_WORKER_AUTH; }
  await fetch(`http://localhost:${warn.port}/homework/list`, { headers: workerAuthHeaders() });   // absorb the slow first request
}, 30_000);
afterAll(async () => {
  await warn.stop(); await enforce.stop();
  for (const p of procs) try { p.kill(); } catch {}
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch {}
});

const add = (port: number, headers: Record<string, string>) => fetch(`http://localhost:${port}/homework/add`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ text: 'auth probe', by: 'test' }),
});

test('inline worker: token file 0600; /health open; right token served; wrong token 401', async () => {
  if (process.platform !== 'win32') expect(statSync(WORKER_TOKEN_PATH).mode & 0o777).toBe(0o600);
  expect((await fetch(`http://localhost:${warn.port}/health`)).status).toBe(200);
  expect((await fetch(`http://localhost:${enforce.port}/health`)).status).toBe(200);
  expect((await add(warn.port, workerAuthHeaders())).status).toBe(200);
  expect((await add(enforce.port, workerAuthHeaders())).status).toBe(200);
  const wrong = await add(warn.port, { [WORKER_TOKEN_HEADER]: 'f'.repeat(64) });
  expect(wrong.status).toBe(401);
  expect(((await wrong.json()) as { error: string }).error).toBe('worker_auth_failed');
});

test('inline worker: tokenless is served in warn mode and refused in enforce mode', async () => {
  expect((await add(warn.port, {})).status).toBe(200);
  expect((await add(enforce.port, {})).status).toBe(401);
  const stats = await (await fetch(`http://localhost:${warn.port}/stats`, { headers: workerAuthHeaders() })).json() as { worker_auth: { mode: string; tokenless: Record<string, { count: number }> } };
  expect(stats.worker_auth.mode).toBe('warn');
  expect(stats.worker_auth.tokenless['POST /homework/add']!.count).toBe(1);
  expect((await fetch(`http://localhost:${enforce.port}/stats`)).status).toBe(401);
});

test('threaded worker: creates CONFIG_DIR/worker.token 0600, gates on main, reports tokenless callers in /stats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-auth-thr-')); dirs.push(dir);
  const s = Bun.serve({ port: 0, fetch: () => new Response('') }); const port = s.port ?? 0; s.stop(true);
  const proc = Bun.spawn(['bun', fileURLToPath(new URL('../../src/worker/index.ts', import.meta.url))], {
    env: { ...process.env, CAPTAIN_MEMO_WORKER_THREADED: '1', CAPTAIN_MEMO_SKIP_EMBED: '1', CAPTAIN_MEMO_SUMMARIZER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '',
      CAPTAIN_MEMO_DATA_DIR: dir, CAPTAIN_MEMO_CONFIG_DIR: dir, CAPTAIN_MEMO_WORKER_PORT: String(port) },
    stdout: 'ignore', stderr: 'ignore',
  });
  procs.push(proc);
  const base = `http://localhost:${port}`;
  const end = Date.now() + 20_000;
  while (Date.now() < end) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await Bun.sleep(150); }
  expect((await fetch(`${base}/health`)).status).toBe(200);

  const tokenPath = join(dir, 'worker.token');
  if (process.platform !== 'win32') expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  const auth = { [WORKER_TOKEN_HEADER]: readFileSync(tokenPath, 'utf8').trim() };

  expect((await fetch(`${base}/stats`, { headers: { [WORKER_TOKEN_HEADER]: 'nope' } })).status).toBe(401);
  expect((await fetch(`${base}/shutdown`, { method: 'POST', headers: { [WORKER_TOKEN_HEADER]: 'nope' } })).status).toBe(401);
  expect((await fetch(`${base}/stats`)).status).toBe(200);   // warn mode: served, and counted
  const stats = await (await fetch(`${base}/stats`, { headers: auth })).json() as { worker_auth: { mode: string; armed: boolean; tokenless: Record<string, { count: number }> } };
  expect(stats.worker_auth.mode).toBe('warn');
  expect(stats.worker_auth.armed).toBe(true);
  expect(stats.worker_auth.tokenless['GET /stats']!.count).toBe(1);
  expect(stats.worker_auth.tokenless['GET /health']).toBeUndefined();
}, 40_000);
