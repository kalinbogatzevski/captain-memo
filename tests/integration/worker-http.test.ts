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
