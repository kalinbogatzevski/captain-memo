import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

// The threaded worker runs search/inject queries in READER engines, each with its own Embedder. /stats used to report
// only the writer's, so a prompt storm cost tokens nobody saw. Here a stand-in provider counts the requests it really
// receives, and /stats must account for every one of them, the readers' included.
const WORKER = fileURLToPath(new URL('../../src/worker/index.ts', import.meta.url));
const procs: Array<{ kill: () => void }> = []; const dirs: string[] = []; const servers: Array<{ stop: (f?: boolean) => void }> = [];
afterAll(() => {
  for (const p of procs) try { p.kill(); } catch {}
  for (const s of servers) try { s.stop(true); } catch {}
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch {}
});

const DIM = 8;
async function freePort(): Promise<number> { const s = Bun.serve({ port: 0, fetch: () => new Response('') }); const p = s.port ?? 0; s.stop(true); return p; }
async function waitHealthy(base: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(`${base}/health`)).ok) return; } catch {} await Bun.sleep(150); }
  throw new Error('never healthy');
}

test('threaded worker: /stats embedder_usage includes the readers and matches what the provider received', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-thr-eu-')); dirs.push(dir);
  mkdirSync(join(dir, 'mem'), { recursive: true });
  writeFileSync(join(dir, 'mem', 'n.md'), '# note\n\nhello threaded world\n');
  const provider = { requests: 0, queries: 0 };
  const fake = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const b = await req.json() as { input: string[]; input_type?: string };
      provider.requests += 1;
      if (b.input_type === 'query') provider.queries += 1;
      return Response.json({ data: b.input.map((_, i) => ({ embedding: Array.from({ length: DIM }, (_, k) => (k === i % DIM ? 1 : 0.1)), index: i })), model: 'stand-in' });
    },
  });
  servers.push(fake);
  const port = await freePort();
  const proc = Bun.spawn(['bun', WORKER], {
    env: { ...process.env, CAPTAIN_MEMO_WORKER_THREADED: '1', CAPTAIN_MEMO_READER_POOL_SIZE: '2',
      CAPTAIN_MEMO_EMBEDDER_ENDPOINT: `http://localhost:${fake.port}/v1/embeddings`, CAPTAIN_MEMO_EMBEDDER_MODEL: 'stand-in', CAPTAIN_MEMO_EMBEDDING_DIM: String(DIM),
      CAPTAIN_MEMO_SKIP_EMBED: '', CAPTAIN_MEMO_SUMMARIZER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '',
      CAPTAIN_MEMO_DATA_DIR: dir, CAPTAIN_MEMO_CONFIG_DIR: dir, CAPTAIN_MEMO_WORKER_PORT: String(port), CAPTAIN_MEMO_WATCH_MEMORY: join(dir, 'mem', '*.md') },
    stdout: 'ignore', stderr: 'ignore',
  });
  procs.push(proc);
  const base = `http://localhost:${port}`;
  await waitHealthy(base);

  const search = (q: string) => fetch(`${base}/search/all`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q, top_k: 3 }) }).then(r => r.json());
  for (const q of ['hello', 'threaded world', 'a third question', 'and a fourth']) await search(q);
  const stats = async () => (await (await fetch(`${base}/stats`)).json() as { embedder_usage?: { calls: number; tokens: number; readers?: number; by_source: Record<string, { calls: number; tokens: number }> } }).embedder_usage;

  // Readers report on change, at most every 5 s: wait for the total to settle on what the provider really got.
  const end = Date.now() + 20_000;
  let u = await stats();
  while (Date.now() < end && !(u && u.calls === provider.requests && (u.readers ?? 0) >= 1)) { await Bun.sleep(500); u = await stats(); }

  expect(provider.queries).toBeGreaterThanOrEqual(4);          // the four searches reached the provider ...
  expect(u!.readers).toBeGreaterThanOrEqual(1);                 // ... through a reader ...
  expect(u!.calls).toBe(provider.requests);                     // ... and every request is in the total
  expect(u!.by_source.query!.calls).toBe(provider.queries);
  expect(u!.tokens).toBeGreaterThan(0);

  // Quiet: with nothing asked, the figure stays put (nothing is counted twice, nothing keeps growing).
  const before = u!.calls;
  await Bun.sleep(6_000);
  expect((await stats())!.calls).toBe(before);
}, 60_000);
