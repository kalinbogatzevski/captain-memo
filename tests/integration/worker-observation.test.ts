import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

let port = 0;
let worker: WorkerHandle;
let workDir: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-obs-int-'));
  worker = await startWorker({
    port: 0,
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
  port = worker.port;
});

afterEach(async () => {
  await worker.stop();
  rmWorkDir(workDir);
});

test('POST /observation/enqueue accepts a raw event and returns id', async () => {
  const res = await fetch(`http://localhost:${port}/observation/enqueue`, {
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
    await fetch(`http://localhost:${port}/observation/enqueue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 's-flush', project_id: 'p1', prompt_number: i,
        tool_name: 'Read', tool_input_summary: `i=${i}`, tool_result_summary: 'ok',
        files_read: [], files_modified: [], ts_epoch: 1_700_000_000 + i,
      }),
    });
  }
  const res = await fetch(`http://localhost:${port}/observation/flush`, {
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
  const res = await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'nope' }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.processed).toBe(0);
});

test('POST /observation/enqueue — invalid body → 400', async () => {
  const res = await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's1' }), // missing fields
  });
  expect(res.status).toBe(400);
});

test('capture writes origin_agent end-to-end (enqueue → flush → store)', async () => {
  await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 's-agent', project_id: 'p1', prompt_number: 1,
      tool_name: 'Edit', tool_input_summary: 'edit foo.ts', tool_result_summary: 'ok',
      files_read: [], files_modified: ['foo.ts'], ts_epoch: 1_700_000_000,
      origin_agent: 'codex',
    }),
  });
  await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's-agent' }),
  });

  const stored = worker.store!.listForSession('s-agent');
  expect(stored).toHaveLength(1);
  expect(stored[0]!.origin_agent).toBe('codex');
});

// Note: this is a smoke test for the omitted-field path, not a regression guard
// for the `head.origin_agent ?? null` fallback — `head.origin_agent` is
// `undefined` here regardless of whether that fallback logic is correct, so a
// broken fallback wouldn't fail this test. See the "unrecognized origin_agent"
// test below for real coverage of the never-400s/degrades-gracefully behavior.
test('capture defaults origin_agent to null when the event omits it (back-compat)', async () => {
  await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 's-noagent', project_id: 'p1', prompt_number: 1,
      tool_name: 'Read', tool_input_summary: 'read foo.ts', tool_result_summary: 'ok',
      files_read: ['foo.ts'], files_modified: [], ts_epoch: 1_700_000_001,
    }),
  });
  await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's-noagent' }),
  });

  const stored = worker.store!.listForSession('s-noagent');
  expect(stored).toHaveLength(1);
  expect(stored[0]!.origin_agent).toBeNull();
});

test('capture tolerates an unrecognized origin_agent value (never 400s, degrades gracefully)', async () => {
  const res = await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 's-garbage', project_id: 'p1', prompt_number: 1,
      tool_name: 'Edit', tool_input_summary: 'edit foo.ts', tool_result_summary: 'ok',
      files_read: [], files_modified: ['foo.ts'], ts_epoch: 1_700_000_003,
      origin_agent: 'not-a-real-vendor',
    }),
  });
  expect(res.status).toBe(200);
  await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's-garbage' }),
  });

  const stored = worker.store!.listForSession('s-garbage');
  expect(stored).toHaveLength(1);
  expect(stored[0]!.origin_agent).toBeNull();
});

test('search surfaces origin_agent in observation hit metadata', async () => {
  await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 's-search', project_id: 'p1', prompt_number: 1,
      tool_name: 'Edit', tool_input_summary: 'zorblax widget refactor', tool_result_summary: 'ok',
      files_read: [], files_modified: ['zorblax.ts'], ts_epoch: 1_700_000_002,
      origin_agent: 'gemini',
    }),
  });
  await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's-search' }),
  });

  const res = await fetch(`http://localhost:${port}/search/observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'zorblax widget', top_k: 5 }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { results: Array<{ metadata: Record<string, unknown> }> };
  expect(body.results.length).toBeGreaterThan(0);
  expect(body.results[0]!.metadata.origin_agent).toBe('gemini');
});
