import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

let worker: WorkerHandle | null;
let workDir: string;
let port = 0;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-pe-int-'));
  worker = null;
});

afterEach(async () => {
  if (worker) await worker.stop();
  rmWorkDir(workDir);
});

test('POST /pending_embed/retry returns due_count + total_pending', async () => {
  worker = await startWorker({
    port: 0,
    projectId: 'pe-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    pendingEmbedDbPath: join(workDir, 'pending.db'),
  });
  port = worker.port;

  const res = await fetch(`http://localhost:${port}/pending_embed/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ max: 50 }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body).toHaveProperty('due_count');
  expect(body).toHaveProperty('total_pending');
  expect(body.total_pending).toBe(0);
});

test('observation ingest with embed-failure pushes rows to pending_embed', async () => {
  worker = await startWorker({
    port: 0,
    projectId: 'pe-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:1/will-fail',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    // skipEmbed: false here so we exercise the embed call (and watch it fail).
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    summarize: async () => ({
      type: 'change', title: 't', narrative: 'n',
      facts: ['a fact'], concepts: [],
    }),
    observationTickMs: 0,
  });
  port = worker.port;

  await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 's', project_id: 'pe-test', prompt_number: 1,
      tool_name: 'Edit', tool_input_summary: 'x', tool_result_summary: 'y',
      files_read: [], files_modified: [], ts_epoch: 1_700_000_000,
    }),
  });
  await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's' }),
  });

  const res = await fetch(`http://localhost:${port}/pending_embed/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ max: 50 }),
  });
  const body = await res.json() as any;
  expect(body.total_pending).toBeGreaterThan(0);
});
