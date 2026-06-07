// tests/integration/qm-dedup.test.ts
//
// End-to-end proof of the Quartermaster auto-dedup timer wired into the worker
// (HTTP boot, FTS-only / skipEmbed). Under skipEmbed the worker writes ZERO
// vectors, and cosine(zero, zero) === 0 — so nothing would ever fold on its own.
// To exercise the cosine-gated fold deterministically we inject NON-ZERO chunk
// vectors directly into the worker's on-disk vec db after indexing: a near-
// identical pair for the two dup observations, and a clearly-different vector for
// the control. The slice then folds exactly the pair whose cosine clears the
// threshold, leaving the control (same title family, dissimilar vector) live —
// proving cosine, not title, decides the fold.
import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { VectorStore } from '../../src/worker/vector-store.ts';

let worker: WorkerHandle | null = null;
let workDir = '';

const DIM = 8;
const PROJECT = 'p';

const QM_ENV = [
  'CAPTAIN_MEMO_QM_ENABLED', 'CAPTAIN_MEMO_QM_DEDUP',
  'CAPTAIN_MEMO_QM_DEDUP_INTERVAL_MS', 'CAPTAIN_MEMO_QM_DEDUP_WINDOW',
  'CAPTAIN_MEMO_QM_DEDUP_COSINE', 'CAPTAIN_MEMO_QM_DEDUP_TITLE',
];

afterEach(async () => {
  if (worker) { await worker.stop(); worker = null; }
  // Clear env BEFORE touching the filesystem so a teardown fs error can never skip the reset
  // (a leaked CAPTAIN_MEMO_QM_DEDUP=1 would make the next "off by default" test really fold).
  for (const k of QM_ENV) delete process.env[k];
  // Best-effort temp cleanup — on Windows the worker's SQLite file can stay locked past stop(),
  // so a locked delete must not fail the test (assertions already ran; OS tmpdir reclaims the dir).
  if (workDir) {
    try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }); }
    catch (e) { console.warn(`[test] temp cleanup skipped: ${(e as Error).message}`); }
    workDir = '';
  }
});

async function build(env: Record<string, string>): Promise<number> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-qm-'));
  worker = await startWorker({
    port: 0,
    projectId: PROJECT,
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: DIM,
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

// Enqueue + flush one observation; return its id once indexed.
async function seed(port: number, title: string): Promise<number> {
  const ts = Math.floor(Date.now() / 1000);
  await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 'seed', project_id: PROJECT, prompt_number: 1,
      tool_name: 'Edit', tool_input_summary: title, tool_result_summary: 'ok',
      files_read: [], files_modified: [], ts_epoch: ts,
    }),
  });
  await (await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'seed' }),
  })).json();
  const list = await (await fetch(`http://localhost:${port}/observations/recent?limit=50`)).json() as
    { items: Array<{ id: number; title: string }> };
  const match = list.items.find(i => i.title === title);
  expect(match).toBeDefined();
  return match!.id;
}

// All chunk ids for an observation, read from the on-disk vec db. The chunk id
// format is `observation:<obsId>:<shortId>`, so the middle segment is the obs id.
function chunkIdsFor(obsId: number): string[] {
  const db = new Database(join(workDir, 'vec.db'), { readonly: true });
  const rows = db.query('SELECT chunk_id FROM vec_chunk_meta').all() as Array<{ chunk_id: string }>;
  db.close();
  return rows
    .filter(r => r.chunk_id.split(':')[1] === String(obsId))
    .map(r => r.chunk_id);
}

// Give every count-bearing row a surfaced count so it enters the dedup window
// (dedupCandidateWindow requires from_auto+from_search+from_drill > 0). `survivor`
// gets the higher count so it leads its group.
function setSurfacedCount(obsId: number, count: number): void {
  const db = new Database(join(workDir, 'obs.db'));
  db.run('UPDATE observations SET from_search = ? WHERE id = ?', [count, obsId]);
  db.close();
}

function archivedFlagOf(obsId: number): { archived: number; into: number | null } {
  const db = new Database(join(workDir, 'obs.db'), { readonly: true });
  const row = db.query('SELECT archived, archived_into_theme_id FROM observations WHERE id = ?')
    .get(obsId) as { archived: number; archived_into_theme_id: number | null } | null;
  db.close();
  return { archived: row?.archived ?? 0, into: row?.archived_into_theme_id ?? null };
}

// Inject deterministic non-zero vectors via a second VectorStore on the worker's
// vec db path. `add` deletes+reinserts by chunk_id, overwriting the skipEmbed
// zero-vectors while keeping the collection mapping intact. Retries on transient
// WAL busy (the worker holds a writer connection on the same file).
const collectionName = `am_${PROJECT}`;
async function injectVectorAsync(chunkIds: string[], vec: number[]): Promise<void> {
  const vs = new VectorStore({ dbPath: join(workDir, 'vec.db'), dimension: DIM });
  const items = chunkIds.map(id => ({ id, embedding: vec }));
  let lastErr: unknown;
  for (let i = 0; i < 30; i++) {
    try { await vs.add(collectionName, items); lastErr = undefined; break; }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 25)); }
  }
  vs.close();
  if (lastErr) throw lastErr;
}

