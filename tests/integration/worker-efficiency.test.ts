import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { ObservationsStore } from '../../src/worker/observations-store.ts';

const PORT = 39912;
let worker: WorkerHandle;
let workDir: string;
let obsDbPath: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-eff-'));
  obsDbPath = join(workDir, 'obs.db');
  worker = await startWorker({
    port: PORT,
    projectId: 'eff-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: obsDbPath,
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    summarize: async (events) => ({
      type: 'change',
      title: `summary of ${events.length} events`,
      narrative: 'stub narrative for efficiency test',
      facts: events.map(e => `${e.tool_name}: ${e.tool_input_summary}`),
      concepts: ['stub'],
    }),
    observationTickMs: 0,
  });
});

afterEach(async () => {
  await worker.stop();
  rmSync(workDir, { recursive: true, force: true });
});

test('GET /stats — efficiency object has the expected shape', async () => {
  const stats = await (await fetch(`http://localhost:${PORT}/stats`)).json() as any;
  expect(stats.efficiency).toBeDefined();
  expect(stats.efficiency.corpus).toMatchObject({
    work_tokens: expect.any(Number),
    stored_tokens: expect.any(Number),
    coverage: { with_data: expect.any(Number), total: expect.any(Number) },
  });
  expect(stats.efficiency.embedder).toMatchObject({
    calls: expect.any(Number),
    avg_latency_ms: expect.any(Number),
    tokens_per_s: expect.any(Number),
  });
  expect(stats.efficiency.dedup).toMatchObject({
    docs_seen: expect.any(Number),
    skipped_unchanged: expect.any(Number),
    skip_pct: expect.any(Number),
  });
});

test('worker startup backfills stored_tokens for pre-existing observations', async () => {
  // Pre-seed an observations DB with rows that have work_tokens but NO
  // stored_tokens — the pre-v0.1.9 state.
  const seedDir = mkdtempSync(join(tmpdir(), 'captain-memo-eff-seed-'));
  const seedDbPath = join(seedDir, 'obs.db');
  const seed = new ObservationsStore(seedDbPath);
  for (let i = 0; i < 3; i++) {
    seed.insert({
      session_id: 's-seed', project_id: 'eff-test', prompt_number: i,
      type: 'feature', title: `seeded observation ${i}`,
      narrative: 'a narrative long enough to chunk into real tokens',
      facts: ['fact one', 'fact two'], concepts: ['c'],
      files_read: [], files_modified: [], created_at_epoch: 1_700_000_000 + i,
      branch: null, work_tokens: 5000,
    });
  }
  seed.close();

  const seedWorker = await startWorker({
    port: 39913,
    projectId: 'eff-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(seedDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    observationQueueDbPath: join(seedDir, 'queue.db'),
    observationsDbPath: seedDbPath,
    pendingEmbedDbPath: join(seedDir, 'pending.db'),
    summarize: async () => ({ type: 'change', title: 't', narrative: '', facts: [], concepts: [] }),
    observationTickMs: 0,
  });

  // Poll /stats until the background backfill has populated all 3 rows.
  let corpus: any = null;
  for (let i = 0; i < 50; i++) {
    const s = await (await fetch('http://localhost:39913/stats')).json() as any;
    corpus = s.efficiency.corpus;
    if (corpus.coverage.with_data === 3) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await seedWorker.stop();

  const reader = new ObservationsStore(seedDbPath);
  const all = reader.listRecent(10);
  reader.close();
  rmSync(seedDir, { recursive: true, force: true });

  expect(all.every(o => typeof o.stored_tokens === 'number' && o.stored_tokens! > 0)).toBe(true);
  expect(corpus.coverage.with_data).toBe(3);
  expect(corpus.ratio).toBeGreaterThan(0);
});

test('ingesting an observation populates stored_tokens', async () => {
  await fetch(`http://localhost:${PORT}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 's-eff', project_id: 'eff-test', prompt_number: 1,
      tool_name: 'Edit', tool_input_summary: 'edit foo.ts',
      tool_result_summary: 'ok', files_read: [], files_modified: ['foo.ts'],
      ts_epoch: 1_700_000_000,
    }),
  });
  await fetch(`http://localhost:${PORT}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's-eff' }),
  });

  const reader = new ObservationsStore(obsDbPath);
  const recent = reader.listRecent(1);
  reader.close();
  expect(recent).toHaveLength(1);
  expect(recent[0]!.stored_tokens).toBeGreaterThan(0);
});
