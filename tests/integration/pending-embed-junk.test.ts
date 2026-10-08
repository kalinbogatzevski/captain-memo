import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { MetaStore } from '../../src/worker/meta.ts';
import { PendingEmbedQueue } from '../../src/worker/pending-embed-queue.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

// 2026-10-08. On one captain a too-wide watcher had indexed Codex's own database files as memory
// before the 2026-10-01 fix. The chunks sat in the retry queue and went to the embedder again and again (260 rows retried
// 68,043 times, 7.29M tokens in a morning). A row for a chunk ingest now refuses must be dropped, not sent.
let worker: WorkerHandle | null = null;
let workDir = '';
let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(async () => {
  if (worker) await worker.stop();
  server?.stop();
  worker = null; server = null;
  rmWorkDir(workDir);
});

test('the retry queue drops rows for non-markdown and binary chunks without sending them, and embeds the normal one', async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-pe-junk-'));
  const metaPath = join(workDir, 'meta.sqlite3');
  const pendingPath = join(workDir, 'pending.db');

  const meta = new MetaStore(metaPath);
  const mk = (path: string, channel: 'memory' | 'observation', chunkId: string, text: string) => {
    const id = meta.upsertDocument({ source_path: path, channel, project_id: 'pe-junk', sha: 's', mtime_epoch: 1, metadata: {} });
    meta.replaceChunksForDocument(id, [{ chunk_id: chunkId, text, sha: 's', position: 0, metadata: {} }]);
  };
  mk('/home/x/.codex/logs_2.sqlite-wal', 'memory', 'c-wal', 'JUNK-WAL text that looks harmless');
  mk('observation:pe-junk:1', 'observation', 'c-bin', 'JUNK-BINARY \0 with a NUL byte');
  mk('/home/x/memory/note.md', 'memory', 'c-good', 'GOOD note text');
  meta.close();

  const queue = new PendingEmbedQueue(pendingPath);
  for (const [cid, path, ch] of [['c-wal', '/home/x/.codex/logs_2.sqlite-wal', 'memory'], ['c-bin', 'observation:pe-junk:1', 'observation'], ['c-good', '/home/x/memory/note.md', 'memory']] as const) {
    queue.enqueue({ chunk_id: cid, source_path: path, sha: 's', channel: ch });
  }
  queue.close();

  const sent: string[] = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as { input: string[] };
      sent.push(...body.input);
      return new Response(JSON.stringify({ data: body.input.map((_, i) => ({ embedding: Array.from({ length: 8 }, () => 0.5), index: i })), model: 'x' }));
    },
  });

  worker = await startWorker({
    port: 0,
    projectId: 'pe-junk',
    metaDbPath: metaPath,
    embedderEndpoint: `http://localhost:${server.port}/v1/embeddings`,
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    pendingEmbedDbPath: pendingPath,
    pendingEmbedTickMs: 100,
  });

  const total = async () => ((await (await fetch(`http://localhost:${worker!.port}/pending_embed/retry`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ max: 50 }),
  })).json()) as { total_pending: number }).total_pending;
  for (let i = 0; i < 60 && (await total()) > 0; i++) await Bun.sleep(100);

  expect(await total()).toBe(0);
  expect(sent.some(t => t.startsWith('GOOD'))).toBe(true);    // the normal chunk was embedded
  expect(sent.some(t => t.includes('JUNK'))).toBe(false);     // nothing refused ever reached the embedder
});
