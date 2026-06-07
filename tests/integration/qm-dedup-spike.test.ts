// tests/integration/qm-dedup-spike.test.ts
//
// Heartbeat-safety proof for the Quartermaster dedup timer: with dedup enabled and
// a populated near-dup corpus, we hammer /observation/enqueue while dedup slices
// fire on a tight interval, and assert (a) /health never stalls beyond a freshness
// budget — the slice yields to the event loop between groups — and (b) at least one
// qm_runs row carries aborted_for_ingest=1, proving a slice saw queued ingest mid-
// run and bailed (shouldAbort: pendingCount > 0 || a batch is processing).
import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { ObservationsStore } from '../../src/worker/observations-store.ts';
import { DEFAULT_SIMILARITY_THRESHOLD } from '../../src/shared/title-similarity.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

let worker: WorkerHandle | null = null;
let workDir = '';

const DIM = 8;
const PROJECT = 'p';
const FRESH_MS = 1500; // max tolerated /health round-trip gap while dedup + ingest race

const QM_ENV = [
  'CAPTAIN_MEMO_QM_ENABLED', 'CAPTAIN_MEMO_QM_DEDUP',
  'CAPTAIN_MEMO_QM_DEDUP_INTERVAL_MS', 'CAPTAIN_MEMO_QM_DEDUP_WINDOW',
];

afterEach(async () => {
  if (worker) { await worker.stop(); worker = null; }
  // reset env FIRST — a teardown fs error must never skip it
  for (const k of QM_ENV) delete process.env[k];
  if (workDir) { rmWorkDir(workDir); workDir = ''; }
});

async function build(): Promise<number> {
  process.env.CAPTAIN_MEMO_QM_ENABLED = '1';
  process.env.CAPTAIN_MEMO_QM_DEDUP = '1';
  process.env.CAPTAIN_MEMO_QM_DEDUP_INTERVAL_MS = '20';
  process.env.CAPTAIN_MEMO_QM_DEDUP_WINDOW = '500';
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-qm-spike-'));
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

async function enqueue(port: number, title: string, prompt: number): Promise<void> {
  await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 'spike', project_id: PROJECT, prompt_number: prompt,
      tool_name: 'Edit', tool_input_summary: title, tool_result_summary: 'ok',
      files_read: [], files_modified: [], ts_epoch: Math.floor(Date.now() / 1000),
    }),
  });
}

async function flush(port: number): Promise<void> {
  await (await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'spike' }),
  })).json();
}

// Bump every live row's surfaced count so the whole corpus enters the dedup window.
function bumpAllCounts(): void {
  const db = new Database(join(workDir, 'obs.db'));
  db.run('UPDATE observations SET from_search = id WHERE archived = 0');
  db.close();
}

function qmRuns(): Array<{ aborted_for_ingest: number }> {
  const db = new Database(join(workDir, 'obs.db'), { readonly: true });
  const rows = db.query('SELECT aborted_for_ingest FROM qm_runs').all() as Array<{ aborted_for_ingest: number }>;
  db.close();
  return rows;
}

// Largest near-dup candidate group the dedup window would yield — used to PROVE the
// big same-scope group lands as ONE group (the worst case the heartbeat must survive),
// not silently split into many small ones by a future title-similarity change.
function largestCandidateGroupSize(): number {
  const store = new ObservationsStore(join(workDir, 'obs.db'), { readonly: true });
  try {
    const groups = store.dedupCandidateWindow(DEFAULT_SIMILARITY_THRESHOLD, 500);
    return groups.reduce((max, g) => Math.max(max, g.members.length + 1), 0);
  } finally {
    store.close();
  }
}

test('dedup under ingest spike — heartbeat stays fresh, a slice aborts for ingest', async () => {
  const port = await build();

  // Populate a near-dup corpus of MANY small groups: 16 distinct token-cores, each
  // with two near-identical titles (high mutual Jaccard within a pair, low across
  // pairs). The candidate window thus yields many groups, so a dedup slice that
  // sees queued ingest mid-walk re-checks shouldAbort() between groups and bails.
  let p = 1;
  for (let g = 0; g < 16; g++) {
    await enqueue(port, `topic ${g} alpha bravo charlie delta echo foxtrot golf hotel`, p++);
    await enqueue(port, `topic ${g} alpha bravo charlie delta echo foxtrot golf india`, p++);
  }
  // PLUS one LARGE same-scope near-dup group (~100 members): a shared 9-token core
  // with a single varying ALPHABETIC tail token (no digits — a numeric suffix would
  // trip the identifier merge-guard and split the group), so all rows fall in one
  // title-similarity group inside one (project,branch) partition. This is the
  // previously-uncovered worst case — a single huge group does ~100 centroid reads,
  // which without the intra-group heartbeat yield (Fix E) would block the event loop
  // and starve /health. We assert the worst /health gap stays under the budget while
  // it processes.
  const CORE = 'bigdup shared core alpha bravo charlie delta echo foxtrot';
  const tail = (i: number): string => {
    // Pure-alphabetic distinct suffix per row (base-26, lowercase) — no identifiers.
    let s = '', n = i;
    do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  };
  for (let i = 0; i < 140; i++) {
    await enqueue(port, `${CORE} word${tail(i)}`, p++);
  }
  await flush(port);
  bumpAllCounts();

  // Sanity: the big group really is ONE large same-scope group (worst case present).
  // The ingest batcher folds some same-prompt events, so not all 100 enqueues become
  // distinct rows — but the surviving group is comfortably > 2·HEARTBEAT_EVERY (64),
  // so a slice walking it MUST cross the 32- and 64-member intra-group yield
  // checkpoints. That is exactly the previously-uncovered worst case Fix E guards.
  expect(largestCandidateGroupSize()).toBeGreaterThanOrEqual(64);

  // Heartbeat probe: poll /health continuously; record the worst gap between
  // successive successful responses while the spike runs.
  let worstGap = 0;
  let stopHealth = false;
  const healthLoop = (async () => {
    let last = Date.now();
    while (!stopHealth) {
      const r = await fetch(`http://localhost:${port}/health`);
      expect(r.status).toBe(200);
      const nowT = Date.now();
      worstGap = Math.max(worstGap, nowT - last);
      last = nowT;
      await new Promise(res => setTimeout(res, 10));
    }
  })();

  // Ingest spike: hammer enqueues for ~2.5s and DO NOT flush — with observationTickMs
  // = 0 nothing drains the queue, so pendingCount climbs and stays > 0 throughout,
  // which is exactly the abort signal a concurrent dedup slice must honour.
  const until = Date.now() + 2500;
  let n = 1000;
  while (Date.now() < until) {
    await enqueue(port, `hammered ingest row variant ${n}`, n);
    n++;
    await new Promise(r => setTimeout(r, 5));
  }

  stopHealth = true;
  await healthLoop;

  // Let any in-flight slice finish recording its run, then assert.
  await new Promise(r => setTimeout(r, 200));

  expect(worstGap).toBeLessThan(FRESH_MS);                          // heartbeat never starved

  const runs = qmRuns();
  expect(runs.length).toBeGreaterThan(0);                          // slices did run
  expect(runs.some(r => r.aborted_for_ingest === 1)).toBe(true);   // ≥1 slice yielded to ingest
});
