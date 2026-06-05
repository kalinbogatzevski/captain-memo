// tests/integration/tide-tiering.test.ts
//
// End-to-end proof of Tide tiering (Phase 2) through the real worker (HTTP, FTS-only):
// the restore + by-tide-state endpoints, the live ebb sweep flipping an idle old row to
// dormant, and the critical contract — a dormant row stays reachable via /search but is
// excluded from the /inject/context default set, and one recall re-surfaces it.
import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';

let worker: WorkerHandle | null = null;
let workDir = '';

const TIDE_ENV = [
  'CAPTAIN_MEMO_TIDE_ENABLED', 'CAPTAIN_MEMO_TIDE_TIERING',
  'CAPTAIN_MEMO_TIDE_AGE_FLOOR_DAYS', 'CAPTAIN_MEMO_TIDE_ARCHIVE_AGE_DAYS',
  'CAPTAIN_MEMO_TIDE_SWEEP_MS',
];

afterEach(async () => {
  if (worker) { await worker.stop(); worker = null; }
  if (workDir) { rmSync(workDir, { recursive: true, force: true }); workDir = ''; }
  for (const k of TIDE_ENV) delete process.env[k];
});

async function build(env: Record<string, string>): Promise<number> {
  process.env.CAPTAIN_MEMO_TIDE_ENABLED = '1';
  process.env.CAPTAIN_MEMO_TIDE_TIERING = '1';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-tier-'));
  worker = await startWorker({
    port: 0,
    projectId: 'tier-test',
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
  const list = await (await fetch(`http://localhost:${port}/observations/recent?limit=20`)).json() as
    { items: Array<{ id: number; title: string }> };
  const match = list.items.find(i => i.title.includes(title));
  expect(match).toBeDefined();
  return match!.id;
}

function tideStateOf(id: number): string | null {
  const db = new Database(join(workDir, 'obs.db'), { readonly: true });
  const row = db.query('SELECT tide_state FROM observations WHERE id = ?').get(id) as { tide_state: string } | null;
  db.close();
  return row?.tide_state ?? null;
}

function setDormant(id: number): void {
  const db = new Database(join(workDir, 'obs.db'));
  db.run("UPDATE observations SET tide_state = 'dormant', tide_state_changed_at = 1 WHERE id = ?", [id]);
  db.close();
}

const NOW = Math.floor(Date.now() / 1000);
const OLD = NOW - 400 * 86_400;

test('restore endpoint — re-surfaces a dormant row to active (idempotent on active)', async () => {
  const port = await build({ CAPTAIN_MEMO_TIDE_SWEEP_MS: '3600000' }); // sweep idle, control state by hand
  const id = await seed(port, 'restoreprobe marker', NOW);
  setDormant(id);
  expect(tideStateOf(id)).toBe('dormant');

  const r1 = await (await fetch(`http://localhost:${port}/observation/restore`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
  })).json() as { id: number; result: string; restored: boolean };
  expect(r1.result).toBe('restored');
  expect(r1.restored).toBe(true);
  expect(tideStateOf(id)).toBe('active');

  const r2 = await (await fetch(`http://localhost:${port}/observation/restore`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
  })).json() as { result: string };
  expect(r2.result).toBe('already_active'); // no-op

  const r3 = await (await fetch(`http://localhost:${port}/observation/restore`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 999_999 }),
  })).json() as { result: string };
  expect(r3.result).toBe('not_found');       // typo'd id is distinguishable, not "already fine"
});

test('by-tide-state endpoint — lists dormant rows; rejects a bad state', async () => {
  const port = await build({ CAPTAIN_MEMO_TIDE_SWEEP_MS: '3600000' });
  const id = await seed(port, 'liststate marker', NOW);
  setDormant(id);
  const listed = await (await fetch(`http://localhost:${port}/observations/by-tide-state?state=dormant`)).json() as
    { items: Array<{ id: number }> };
  expect(listed.items.map(i => i.id)).toContain(id);

  const bad = await fetch(`http://localhost:${port}/observations/by-tide-state?state=bogus`);
  expect(bad.status).toBe(400);
});

test('ebb sweep — an idle, old observation auto-flips to dormant, then restore re-floats it', async () => {
  // Age floor 0 + fast sweep so an old row qualifies immediately.
  const port = await build({ CAPTAIN_MEMO_TIDE_AGE_FLOOR_DAYS: '0', CAPTAIN_MEMO_TIDE_SWEEP_MS: '40' });
  const id = await seed(port, 'sweepprobe marker', OLD);
  expect(tideStateOf(id)).toBe('active');

  // Poll for the sweep to ebb it (generous budget; sweep ticks every 40ms).
  let ebbed = false;
  for (let i = 0; i < 120 && !ebbed; i++) {
    await new Promise(r => setTimeout(r, 50));
    ebbed = tideStateOf(id) === 'dormant';
  }
  expect(ebbed).toBe(true);

  // A recall re-floats it: a /search surfaces the row → bumpRetrieval surface rail.
  await fetch(`http://localhost:${port}/search/observations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'sweepprobe', top_k: 5 }),
  });
  expect(tideStateOf(id)).toBe('active');
});

test('dormant contract — stays in /search (down-ranked) but is excluded from /inject/context', async () => {
  const port = await build({ CAPTAIN_MEMO_TIDE_SWEEP_MS: '3600000' });
  const id = await seed(port, 'dormancycontract sentinel token', NOW);
  setDormant(id);

  // Still reachable via explicit search.
  const search = await (await fetch(`http://localhost:${port}/search/observations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'dormancycontract sentinel', top_k: 10 }),
  })).json() as { results: Array<{ metadata: { observation_id: number } }> };
  // NOTE: a search bump would re-surface it — assert presence BEFORE re-checking state.
  expect(search.results.some(r => r.metadata.observation_id === id)).toBe(true);

  // Re-sink it (the search above surfaced it), then assert /inject/context excludes it.
  setDormant(id);
  const inject = await (await fetch(`http://localhost:${port}/inject/context`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'dormancycontract sentinel token please inject this context now', top_k: 10 }),
  })).json() as { envelope?: string };
  const blob = JSON.stringify(inject);
  expect(blob).not.toContain('dormancycontract sentinel token');
});
