import { test, expect, beforeAll, afterAll } from 'bun:test';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';

let worker: WorkerHandle;
const PORT = 39891;

beforeAll(async () => {
  worker = await startWorker({
    port: PORT,
    projectId: 'test-project',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: ':memory:',
    embeddingDimension: 1024,
    skipEmbed: true,
  });
});

afterAll(async () => {
  await worker.stop();
});

test('worker — responds to /health with 200', async () => {
  const res = await fetch(`http://localhost:${PORT}/health`);
  expect(res.status).toBe(200);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await res.json()) as any;
  expect(body.healthy).toBe(true);
});

test('worker — responds to /stats with corpus info', async () => {
  const res = await fetch(`http://localhost:${PORT}/stats`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('total_chunks');
  expect(body).toHaveProperty('by_channel');
});

test('worker — /search/all returns hybrid results structure', async () => {
  const res = await fetch(`http://localhost:${PORT}/search/all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'test', top_k: 5 }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body).toHaveProperty('results');
  expect(body).toHaveProperty('by_channel');
  expect(Array.isArray(body.results)).toBe(true);
});

test('worker — /search/memory accepts type filter', async () => {
  const res = await fetch(`http://localhost:${PORT}/search/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'test', type: 'feedback', top_k: 5 }),
  });
  expect(res.status).toBe(200);
});

test('worker — /search/skill accepts skill_id filter', async () => {
  const res = await fetch(`http://localhost:${PORT}/search/skill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'test', skill_id: 'erp-coding-standards', top_k: 3 }),
  });
  expect(res.status).toBe(200);
});

test('worker — /search/observations accepts type and files filters', async () => {
  const res = await fetch(`http://localhost:${PORT}/search/observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'bug',
      type: 'bugfix',
      files: ['core/inc/forms.php'],
      top_k: 5,
    }),
  });
  expect(res.status).toBe(200);
});
