// tests/integration/tide-search.test.ts
//
// End-to-end proof of the Tide wiring through the real worker (HTTP, FTS-only).
// The reliable signal is that a real /search bump sets stability_days ONLY when
// Tide is wired into both the store (tideConfig) and is enabled — flat recency
// decay would never touch that column. Also checks the read-time re-rank demotes
// an equally-relevant stale observation below a fresh one.
import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

let worker: WorkerHandle | null = null;
let workDir = '';

afterEach(async () => {
  if (worker) { await worker.stop(); worker = null; }
  delete process.env.CAPTAIN_MEMO_TIDE_ENABLED;
  if (workDir) { rmWorkDir(workDir); workDir = ''; }
});

async function build(tideEnabled: boolean): Promise<number> {
  if (tideEnabled) process.env.CAPTAIN_MEMO_TIDE_ENABLED = '1';
  else process.env.CAPTAIN_MEMO_TIDE_ENABLED = '0'; // explicit OFF — default is now ON (v0.5.3+)
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-tide-'));
  worker = await startWorker({
    port: 0,
    projectId: 'tide-test',
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
      type: 'discovery',
      title: events[0]!.tool_input_summary,
      narrative: events[0]!.tool_input_summary,
      facts: [events[0]!.tool_input_summary],
      concepts: [],
    }),
    observationTickMs: 0,
  });
  return worker.port;
}

async function seed(port: number, title: string, tsEpoch: number): Promise<number> {
  await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 'seed', project_id: 'p', prompt_number: 1,
      tool_name: 'Edit', tool_input_summary: title, tool_result_summary: 'ok',
      files_read: [], files_modified: [], ts_epoch: tsEpoch,
    }),
  });
  await (await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'seed' }),
  })).json();
  const recent = await fetch(`http://localhost:${port}/observations/recent?limit=20`);
  const list = await recent.json() as { items: Array<{ id: number; title: string }> };
  const match = list.items.find(i => i.title.includes(title));
  expect(match).toBeDefined();
  return match!.id;
}

async function search(port: number, query: string): Promise<Map<number, number>> {
  const r = await fetch(`http://localhost:${port}/search/observations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, top_k: 10 }),
  });
  const body = await r.json() as { results: Array<{ score: number; metadata: { observation_id: number } }> };
  return new Map(body.results.map(x => [x.metadata.observation_id, x.score]));
}

function stabilityOf(id: number): number | null {
  const db = new Database(join(workDir, 'obs.db'), { readonly: true });
  const row = db.query('SELECT stability_days FROM observations WHERE id = ?').get(id) as
    { stability_days: number | null } | null;
  db.close();
  return row?.stability_days ?? null;
}

const NOW = Math.floor(Date.now() / 1000);
const OLD = NOW - 400 * 86_400;

test('Tide ON — a real /search bump strengthens stability_days (full store wiring)', async () => {
  const port = await build(true);
  const id = await seed(port, 'tidewire marker', NOW);
  expect(stabilityOf(id)).toBeNull();      // never surfaced yet
  await search(port, 'tidewire');          // surfaces it → bump → stability update
  const s = stabilityOf(id);
  expect(s).not.toBeNull();
  expect(s!).toBeGreaterThan(0);
});

test('Tide OFF — a /search bump leaves stability_days NULL (disabled path unchanged)', async () => {
  const port = await build(false);
  const id = await seed(port, 'tidewire marker', NOW);
  await search(port, 'tidewire');
  expect(stabilityOf(id)).toBeNull();
});

test('Tide ON — a fresh observation outranks an equally-relevant stale one', async () => {
  const port = await build(true);
  const freshId = await seed(port, 'tideprobe alpha', NOW);
  const oldId = await seed(port, 'tideprobe beta', OLD);
  const scores = await search(port, 'tideprobe');
  expect(scores.has(freshId)).toBe(true);
  expect(scores.has(oldId)).toBe(true);
  expect(scores.get(freshId)!).toBeGreaterThan(scores.get(oldId)!);
});
