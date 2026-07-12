// tests/integration/reader-pool.test.ts
//
// Integration proof for Task 8 — the reader-pool orchestration in
// threaded-main.ts. Spawns the REAL worker process with the threaded flag and a
// reader pool, then asserts the property the whole split exists to guarantee:
//
//   /health (computed on the MAIN thread from the WRITER heartbeat only) stays
//   200/healthy even under a burst of concurrent searches — because reads run on
//   the read-only reader engines, not on the writer that owns the heartbeat.
//
// Pre-split (every search on the single engine), a burst like assertion 2 below
// stalls the engine event loop, the heartbeat goes stale, and /health degrades.
//
// Reuses the spawn/seed harness shape from worker-threaded.test.ts +
// worker-retrieval-tracking.test.ts (Bun.spawn of the worker, /health wait,
// /observation/enqueue+flush seed). A throwaway local OpenAI-compatible endpoint
// supplies a deterministic summary so the spawned worker can actually create an
// observation (it has no real summarizer credentials).
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

// fileURLToPath (not URL.pathname): on Windows `.pathname` is "/C:/…/index.ts",
// which `bun <path>` cannot resolve. See worker-threaded.test.ts for the why.
const WORKER = fileURLToPath(new URL('../../src/worker/index.ts', import.meta.url));

const procs: Array<{ kill: () => void }> = [];
const dirs: string[] = [];
const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterAll(() => {
  for (const p of procs) try { p.kill(); } catch {}
  for (const s of servers) try { s.stop(true); } catch {}
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch {}
});

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') });
  const p = s.port ?? 0; s.stop(true); return p;
}

async function waitHealthy(base: string, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await Bun.sleep(150);
  }
  throw new Error('never healthy');
}

// Deterministic OpenAI-compatible summarizer endpoint. Echoes a fixed marker
// into the title so a keyword (FTS) search under skipEmbed lexically hits the
// observation it produces. Returns the exact {type,title,narrative,facts,concepts}
// JSON the summarizer schema requires, wrapped in the chat-completions shape.
const OBS_MARKER = 'readerpoolmarker';
function startStubSummarizer(): { url: string; stop: () => void } {
  const srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async () => {
      const summary = JSON.stringify({
        type: 'discovery',
        title: `${OBS_MARKER} observation`,
        narrative: `${OBS_MARKER} narrative`,
        facts: [`${OBS_MARKER} fact`],
        concepts: [OBS_MARKER],
      });
      return Response.json({
        model: 'stub',
        choices: [{ message: { role: 'assistant', content: summary }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      });
    },
  });
  servers.push(srv);
  return { url: `http://127.0.0.1:${srv.port}/v1/chat/completions`, stop: () => srv.stop(true) };
}

function spawnWorker(poolSize: number, extraEnv: Record<string, string> = {}): {
  proc: ReturnType<typeof Bun.spawn>; base: string; dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'cm-rpool-')); dirs.push(dir);
  mkdirSync(join(dir, 'mem'), { recursive: true });
  writeFileSync(join(dir, 'mem', 'n.md'), '# note\n\nhello reader pool world\n');
  const port = Number(extraEnv.CAPTAIN_MEMO_WORKER_PORT ?? 0);
  const proc = Bun.spawn(['bun', WORKER], {
    env: {
      ...process.env,
      CAPTAIN_MEMO_WORKER_THREADED: '1',
      CAPTAIN_MEMO_READER_POOL_SIZE: String(poolSize),
      CAPTAIN_MEMO_ENABLE_TEST_ENDPOINTS: '1',
      CAPTAIN_MEMO_SKIP_EMBED: '1',
      ANTHROPIC_API_KEY: '',
      CAPTAIN_MEMO_DATA_DIR: dir, CAPTAIN_MEMO_CONFIG_DIR: dir,
      CAPTAIN_MEMO_WORKER_PORT: String(port),
      CAPTAIN_MEMO_WATCH_MEMORY: join(dir, 'mem', '*.md'),
      ...extraEnv,
    },
    stdout: 'ignore', stderr: 'ignore',
  });
  procs.push(proc);
  return { proc, base: `http://localhost:${port}`, dir };
}

async function seedObservation(base: string): Promise<void> {
  await fetch(`${base}/observation/enqueue`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 'seed', project_id: 'p', prompt_number: 1,
      tool_name: 'Edit', tool_input_summary: OBS_MARKER, tool_result_summary: 'ok',
      files_read: [], files_modified: [], ts_epoch: 1_700_000_000,
    }),
  });
  const flush = await fetch(`${base}/observation/flush`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'seed' }),
  });
  const body = await flush.json() as { observations_created: number };
  expect(body.observations_created).toBeGreaterThanOrEqual(1);
}

