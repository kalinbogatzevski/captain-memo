import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { rmWorkDir } from '../support/worker-temp.ts';

// fileURLToPath (not URL.pathname): on Windows `.pathname` is "/C:/…/index.ts"
// (leading slash before the drive), which `bun <path>` cannot resolve — the
// spawned worker dies with "Module not found" and never binds, so the test
// times out at "never healthy". fileURLToPath yields a real "C:\…" path.
const WORKER = fileURLToPath(new URL('../../src/worker/index.ts', import.meta.url));
const procs: Array<{ kill: () => void }> = []; const dirs: string[] = [];
afterAll(() => { for (const p of procs) try { p.kill(); } catch {} for (const d of dirs) rmWorkDir(d); });

async function freePort(): Promise<number> { const s = Bun.serve({ port: 0, fetch: () => new Response('') }); const p = s.port ?? 0; s.stop(true); return p; }
async function waitHealthy(base: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(`${base}/health`)).ok) return; } catch {} await Bun.sleep(150); }
  throw new Error('never healthy');
}

test('threaded worker: /health stays fast while the engine is blocked 5s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-thr-')); dirs.push(dir);
  mkdirSync(join(dir, 'mem'), { recursive: true });
  writeFileSync(join(dir, 'mem', 'n.md'), '# note\n\nhello threaded world\n');
  const port = await freePort();
  const proc = Bun.spawn(['bun', WORKER], {
    env: { ...process.env, CAPTAIN_MEMO_WORKER_THREADED: '1', CAPTAIN_MEMO_ENABLE_TEST_ENDPOINTS: '1',
      CAPTAIN_MEMO_SKIP_EMBED: '1', CAPTAIN_MEMO_SUMMARIZER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '',
      CAPTAIN_MEMO_DATA_DIR: dir, CAPTAIN_MEMO_WORKER_PORT: String(port), CAPTAIN_MEMO_WATCH_MEMORY: join(dir, 'mem', '*.md') },
    stdout: 'ignore', stderr: 'ignore',
  });
  procs.push(proc);
  const base = `http://localhost:${port}`;
  await waitHealthy(base);

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
}, 40_000);
