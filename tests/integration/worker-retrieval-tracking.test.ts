// tests/integration/worker-retrieval-tracking.test.ts
//
// End-to-end proof that every retrieval path actually bumps the right
// provenance counter at the HTTP layer. The pre-v5 bug was a wiring gap
// — handler existed, no one called the bump — and was invisible to unit
// tests because they exercised the store directly, not the HTTP layer.
// These tests close that gap: each endpoint goes through the real worker.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';

let port = 0;
let worker: WorkerHandle;
let workDir: string;

interface RecallBlock {
  surfaced_count: number;
  recalled_count: number;
  totals: { auto: number; search: number; drill: number };
  top_surfaced: Array<{ id: number; from_auto: number; from_search: number; from_drill: number }>;
  top_recalled: Array<{ id: number; from_auto: number; from_search: number; from_drill: number }>;
}

async function getRecall(): Promise<RecallBlock> {
  const r = await fetch(`http://localhost:${port}/stats`);
  const body = await r.json() as { recall: RecallBlock };
  return body.recall;
}

async function seedObservation(title: string): Promise<number> {
  await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 'seed', project_id: 'p', prompt_number: 1,
      tool_name: 'Edit', tool_input_summary: title, tool_result_summary: 'ok',
      files_read: [], files_modified: [], ts_epoch: 1_700_000_000,
    }),
  });
  const flush = await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'seed' }),
  });
  const body = await flush.json() as { observations_created: number };
  expect(body.observations_created).toBeGreaterThanOrEqual(1);

  // Find the freshly-created observation id via the recent listing.
  const recent = await fetch(`http://localhost:${port}/observations/recent?limit=10`);
  const list = await recent.json() as { items: Array<{ id: number; title: string }> };
  const match = list.items.find(i => i.title.includes(title));
  expect(match).toBeDefined();
  return match!.id;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-track-'));
  worker = await startWorker({
    port: 0,
    projectId: 'track-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    // Deterministic stub summarizer: title is a literal echo so the search
    // queries below can lexically match it via FTS.
    summarize: async (events) => ({
      type: 'discovery',
      title: events[0]!.tool_input_summary,
      narrative: events[0]!.tool_input_summary,
      facts: [events[0]!.tool_input_summary],
      concepts: [],
    }),
    observationTickMs: 0,
  });
  port = worker.port;
});

afterEach(async () => {
  await worker.stop();
  // Windows releases SQLite/WAL file handles a beat after close(); retry so the recursive
  // delete doesn't race that release and throw EBUSY/EPERM in teardown (Linux unlinks open
  // files freely, which is why this only ever bit windows-latest). No-op cost on Linux.
  rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('/search/all bumps from_search on observation hits', async () => {
  const id = await seedObservation('apricot-marker-xyz');

  const before = await getRecall();
  expect(before.totals.search).toBe(0);

  const r = await fetch(`http://localhost:${port}/search/all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'apricot-marker-xyz', top_k: 5 }),
  });
  const body = await r.json() as { results: Array<{ metadata: { observation_id: number } }> };
  expect(body.results.length).toBeGreaterThan(0);

  const after = await getRecall();
  expect(after.totals.search).toBeGreaterThan(0);
  const entry = after.top_surfaced.find(e => e.id === id);
  expect(entry).toBeDefined();
  expect(entry!.from_search).toBeGreaterThan(0);
  expect(entry!.from_auto).toBe(0);
  expect(entry!.from_drill).toBe(0);
});

test('/search/observations bumps from_search', async () => {
  const id = await seedObservation('banana-marker-xyz');
  await fetch(`http://localhost:${port}/search/observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'banana-marker-xyz', top_k: 5 }),
  });
  const after = await getRecall();
  const entry = after.top_surfaced.find(e => e.id === id);
  expect(entry).toBeDefined();
  expect(entry!.from_search).toBeGreaterThan(0);
  expect(entry!.from_drill).toBe(0);
});

test('/get_full bumps from_drill (NOT from_search)', async () => {
  await seedObservation('cherry-marker-xyz');
  // First do a search to discover the doc_id (mirrors how the slash skill
  // calls /search/all then /get_full).
  const search = await fetch(`http://localhost:${port}/search/all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'cherry-marker-xyz', top_k: 1 }),
  });
  const sbody = await search.json() as {
    results: Array<{ doc_id: string; metadata: { observation_id: number } }>;
  };
  expect(sbody.results.length).toBeGreaterThan(0);
  const obsId = sbody.results[0]!.metadata.observation_id;

  const beforeDrill = await getRecall();
  const baselineSearch = beforeDrill.totals.search;
  const baselineDrill = beforeDrill.totals.drill;

  await fetch(`http://localhost:${port}/get_full`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc_id: sbody.results[0]!.doc_id }),
  });

  const after = await getRecall();
  expect(after.totals.drill).toBe(baselineDrill + 1);
  expect(after.totals.search).toBe(baselineSearch);       // unchanged
  const entry = after.top_recalled.find(e => e.id === obsId);
  expect(entry).toBeDefined();
  expect(entry!.from_drill).toBeGreaterThan(0);
});

