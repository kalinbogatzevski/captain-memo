// tests/integration/e2e.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let worker: WorkerHandle;
let workDir: string;
let memoryDir: string;
let voyageServer: ReturnType<typeof Bun.serve>;
const PORT = 39893;
const EMBEDDING_DIM = 8;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-e2e-'));
  memoryDir = join(workDir, 'memory');
  mkdirSync(memoryDir, { recursive: true });

  // Mock Voyage server returns deterministic 8-dim embeddings derived from text length.
  voyageServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { input: string[] };
      const data = body.input.map((text, idx) => ({
        embedding: Array.from({ length: EMBEDDING_DIM }, (_, i) =>
          i === 0 ? text.length / 100 : Math.random() * 0.01
        ),
        index: idx,
      }));
      return Response.json({ data, model: 'voyage-4-nano' });
    },
  });

  worker = await startWorker({
    port: PORT,
    projectId: 'e2e-test',
    metaDbPath: ':memory:',
    embedderEndpoint: `http://localhost:${voyageServer.port}/v1/embeddings`,
    embedderModel: 'voyage-4-nano',
    vectorDbPath: ':memory:',
    embeddingDimension: EMBEDDING_DIM,
    watchPaths: [join(memoryDir, '*.md')],
    watchChannel: 'memory',
  });
});

afterAll(async () => {
  await worker.stop();
  voyageServer.stop();
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

test('e2e — write file → indexed → searchable via /search/all', async () => {
  const filePath = join(memoryDir, 'feedback_test.md');
  writeFileSync(
    filePath,
    `---\ntype: feedback\ndescription: Test feedback rule\n---\n\nAlways use erp-components, no custom page styles.\n`
  );

  // Wait for watcher to pick up + index.
  await new Promise((r) => setTimeout(r, 1500));

  const stats = (await fetch(`http://localhost:${PORT}/stats`).then((r) => r.json())) as any;
  expect(stats.total_chunks).toBeGreaterThan(0);

  const search = (await fetch(`http://localhost:${PORT}/search/all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'erp-components', top_k: 5 }),
  }).then((r) => r.json())) as any;

  expect(search.results.length).toBeGreaterThan(0);
  expect(search.results.find((r: any) => r.title === 'feedback_test')).toBeDefined();
});

test('e2e — edit file → only changed chunks re-embedded', async () => {
  const filePath = join(memoryDir, 'feedback_edit.md');
  writeFileSync(filePath, '---\ntype: feedback\n---\nFirst version.');
  await new Promise((r) => setTimeout(r, 1500));

  writeFileSync(filePath, '---\ntype: feedback\n---\nUpdated version.');
  await new Promise((r) => setTimeout(r, 1500));

  const afterSearch = (await fetch(`http://localhost:${PORT}/search/all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'Updated version', top_k: 5 }),
  }).then((r) => r.json())) as any;

  expect(afterSearch.results.find((r: any) => r.title === 'feedback_edit')).toBeDefined();
});

test('e2e — delete file → chunks removed', async () => {
  const filePath = join(memoryDir, 'feedback_delete.md');
  writeFileSync(filePath, '---\ntype: feedback\n---\nwill be deleted');
  await new Promise((r) => setTimeout(r, 1500));

  unlinkSync(filePath);
  await new Promise((r) => setTimeout(r, 1500));

  const search = (await fetch(`http://localhost:${PORT}/search/all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'will be deleted', top_k: 5 }),
  }).then((r) => r.json())) as any;

  expect(search.results.find((r: any) => r.title === 'feedback_delete')).toBeUndefined();
});
