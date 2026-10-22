// POST /reindex is single-flight. Measured before this existed (runaway-measure, 2026-10-21): two forced reindexes
// started together made 1,602 embed requests (2 x 800 + 2 small), both completed, 59 s each instead of 37.7 s alone.
// Real worker, real /reindex handler and ingest; only the embedding API is a stub (counts requests, answers after a
// delay so a pass stays in flight long enough to be overlapped).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmWorkDir } from '../support/worker-temp.ts';

const FILES = 3;           // one embed request per file on a forced pass
const EMBED_DELAY_MS = 200;
let embedCalls = 0;        // real document embeds only (the boot probe embeds the literal ['probe'])
let failEmbeds = false;
let stub: ReturnType<typeof Bun.serve>;
let worker: WorkerHandle;
let workDir: string;

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const b = (await req.json()) as { input: string[] };
      if (!(b.input.length === 1 && b.input[0] === 'probe')) embedCalls++;
      await Bun.sleep(EMBED_DELAY_MS);
      if (failEmbeds) return new Response('boom', { status: 500 });
      return Response.json({ data: b.input.map((_, index) => ({ index, embedding: [1, 0, 0, 0, 0, 0, 0, 0] })) });
    },
  });
  workDir = mkdtempSync(join(tmpdir(), 'cm-reindex-sf-'));
  const memoryDir = join(workDir, 'memory');
  mkdirSync(memoryDir);
  for (let i = 0; i < FILES; i++) {
    writeFileSync(join(memoryDir, `reference_${i}.md`), `---\ntype: reference\ndescription: file ${i}\n---\n\n## Heading ${i}\nbody of file number ${i}\n`);
  }
  worker = await startWorker({
    port: 0, projectId: 'reindex-sf', metaDbPath: join(workDir, 'meta.sqlite3'), vectorDbPath: join(workDir, 'vec.db'),
    embedderEndpoint: `http://localhost:${stub.port}/e`, embedderModel: 'model-A',
    embeddingDimension: 8, skipEmbed: false,
    watchPaths: [join(memoryDir, '*.md')], watchChannel: 'memory',
  });
  await settled();
});

afterAll(async () => {
  await worker.stop();
  stub.stop(true);
  rmWorkDir(workDir);
});

const reindex = (force: boolean, signal?: AbortSignal) => fetch(`http://localhost:${worker.port}/reindex`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channel: 'memory', force }), ...(signal ? { signal } : {}),
});

/** Wait until no embed request has arrived for a while (boot indexing, watcher events). */
async function settled(): Promise<void> {
  let last = -1;
  for (let quiet = 0; quiet < 4;) {
    await Bun.sleep(150);
    if (embedCalls === last) quiet++; else { quiet = 0; last = embedCalls; }
  }
}
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('until: timed out'); await Bun.sleep(20); }
}

test('a second forced reindex while one runs is refused with 409 + the start time, and spends nothing', async () => {
  const base = embedCalls;
  const first = reindex(true);
  await until(() => embedCalls > base);                    // the first pass is inside its first file

  const second = await reindex(true);
  expect(second.status).toBe(409);
  const body = await second.json() as { error: string; started_at: string; channel: string; force: boolean; detail: string };
  expect(body.error).toBe('reindex_running');
  expect(body.channel).toBe('memory');
  expect(body.force).toBe(true);
  expect(Number.isNaN(Date.parse(body.started_at))).toBe(false);
  expect(Date.now() - Date.parse(body.started_at)).toBeLessThan(5_000);
  expect(body.detail).toMatch(/^a reindex is already running, started \d\d:\d\d:\d\d, wait for it$/);

  const r1 = await first;                                   // the running pass is untouched by the refused one
  expect(r1.status).toBe(200);
  expect(await r1.json()).toMatchObject({ indexed: FILES, errors: 0 });
  expect(embedCalls - base).toBe(FILES);                    // 3, not 6: the refused request embedded nothing
});

test('the flag is released when a pass ends: the next reindex runs (and a non-force one is refused too while one runs)', async () => {
  const base = embedCalls;
  const again = await reindex(true);
  expect(again.status).toBe(200);
  expect(embedCalls - base).toBe(FILES);

  const running = reindex(true);
  await until(() => embedCalls > base + FILES);
  expect((await reindex(false)).status).toBe(409);          // any second request, force or not
  expect((await running).status).toBe(200);
});

test('a caller that hangs up does not release the flag early: it frees when the pass really ends', async () => {
  const base = embedCalls;
  const ctl = new AbortController();
  const hungUp = reindex(true, ctl.signal).catch(() => 'aborted');
  await until(() => embedCalls > base);
  ctl.abort();
  expect(await hungUp).toBe('aborted');

  expect((await reindex(true)).status).toBe(409);           // the worker still runs the pass the CLI walked away from
  await until(() => embedCalls - base >= FILES);
  await settled();
  const after = await reindex(false);                       // released once the pass finished
  expect(after.status).toBe(200);
});

test('a pass whose embeds all fail still releases the flag', async () => {
  failEmbeds = true;
  try {
    const failed = await reindex(true);
    expect(failed.status).toBe(200);                        // per-file failures are counted, not thrown
  } finally { failEmbeds = false; }
  const next = await reindex(true);
  expect(next.status).toBe(200);
  expect(await next.json()).toMatchObject({ errors: 0 });
});