test('/inject/context bumps from_auto — the high-volume path that was missing pre-v5', async () => {
  const id = await seedObservation('durian-marker-xyz');

  const before = await getRecall();
  expect(before.totals.auto).toBe(0);

  await fetch(`http://localhost:${port}/inject/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'tell me about durian-marker-xyz',
      top_k: 5,
      session_id: 'test',
      project_id: 'track-test',
    }),
  });

  const after = await getRecall();
  expect(after.totals.auto).toBeGreaterThan(0);
  const entry = after.top_surfaced.find(e => e.id === id);
  expect(entry).toBeDefined();
  expect(entry!.from_auto).toBeGreaterThan(0);
  expect(entry!.from_search).toBe(0);
  expect(entry!.from_drill).toBe(0);
});

test('/search/all drops archived observation hits (and the survivor still surfaces)', async () => {
  const keep = await seedObservation('kiwimark alpha');
  const drop = await seedObservation('kiwimark beta');
  // Fold `drop` into `keep`: drop is now archived and must not surface.
  worker.store!.mergeDuplicateGroup(keep, [drop], 1000);

  const r = await fetch(`http://localhost:${port}/search/all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'kiwimark', top_k: 10 }),
  });
  const body = await r.json() as { results: Array<{ metadata: { observation_id?: number } }> };
  const ids = body.results.map(x => x.metadata?.observation_id);
  expect(ids).toContain(keep);        // survivor still surfaces
  expect(ids).not.toContain(drop);    // archived dup suppressed
});

test('/inject/context never injects an archived observation', async () => {
  const keep = await seedObservation('plummark alpha');
  const drop = await seedObservation('plummark beta');
  worker.store!.mergeDuplicateGroup(keep, [drop], 1000);

  const r = await fetch(`http://localhost:${port}/inject/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'tell me about plummark', top_k: 10,
      session_id: 's', project_id: 'track-test',
    }),
  });
  const body = await r.json() as { envelope: string };
  expect(body.envelope).toContain('plummark alpha');     // survivor injected
  expect(body.envelope).not.toContain('plummark beta');  // archived not injected
});

test('/recall/list returns sorted, filtered rows with a total', async () => {
  const a = await seedObservation('mango alpha');
  const b = await seedObservation('mango beta');
  worker.store!.bumpRetrieval([a], 'search');
  worker.store!.bumpRetrieval([a], 'search');
  worker.store!.bumpRetrieval([b], 'search');

  const r = await fetch(`http://localhost:${port}/recall/list?view=surfaced&sort=total&q=mango`);
  const body = await r.json() as { rows: Array<{ id: number; total: number }>; total: number };
  expect(body.total).toBe(2);
  expect(body.rows[0]!.id).toBe(a);     // a (2) outranks b (1)
  expect(body.rows[0]!.total).toBe(2);
});

test('/observation/full returns the observation and bumps from_drill', async () => {
  const id = await seedObservation('nectarine solo');
  const before = await getRecall();

  const r = await fetch(`http://localhost:${port}/observation/full?id=${id}`);
  const body = await r.json() as { observation: { id: number; title: string; narrative: string } };
  expect(body.observation.id).toBe(id);
  expect(body.observation.title).toContain('nectarine solo');

  const after = await getRecall();
  expect(after.totals.drill).toBe(before.totals.drill + 1);
});

test('/observation/full 404s on a missing id', async () => {
  const r = await fetch(`http://localhost:${port}/observation/full?id=999999`);
  expect(r.status).toBe(404);
});

test('surfaced_count and recalled_count reflect distinct observations not total bumps', async () => {
  const id = await seedObservation('elderberry-marker-xyz');

  // Bump the same observation many times across all three sources.
  for (let i = 0; i < 5; i++) {
    await fetch(`http://localhost:${port}/inject/context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'elderberry-marker-xyz query', top_k: 3,
        session_id: 's', project_id: 'p',
      }),
    });
  }
  await fetch(`http://localhost:${port}/search/observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'elderberry-marker-xyz', top_k: 3 }),
  });

  const after = await getRecall();
  expect(after.surfaced_count).toBe(1);                  // one distinct obs
  expect(after.recalled_count).toBe(0);                  // never drilled
  expect(after.totals.auto).toBeGreaterThanOrEqual(5);
  expect(after.totals.search).toBeGreaterThanOrEqual(1);
  expect(after.top_surfaced[0]!.id).toBe(id);
});
