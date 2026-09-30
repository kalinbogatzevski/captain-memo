import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { MetaStore } from '../../src/worker/meta.ts';
import { VectorStore } from '../../src/worker/vector-store.ts';
import { IngestPipeline } from '../../src/worker/ingest.ts';
import { PendingEmbedQueue } from '../../src/worker/pending-embed-queue.ts';
import { findOrphanVectors } from '../../src/worker/maintenance.ts';
import { assertUsableEmbeddings } from '../../src/worker/embedder.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

// 26,818 orphaned vectors on the dev store (2026-09-30): 97% from `/reindex` force dropping documents
// without their vectors, the rest from two indexFile calls on one path overlapping across the embed await.
// Real MetaStore + VectorStore, orphans counted by the same query the sweep uses.

const DIM = 8;
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function setup(opts: { embedDelayMs?: number; embed?: (t: string[]) => Promise<number[][]>; pending?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-leak-'));
  const metaPath = join(dir, 'meta.sqlite3');
  const vecPath = join(dir, 'emb.db');
  const meta = new MetaStore(metaPath);
  const vector = new VectorStore({ dbPath: vecPath, dimension: DIM });
  const pending = opts.pending ? new PendingEmbedQueue(join(dir, 'pending.db')) : undefined;
  const embedder = {
    embed: opts.embed ?? (async (t: string[]) => {
      await new Promise(r => setTimeout(r, opts.embedDelayMs ?? 0));
      return t.map((_, i) => Array.from({ length: DIM }, (_, k) => (i + k + 1) / 10));
    }),
  };
  const ingest = new IngestPipeline({
    meta, vector, embedder, collectionName: 'am_default', projectId: 'default',
    ...(pending && { pendingEmbed: pending }),
  });
  const file = join(dir, 'reference_x.md');
  const write = (n: number) => writeFileSync(file, `---\nname: x\ndescription: d\ntype: reference\n---\n\n## A\nbody ${n} a\n\n## B\nbody ${n} b\n`);
  const vecDb = new Database(vecPath, { readonly: true });
  const orphans = async () => (await findOrphanVectors(vecDb, metaPath)).length;
  const vecs = () => (vecDb.query('SELECT count(*) n FROM vec_chunk_meta').get() as { n: number }).n;
  const chunks = () => { const d = meta.getDocument(file); return d ? meta.getChunksForDocument(d.id).length : 0; };
  cleanups.push(() => { vecDb.close(); vector.close(); meta.close(); pending?.close(); rmWorkDir(dir); });
  return { meta, ingest, file, write, orphans, vecs, chunks, pending, vector };
}

test('sequential edits leave no orphans', async () => {
  const s = setup();
  for (const n of [1, 2, 3]) { s.write(n); await s.ingest.indexFile(s.file, 'memory'); }
  expect(await s.orphans()).toBe(0);
  expect(s.vecs()).toBe(s.chunks());
});

test('the /reindex force path (deleteFile, then indexFile) orphans nothing', async () => {
  const s = setup();
  s.write(1); await s.ingest.indexFile(s.file, 'memory');
  for (let i = 0; i < 2; i++) { await s.ingest.deleteFile(s.file); await s.ingest.indexFile(s.file, 'memory'); }
  expect(await s.orphans()).toBe(0);
  expect(s.vecs()).toBe(s.chunks());
});

test('(c) two overlapping indexFile calls on the same path orphan nothing', async () => {
  const s = setup({ embedDelayMs: 30 });
  s.write(1); await s.ingest.indexFile(s.file, 'memory');
  s.write(2);
  const p1 = s.ingest.indexFile(s.file, 'memory');      // watcher change #1
  await new Promise(r => setTimeout(r, 5));
  s.write(3);
  const p2 = s.ingest.indexFile(s.file, 'memory');      // watcher change #2 while #1 is still embedding
  await Promise.all([p1, p2]);
  expect(await s.orphans()).toBe(0);
  expect(s.vecs()).toBe(s.chunks());
});

test('(d) a forced pass overlapped by a plain reindex of the same file orphans nothing (Sep 10)', async () => {
  const s = setup({ embedDelayMs: 30 });
  s.write(1); await s.ingest.indexFile(s.file, 'memory');
  const force = (async () => { await s.ingest.deleteFile(s.file); await s.ingest.indexFile(s.file, 'memory'); })();
  await new Promise(r => setTimeout(r, 5));
  const plain = s.ingest.indexFile(s.file, 'memory');
  await Promise.all([force, plain]);
  expect(await s.orphans()).toBe(0);
  expect(s.vecs()).toBe(s.chunks());
});

test('an embed failure queues the chunks for retry and stores no vector (never zeros)', async () => {
  const s = setup({ pending: true, embed: async () => { throw new Error('Embedder HTTP 429: rate limited'); } });
  s.write(1); await s.ingest.indexFile(s.file, 'memory');
  expect(s.chunks()).toBe(2);                            // keyword search still has the chunks
  expect(s.vecs()).toBe(0);
  expect(s.pending!.totalCount()).toBe(2);
});

test('an embed failure with no queue throws and leaves the existing index intact', async () => {
  let fail = false;
  const s = setup({ embed: async (t) => {
    if (fail) throw new Error('down');
    return t.map(() => Array.from({ length: DIM }, () => 0.5));
  } });
  s.write(1); await s.ingest.indexFile(s.file, 'memory');
  fail = true; s.write(2);
  await expect(s.ingest.indexFile(s.file, 'memory')).rejects.toThrow('down');
  expect(s.vecs()).toBe(2);
  expect(await s.orphans()).toBe(0);
});

test('assertUsableEmbeddings rejects all-zero and non-finite vectors', () => {
  expect(assertUsableEmbeddings([[0.1, 0], [0, -2]])).toHaveLength(2);
  expect(() => assertUsableEmbeddings([[0.1, 0], [0, 0]])).toThrow('input 1');
  expect(() => assertUsableEmbeddings([[NaN, 1]])).toThrow('unusable');
  expect(() => assertUsableEmbeddings([[Infinity, 1]])).toThrow('unusable');
});