// ───────────────────────────────────────────────────────────────────────────

test('reader pool: /health healthy after boot; stays healthy under a search burst', async () => {
  const port = await freePort();
  const { base } = spawnWorker(2, { CAPTAIN_MEMO_WORKER_PORT: String(port) });
  await waitHealthy(base);

  // Assertion 1: healthy after boot.
  const h0 = await fetch(`${base}/health`);
  expect(h0.status).toBe(200);
  expect((await h0.json() as { healthy: boolean }).healthy).toBe(true);

  // Assertion 2 (the regression guard). A read that pins the engine event loop
  // for >5s is the production failure mode: pre-split it runs on the SINGLE
  // engine, the heartbeat goes stale, and /health flips to 503. We reproduce it
  // with a test-only block on /search/observations (a READ route) — one long
  // 6.5s block plus 11 concurrent reads — and assert that with the reader pool
  // the WRITER keeps beating throughout, so EVERY health poll stays 200.
  //
  // The block runs on a READER engine; the writer (which owns the heartbeat) is
  // never touched, so /health is uninterrupted. Pre-implementation (pool not
  // wired) the block lands on the writer and these polls go 503 — that is the
  // regression this test guards against.
  const longBlock = fetch(`${base}/search/observations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ block_ms: 6500 }),
  }).then(r => r.text()).catch(() => null);
  const reads = Array.from({ length: 11 }, () =>
    fetch(`${base}/search/observations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'hello reader pool', top_k: 5 }),
    }).then(r => r.text()).catch(() => null),
  );

  const healthStatuses: number[] = [];
  const poller = (async () => {
    // Poll across the full ~8s window so a stale-beat degrade can't slip between polls.
    for (let i = 0; i < 40; i++) {
      try { healthStatuses.push((await fetch(`${base}/health`)).status); }
      catch { healthStatuses.push(0); }
      await Bun.sleep(200);
    }
  })();

  await Promise.all([longBlock, ...reads, poller]);

  expect(healthStatuses.length).toBe(40);
  for (const s of healthStatuses) expect(s).toBe(200);
}, 60_000);

test('reader pool: a reader-served search forwards its bump to the writer', async () => {
  const stub = startStubSummarizer();
  const port = await freePort();
  const { base } = spawnWorker(2, {
    CAPTAIN_MEMO_WORKER_PORT: String(port),
    CAPTAIN_MEMO_SUMMARIZER_PROVIDER: 'openai-compatible',
    CAPTAIN_MEMO_OPENAI_ENDPOINT: stub.url,
  });
  await waitHealthy(base);

  // Seed a real observation (write path → writer). The stub summarizer turns the
  // enqueued event into an observation whose title carries OBS_MARKER.
  await seedObservation(base);

  const statsBefore = await (await fetch(`${base}/stats`)).json() as { recall: { totals: { search: number } } };
  const searchBefore = statsBefore.recall.totals.search;

  // A search that hits the seeded observation. Routed to a READER engine.
  const res = await fetch(`${base}/search/observations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: OBS_MARKER, top_k: 5 }),
  });
  expect(res.status).toBe(200);
  const hits = (await res.json() as { results: unknown[] }).results;
  expect(hits.length).toBeGreaterThan(0);

  // The reader posts a {kind:'bump'} to main, which relays it to the writer; the
  // writer applies it to its obs store. Poll /stats (served by the writer) until
  // from-search rises — proving the cross-thread bump relay works end to end.
  let searchAfter = searchBefore;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const s = await (await fetch(`${base}/stats`)).json() as { recall: { totals: { search: number } } };
    searchAfter = s.recall.totals.search;
    if (searchAfter > searchBefore) break;
    await Bun.sleep(150);
  }
  expect(searchAfter).toBeGreaterThan(searchBefore);
}, 60_000);

test('reader pool N=0: search still served (by the writer) and worker is healthy', async () => {
  const port = await freePort();
  const { base } = spawnWorker(0, { CAPTAIN_MEMO_WORKER_PORT: String(port) });
  await waitHealthy(base);

  const res = await fetch(`${base}/search/all`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'hello', top_k: 3 }),
  });
  expect(res.status).toBe(200);
  expect(Array.isArray((await res.json() as { results: unknown[] }).results)).toBe(true);

  const h = await fetch(`${base}/health`);
  expect(h.status).toBe(200);
}, 60_000);
