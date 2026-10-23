import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { BOOT_WAIT_MS, tailOf, waitHealthy } from '../support/worker-boot.ts';

// fileURLToPath (not URL.pathname): on Windows `.pathname` is "/C:/…/index.ts"
// (leading slash before the drive), which `bun <path>` cannot resolve — the
// spawned worker dies with "Module not found" and never binds, so the test
// times out at "never healthy". fileURLToPath yields a real "C:\…" path.
const WORKER = fileURLToPath(new URL('../../src/worker/index.ts', import.meta.url));
const procs: Array<{ kill: () => void }> = []; const dirs: string[] = [];
afterAll(() => { for (const p of procs) try { p.kill(); } catch {} for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch {} });

async function freePort(): Promise<number> { const s = Bun.serve({ port: 0, fetch: () => new Response('') }); const p = s.port ?? 0; s.stop(true); return p; }

test('threaded worker: /health stays fast while the engine is blocked 5s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-thr-')); dirs.push(dir);
  mkdirSync(join(dir, 'mem'), { recursive: true });
  writeFileSync(join(dir, 'mem', 'n.md'), '# note\n\nhello threaded world\n');
  const port = await freePort();
  const proc = Bun.spawn(['bun', WORKER], {
    env: { ...process.env, CAPTAIN_MEMO_WORKER_THREADED: '1', CAPTAIN_MEMO_ENABLE_TEST_ENDPOINTS: '1',
      CAPTAIN_MEMO_SKIP_EMBED: '1', CAPTAIN_MEMO_SUMMARIZER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '',
      CAPTAIN_MEMO_DATA_DIR: dir, CAPTAIN_MEMO_CONFIG_DIR: dir, CAPTAIN_MEMO_WORKER_PORT: String(port), CAPTAIN_MEMO_WATCH_MEMORY: join(dir, 'mem', '*.md') },
    stdout: 'ignore', stderr: 'pipe',
  });
  procs.push(proc);
  const base = `http://localhost:${port}`;
  await waitHealthy(base, proc, tailOf(proc.stderr));

  // Block the ENGINE for 5s (don't await), then hammer /health on MAIN.
  void fetch(`${base}/test/block?ms=5000`).catch(() => {});
  await Bun.sleep(200);
  let maxMs = 0;
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    const r = await fetch(`${base}/health`);
    maxMs = Math.max(maxMs, performance.now() - t0);
    await r.text();
    await Bun.sleep(200);
  }
  // The whole point: main never blocked, even with the engine pinned for 5s.
  expect(maxMs).toBeLessThan(100);

  // And a real request works again once the engine frees up.
  await Bun.sleep(5000);
  const s = await (await fetch(`${base}/search/all`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'hello', top_k: 3 }) })).json() as any;
  expect(Array.isArray(s.results)).toBe(true);

  // The boot breadcrumb is written before the port opens and MUST be cleared once it is. Left
  // behind, every SessionStart after every boot waits out the transition budget and a genuinely
  // dead worker is shielded from self-heal for the whole TTL. Asserted at the END of the test,
  // not right after the port answers: clearTransition() runs a hair after startThreadedWorker
  // returns, so an immediate check has a sub-millisecond flake window.
  expect(existsSync(join(dir, '.worker-transition'))).toBe(false);
}, BOOT_WAIT_MS + 20_000);

