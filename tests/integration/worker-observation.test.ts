import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';

const PORT = 39901;
let worker: WorkerHandle;
let workDir: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'aelita-obs-int-'));
  worker = await startWorker({
    port: PORT,
    projectId: 'obs-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    summarize: async (events) => ({
      type: 'change',
      title: `summary of ${events.length} events`,
      narrative: 'stub narrative',
      facts: events.map(e => `${e.tool_name}: ${e.tool_input_summary}`),
      concepts: ['stub'],
    }),
    observationTickMs: 0, // Disable auto-tick; test calls flush manually.
  });
});

afterEach(async () => {
  await worker.stop();
  rmSync(workDir, { recursive: true, force: true });
});

test('POST /observation/enqueue accepts a raw event and returns id', async () => {
  const res = await fetch(`http://localhost:${PORT}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 's1',
      project_id: 'p1',
      prompt_number: 1,
      tool_name: 'Edit',
      tool_input_summary: 'edit foo.ts',
      tool_result_summary: 'ok',
      files_read: [],
      files_modified: ['foo.ts'],
      ts_epoch: 1_700_000_000,
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.id).toBeGreaterThan(0);
  expect(body.queued).toBe(true);
});

test('POST /observation/flush drains queued events into observations', async () => {
  for (let i = 0; i < 3; i++) {
    await fetch(`http://localhost:${PORT}/observation/enqueue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 's-flush', project_id: 'p1', prompt_number: i,
        tool_name: 'Read', tool_input_summary: `i=${i}`, tool_result_summary: 'ok',
        files_read: [], files_modified: [], ts_epoch: 1_700_000_000 + i,
      }),
    });
  }
  const res = await fetch(`http://localhost:${PORT}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's-flush' }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.processed).toBeGreaterThanOrEqual(1);
  expect(body.observations_created).toBeGreaterThanOrEqual(1);
});

test('POST /observation/flush — empty queue returns processed=0', async () => {
  const res = await fetch(`http://localhost:${PORT}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'nope' }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.processed).toBe(0);
});

test('POST /observation/enqueue — invalid body → 400', async () => {
  const res = await fetch(`http://localhost:${PORT}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's1' }), // missing fields
  });
  expect(res.status).toBe(400);
});
