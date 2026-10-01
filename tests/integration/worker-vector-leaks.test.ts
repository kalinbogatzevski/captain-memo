import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { MetaStore } from '../../src/worker/meta.ts';
import { PendingEmbedQueue } from '../../src/worker/pending-embed-queue.ts';
import { findOrphanVectors } from '../../src/worker/maintenance.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

// The real /reindex handler and pending_embed tick, against file-backed stores the test can inspect.
// The embedder is a local stub server; no real embedder API is called.

let worker: WorkerHandle | null = null;
let stub: ReturnType<typeof Bun.serve> | null = null;
let workDir = '';
afterEach(async () => {
  if (worker) await worker.stop();
  stub?.stop(true);
  worker = null; stub = null;
  rmWorkDir(workDir);
});

const vecIds = (path: string): string[] => {
  const db = new Database(path, { readonly: true });
  try { return (db.query('SELECT chunk_id FROM vec_chunk_meta').all() as Array<{ chunk_id: string }>).map(r => r.chunk_id); }
  finally { db.close(); }
};

test('POST /reindex force, twice, leaves no orphaned vectors', async () => {
  workDir = mkdtempSync(join(tmpdir(), 'cm-reindex-leak-'));
  const memoryDir = join(workDir, 'memory');
  mkdirSync(memoryDir);
  writeFileSync(join(memoryDir, 'reference_a.md'), '---\ntype: reference\ndescription: a\n---\n\n## One\nfirst\n\n## Two\nsecond\n');
  const metaPath = join(workDir, 'meta.sqlite3');
  const vecPath = join(workDir, 'vec.db');
  worker = await startWorker({
    port: 0, projectId: 'leak', metaDbPath: metaPath, vectorDbPath: vecPath,
    embedderEndpoint: 'http://localhost:0/unused', embedderModel: 'voyage-4-nano',
    embeddingDimension: 8, skipEmbed: true,
    watchPaths: [join(memoryDir, '*.md')], watchChannel: 'memory',
  });
  const reindex = async (force: boolean) => {
    const res = await fetch(`http://localhost:${worker!.port}/reindex`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'memory', force }),
    });
    expect(res.status).toBe(200);
    return await res.json() as { indexed: number; errors: number };
  };
  await reindex(false);                 // settles behind the initial indexing pass (same path queue)
  const before = vecIds(vecPath).length;
  expect(before).toBeGreaterThan(0);
  for (let i = 0; i < 2; i++) {
    const r = await reindex(true);
    expect(r.indexed).toBe(1);
    expect(r.errors).toBe(0);
  }
  const db = new Database(vecPath, { readonly: true });
  try { expect(await findOrphanVectors(db, metaPath)).toEqual([]); } finally { db.close(); }
  expect(vecIds(vecPath).length).toBe(before);
});

test('pending_embed retry stores no vector for a chunk replaced while its embed was in flight', async () => {
  workDir = mkdtempSync(join(tmpdir(), 'cm-pe-recheck-'));
  const metaPath = join(workDir, 'meta.sqlite3');
  const vecPath = join(workDir, 'vec.db');
  const pendingPath = join(workDir, 'pending.db');

  // Seed two live chunks, both queued for (re-)embedding.
  const meta = new MetaStore(metaPath);
  const keep = meta.upsertDocument({ source_path: '/m/keep.md', channel: 'memory', project_id: 'pe', sha: 'k', mtime_epoch: 1, metadata: {} });
  meta.replaceChunksForDocument(keep, [{ chunk_id: 'memory:keep:c1', text: 'keep me', sha: 'a', position: 0, metadata: {} }]);
  const gone = meta.upsertDocument({ source_path: '/m/gone.md', channel: 'memory', project_id: 'pe', sha: 'g', mtime_epoch: 1, metadata: {} });
  meta.replaceChunksForDocument(gone, [{ chunk_id: 'memory:gone:c1', text: 'replace me mid-embed', sha: 'b', position: 0, metadata: {} }]);
  const seed = new PendingEmbedQueue(pendingPath);
  seed.enqueue({ chunk_id: 'memory:keep:c1', source_path: '/m/keep.md', sha: 'a', channel: 'memory' });
  seed.enqueue({ chunk_id: 'memory:gone:c1', source_path: '/m/gone.md', sha: 'b', channel: 'memory' });
  seed.close();

  // Stub embedder: when the retry batch arrives, the second document is dropped (as a re-index would)
  // BEFORE the vectors come back.
  stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as { input: string[] };
      if (body.input.includes('replace me mid-embed')) meta.deleteDocument('/m/gone.md');
      return Response.json({ model: 'stub', data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0, 0, 0, 0, 0, 0] })) });
    },
  });
  worker = await startWorker({
    port: 0, projectId: 'pe', metaDbPath: metaPath, vectorDbPath: vecPath,
    embedderEndpoint: `http://localhost:${stub.port}/v1/embeddings`, embedderModel: 'voyage-4-nano',
    embeddingDimension: 8, pendingEmbedDbPath: pendingPath, pendingEmbedTickMs: 100,
  });

  const probe = new PendingEmbedQueue(pendingPath);
  try {
    for (let i = 0; i < 50 && probe.totalCount() > 0; i++) await new Promise(r => setTimeout(r, 100));
    expect(probe.totalCount()).toBe(0);
  } finally { probe.close(); }
  expect(vecIds(vecPath)).toEqual(['memory:keep:c1']);
  meta.close();
});