function latestQmRunsRows(n: number): Array<{ job: string; merges: number; aborted_for_ingest: number }> {
  const db = new Database(join(workDir, 'obs.db'), { readonly: true });
  const rows = db.query(
    'SELECT job, merges, aborted_for_ingest FROM qm_runs ORDER BY id DESC LIMIT ?'
  ).all(n) as Array<{ job: string; merges: number; aborted_for_ingest: number }>;
  db.close();
  return rows;
}

// Two near-identical 8-d vectors (cosine ≈ 1), and a control orthogonal-ish one.
const VEC_A = [1, 0.9, 0.1, 0, 0, 0, 0, 0];
const VEC_A2 = [0.98, 0.92, 0.08, 0.01, 0, 0, 0, 0]; // cosine to A well above 0.98
const VEC_FAR = [0, 0, 0, 0, 1, 0.9, 0.1, 0];        // cosine to A ≈ 0

test('auto-dedup fold — cosine-gated, survivor keeps higher count, control stays live', async () => {
  const port = await build({
    CAPTAIN_MEMO_QM_ENABLED: '1',
    CAPTAIN_MEMO_QM_DEDUP: '1',
    CAPTAIN_MEMO_QM_DEDUP_INTERVAL_MS: '50',
    CAPTAIN_MEMO_QM_DEDUP_WINDOW: '50',
    CAPTAIN_MEMO_QM_DEDUP_COSINE: '0.95',
  });

  // Two near-identical titles (high Jaccard → same group) + one same-family title
  // that we'll keep apart by vector. Survivor = the higher surfaced-count row.
  const survivor = await seed(port, 'wire quartermaster auto dedup timer into worker');
  const dup = await seed(port, 'wire quartermaster auto dedup timer into the worker now');
  const control = await seed(port, 'wire quartermaster auto dedup timer into worker control variant');

  // Counts: survivor leads the group; both others below it.
  setSurfacedCount(survivor, 5);
  setSurfacedCount(dup, 2);
  setSurfacedCount(control, 1);

  // Inject deterministic vectors: survivor ≈ dup (will fold), control far (won't).
  await injectVectorAsync(chunkIdsFor(survivor), VEC_A);
  await injectVectorAsync(chunkIdsFor(dup), VEC_A2);
  await injectVectorAsync(chunkIdsFor(control), VEC_FAR);

  // Poll up to ~3s for a dedup slice to fold the pair.
  let folded = false;
  for (let i = 0; i < 60 && !folded; i++) {
    await new Promise(r => setTimeout(r, 50));
    folded = archivedFlagOf(dup).archived === 1;
  }

  expect(folded).toBe(true);                                   // dup folded
  expect(archivedFlagOf(dup).into).toBe(survivor);             // folded INTO the survivor
  expect(archivedFlagOf(survivor).archived).toBe(0);           // survivor stays live
  expect(archivedFlagOf(control).archived).toBe(0);            // control NOT folded (cosine gate)

  const runs = latestQmRunsRows(5);
  const dedupRun = runs.find(r => r.job === 'dedup' && r.merges >= 1);
  expect(dedupRun).toBeDefined();                              // a dedup run recorded ≥1 merge

  // QM block surfaces on /stats.
  const stats = await (await fetch(`http://localhost:${port}/stats`)).json() as
    { qm?: { enabled: boolean; dedup_enabled: boolean; cosine_threshold: number; last_run: unknown } };
  expect(stats.qm).toBeDefined();
  expect(stats.qm!.enabled).toBe(true);
  expect(stats.qm!.dedup_enabled).toBe(true);
  expect(stats.qm!.cosine_threshold).toBe(0.95);
  expect(stats.qm!.last_run).not.toBeNull();
});

test('off by default — no CAPTAIN_MEMO_QM_DEDUP ⇒ no folds, no qm_runs rows', async () => {
  const port = await build({
    CAPTAIN_MEMO_QM_DEDUP_INTERVAL_MS: '50',
    CAPTAIN_MEMO_QM_DEDUP_WINDOW: '50',
    CAPTAIN_MEMO_QM_DEDUP_COSINE: '0.95',
    // deliberately NOT setting CAPTAIN_MEMO_QM_DEDUP
  });

  const survivor = await seed(port, 'off by default dedup probe alpha');
  const dup = await seed(port, 'off by default dedup probe alpha beta');
  setSurfacedCount(survivor, 5);
  setSurfacedCount(dup, 2);
  await injectVectorAsync(chunkIdsFor(survivor), VEC_A);
  await injectVectorAsync(chunkIdsFor(dup), VEC_A2);

  // Give a generous window — the timer must simply never run.
  await new Promise(r => setTimeout(r, 500));

  expect(archivedFlagOf(dup).archived).toBe(0);   // nothing folded
  expect(latestQmRunsRows(5).length).toBe(0);     // timer never created ⇒ no runs

  const stats = await (await fetch(`http://localhost:${port}/stats`)).json() as
    { qm?: { enabled: boolean; dedup_enabled: boolean; last_run: unknown } };
  expect(stats.qm!.enabled).toBe(true);            // master switch defaults ON
  expect(stats.qm!.dedup_enabled).toBe(false);     // dedup defaults OFF
  expect(stats.qm!.last_run).toBeNull();           // no run ever recorded
});
