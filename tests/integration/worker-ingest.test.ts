import { test, expect, beforeAll, afterAll } from 'bun:test';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let worker: WorkerHandle;
let workDir: string;
let memoryDir: string;
const PORT = 39892;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-worker-ingest-'));
  memoryDir = join(workDir, 'memory');
  mkdirSync(memoryDir, { recursive: true });

  writeFileSync(
    join(memoryDir, 'feedback_seed.md'),
    `---\ntype: feedback\ndescription: Seeded memory\n---\n\nTest seed memory.\n`
  );

  worker = await startWorker({
    port: PORT,
    projectId: 'ingest-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: ':memory:',
    embeddingDimension: 8, // small dim for fast tests
    skipEmbed: true,
    watchPaths: [join(memoryDir, '*.md')],
    watchChannel: 'memory',
  });

  // Initial indexing happens during startWorker; small grace period for FS to settle.
  await new Promise(r => setTimeout(r, 500));
});

afterAll(async () => {
  await worker.stop();
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

test('worker — initial indexing picks up existing files', async () => {
  const res = await fetch(`http://localhost:${PORT}/stats`);
  const body = await res.json() as any;
  expect(body.total_chunks).toBeGreaterThan(0);
});

test('worker — /reindex --force re-embeds all', async () => {
  const res = await fetch(`http://localhost:${PORT}/reindex`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'memory', force: true }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.indexed).toBeGreaterThan(0);
});