test('a zero-vector embed response from the worker\'s ingest path is queued for retry, never stored', async () => {
  workDir = mkdtempSync(join(tmpdir(), 'cm-zero-ingest-'));
  const memoryDir = join(workDir, 'memory');
  mkdirSync(memoryDir);
  writeFileSync(join(memoryDir, 'reference_z.md'), '---\ntype: reference\ndescription: z\n---\n\n## One\nfirst\n\n## Two\nsecond\n');
  const metaPath = join(workDir, 'meta.sqlite3');
  const vecPath = join(workDir, 'vec.db');
  const pendingPath = join(workDir, 'pending.db');
  // Stub embedder: a good vector for the boot probe, all zeros for everything else.
  stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as { input: string[] };
      const v = body.input[0] === 'probe' ? [1, 0, 0, 0, 0, 0, 0, 0] : [0, 0, 0, 0, 0, 0, 0, 0];
      return Response.json({ model: 'stub', data: body.input.map((_, index) => ({ index, embedding: v })) });
    },
  });
  worker = await startWorker({
    port: 0, projectId: 'zero', metaDbPath: metaPath, vectorDbPath: vecPath,
    embedderEndpoint: `http://localhost:${stub.port}/v1/embeddings`, embedderModel: 'voyage-4-nano',
    embeddingDimension: 8, pendingEmbedDbPath: pendingPath, pendingEmbedTickMs: 100,
    watchPaths: [join(memoryDir, '*.md')], watchChannel: 'memory',
  });
  const res = await fetch(`http://localhost:${worker.port}/reindex`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'memory' }),
  });
  expect(res.status).toBe(200);
  await new Promise(r => setTimeout(r, 400));     // a few retry ticks: they fail the same way and back off
  const meta = new MetaStore(metaPath);
  const doc = meta.getDocument(join(memoryDir, 'reference_z.md'));
  const chunks = doc ? meta.getChunksForDocument(doc.id).length : 0;
  meta.close();
  expect(chunks).toBeGreaterThan(0);              // keyword search still has the file
  expect(vecIds(vecPath)).toEqual([]);            // no zero vector stored
  const pending = new PendingEmbedQueue(pendingPath);
  try { expect(pending.totalCount()).toBe(chunks); } finally { pending.close(); }
});