// A thread_rpc_timeout abandons MAIN's wait; it does NOT cancel the writer. For /remember that is "unconfirmed",
// not "failed": a flat 503 sent a caller into a retry and BOTH copies landed (field 2026-08-08). Other paths
// that time out keep their 503. /reindex, /promote/slice and /consolidate are the same kind of write: each answers 202
// with a hint naming its own check.
test('threaded worker: a /remember, /reindex, /promote/slice or /consolidate that outlives main\'s wait answers 202 write_in_flight; other timeouts stay 503', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-thr-inflight-')); dirs.push(dir);
  const port = await freePort();
  const proc = Bun.spawn(['bun', WORKER], {
    env: { ...process.env, CAPTAIN_MEMO_WORKER_THREADED: '1', CAPTAIN_MEMO_ENABLE_TEST_ENDPOINTS: '1',
      CAPTAIN_MEMO_SKIP_EMBED: '1', CAPTAIN_MEMO_SUMMARIZER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '',
      CAPTAIN_MEMO_DATA_DIR: dir, CAPTAIN_MEMO_CONFIG_DIR: dir, CAPTAIN_MEMO_WORKER_PORT: String(port),
      CAPTAIN_MEMO_REMEMBER_MS: '1000', CAPTAIN_MEMO_REINDEX_MS: '1000', CAPTAIN_MEMO_ENGINE_REQUEST_MS: '1000' },
    stdout: 'ignore', stderr: 'pipe',
  });
  procs.push(proc);
  const base = `http://localhost:${port}`;
  await waitHealthy(base, proc, tailOf(proc.stderr));

  const block = fetch(`${base}/test/block?ms=4000`);   // pins the WRITER past every 1s deadline
  await Bun.sleep(200);
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  // Concurrent: each waits its own 1s deadline while the writer is pinned.
  const [r, reindex, slice, consolidate] = await Promise.all([
    post('/remember', { body: 'in flight', type: 'feedback', cwd: dir }),
    post('/reindex', { channel: 'memory', force: false }),
    post('/promote/slice', { mode: 'shadow', limit: 1 }),
    post('/consolidate?pass=semantic', {}),
  ]);
  expect(r.status).toBe(202);
  expect(((await r.json()) as { status?: string }).status).toBe('write_in_flight');
  for (const [res, hint] of [[reindex, /no progress readout/], [slice, /promote --report/], [consolidate, /Housekeeping/]] as const) {
    expect(res.status).toBe(202);
    const body = await res.json() as { status?: string; hint?: string };
    expect(body.status).toBe('write_in_flight');
    expect(body.hint).toMatch(hint);                  // its own check, not a memory search
    expect(body.hint).not.toMatch(/search_memory/);
  }
  const b = await block;                               // /test/block is not in the set: its timeout is still a 503
  expect(b.status).toBe(503);
  expect(await b.text()).toContain('thread_rpc_timeout');
  proc.kill();
}, BOOT_WAIT_MS + 20_000);

// #1011: POST /capture/backfill reads every session file of every capture source, so it is a long write like /reindex. It used
// the generic writer deadline, so main answered a plain 503 thread_rpc_timeout for a pass the writer was still running. Now it
// waits the LONG deadline (CAPTAIN_MEMO_REINDEX_MS, shrunk here; the generic one is shrunk further) and then answers 202
// write_in_flight with a hint of its own: "unconfirmed", not "failed".
test('threaded worker: a /capture/backfill that outlives main\'s wait answers 202 write_in_flight, after the long deadline and not the generic one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-thr-backfill-')); dirs.push(dir);
  const port = await freePort();
  const proc = Bun.spawn(['bun', WORKER], {
    env: { ...process.env, CAPTAIN_MEMO_WORKER_THREADED: '1', CAPTAIN_MEMO_ENABLE_TEST_ENDPOINTS: '1',
      CAPTAIN_MEMO_SKIP_EMBED: '1', CAPTAIN_MEMO_SUMMARIZER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '',
      CAPTAIN_MEMO_DATA_DIR: dir, CAPTAIN_MEMO_CONFIG_DIR: dir, CAPTAIN_MEMO_WORKER_PORT: String(port),
      CAPTAIN_MEMO_REINDEX_MS: '2500', CAPTAIN_MEMO_ENGINE_REQUEST_MS: '500' },
    stdout: 'ignore', stderr: 'pipe',
  });
  procs.push(proc);
  const base = `http://localhost:${port}`;
  await waitHealthy(base, proc, tailOf(proc.stderr));

  const block = fetch(`${base}/test/block?ms=4500`);   // pins the WRITER past both deadlines; it answers 503 after the generic 0.5 s
  await Bun.sleep(200);
  const t0 = performance.now();
  const r = await fetch(`${base}/capture/backfill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const waited = performance.now() - t0;
  expect(r.status).toBe(202);
  const body = await r.json() as { status?: string; hint?: string };
  expect(body.status).toBe('write_in_flight');
  expect(body.hint).toMatch(/capture status/);          // its own check, not a memory search
  expect(body.hint).not.toMatch(/search_memory/);
  expect(waited).toBeGreaterThan(2000);                 // the 0.5 s generic deadline would have answered long before
  expect((await block).status).toBe(503);               // /test/block is not an in-flight path: its timeout is still a 503
  proc.kill();
}, BOOT_WAIT_MS + 20_000);