test('one chunk the embedder always refuses no longer holds back the rest of its batch, and gets parked', async () => {
  // #226(c): the batch of 25 failed as a whole on every tick, so 24 good chunks never got a vector.
  workDir = mkdtempSync(join(tmpdir(), 'cm-pe-isolate-'));
  const metaPath = join(workDir, 'meta.sqlite3');
  const vecPath = join(workDir, 'vec.db');
  const pendingPath = join(workDir, 'pending.db');
  const meta = new MetaStore(metaPath);
  const seed = new PendingEmbedQueue(pendingPath);
  const doc = meta.upsertDocument({ source_path: '/m/batch.md', channel: 'memory', project_id: 'pe', sha: 'k', mtime_epoch: 1, metadata: {} });
  const ids = Array.from({ length: 25 }, (_, i) => `memory:batch:c${String(i).padStart(2, '0')}`);
  meta.replaceChunksForDocument(doc, ids.map((chunk_id, i) => ({
    chunk_id, text: i === 13 ? 'poison' : `good ${i}`, sha: `s${i}`, position: i, metadata: {},
  })));
  for (const chunk_id of ids) seed.enqueue({ chunk_id, source_path: '/m/batch.md', sha: 's', channel: 'memory' });
  // The poison chunk has already failed 7 times; one more on its own parks it.
  const raw = new Database(pendingPath);
  raw.query('UPDATE pending_embed SET retries = 7 WHERE chunk_id = ?').run(ids[13]!);
  raw.close();
  seed.close();
  meta.close();

  let calls = 0;
  stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as { input: string[] };
      if (body.input[0] !== 'probe') calls++;
      if (body.input.includes('poison')) return new Response('input rejected by the model', { status: 400 });
      return Response.json({ model: 'stub', data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0, 0, 0, 0, 0, 0] })) });
    },
  });
  worker = await startWorker({
    port: 0, projectId: 'pe', metaDbPath: metaPath, vectorDbPath: vecPath,
    embedderEndpoint: `http://localhost:${stub.port}/v1/embeddings`, embedderModel: 'voyage-4-nano',
    embeddingDimension: 8, pendingEmbedDbPath: pendingPath, pendingEmbedTickMs: 100,
  });

  const probe = new PendingEmbedQueue(pendingPath);
  try {
    for (let i = 0; i < 50 && probe.failureState().parked === 0; i++) await new Promise(r => setTimeout(r, 100));
    expect(probe.failureState()).toMatchObject({ pending: 1, parked: 1 });
    expect(probe.listDue(25)).toEqual([]);                       // parked: not due again for a day
  } finally { probe.close(); }
  expect(vecIds(vecPath).sort()).toEqual(ids.filter((_, i) => i !== 13));
  expect(calls).toBeLessThanOrEqual(12);
  const stats = await (await fetch(`http://localhost:${worker.port}/stats`)).json() as { observations: { embed_parked?: number } };
  expect(stats.observations.embed_parked).toBe(1);
});

test('an embedder that refuses every input parks nothing', async () => {
  // A wrong model name is an HTTP 400 for every input: that is the embedder, not the chunks.
  workDir = mkdtempSync(join(tmpdir(), 'cm-pe-all400-'));
  const metaPath = join(workDir, 'meta.sqlite3');
  const pendingPath = join(workDir, 'pending.db');
  const meta = new MetaStore(metaPath);
  const seed = new PendingEmbedQueue(pendingPath);
  const doc = meta.upsertDocument({ source_path: '/m/all.md', channel: 'memory', project_id: 'pe', sha: 'k', mtime_epoch: 1, metadata: {} });
  const ids = ['memory:all:c0', 'memory:all:c1', 'memory:all:c2', 'memory:all:c3'];
  meta.replaceChunksForDocument(doc, ids.map((chunk_id, i) => ({ chunk_id, text: `t${i}`, sha: `s${i}`, position: i, metadata: {} })));
  for (const chunk_id of ids) seed.enqueue({ chunk_id, source_path: '/m/all.md', sha: 's', channel: 'memory' });
  const raw = new Database(pendingPath);
  raw.exec('UPDATE pending_embed SET retries = 7');
  raw.close();
  seed.close();
  meta.close();

  stub = Bun.serve({ port: 0, fetch: () => new Response('unknown model', { status: 400 }) });
  worker = await startWorker({
    port: 0, projectId: 'pe', metaDbPath: metaPath, vectorDbPath: join(workDir, 'vec.db'),
    embedderEndpoint: `http://localhost:${stub.port}/v1/embeddings`, embedderModel: 'voyage-4-nano',
    embeddingDimension: 8, pendingEmbedDbPath: pendingPath, pendingEmbedTickMs: 100,
  });
  const probe = new PendingEmbedQueue(pendingPath);
  try {
    for (let i = 0; i < 30 && probe.listDue(25).length > 0; i++) await new Promise(r => setTimeout(r, 100));
    expect(probe.listDue(25)).toEqual([]);                        // the pass ran: every row is backing off
    expect(probe.failureState()).toMatchObject({ pending: 4, parked: 0 });
  } finally { probe.close(); }
});
