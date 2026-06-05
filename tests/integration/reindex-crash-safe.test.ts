import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { startWorker, type WorkerHandle, type WorkerOptions } from '../../src/worker/index.ts';

// Crash-safety contract for POST /reindex {force:true}: the force path must be
// embed-then-swap, never delete-then-rebuild. A failed embed during a --force
// reindex must leave the observation's existing vectors fully intact.

const SUMMARIZE: NonNullable<WorkerOptions['summarize']> = async (events) => ({
  type: 'change',
  title: `summary of ${events.length} events`,
  narrative: 'stub narrative for crash-safety',
  facts: events.map(e => `${e.tool_name}: ${e.tool_input_summary}`),
  concepts: ['stub'],
});

function baseOpts(workDir: string, projectId: string): WorkerOptions {
  return {
    port: 0,
    projectId,
    metaDbPath: join(workDir, 'meta.db'),
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    summarize: SUMMARIZE,
    observationTickMs: 0, // no auto-tick — flush is driven manually
  };
}

async function enqueueOne(port: number, sessionId: string): Promise<void> {
  const res = await fetch(`http://localhost:${port}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId, project_id: 'p1', prompt_number: 1,
      tool_name: 'Edit', tool_input_summary: 'edit foo.ts', tool_result_summary: 'ok',
      files_read: [], files_modified: ['foo.ts'], ts_epoch: 1_700_000_000,
    }),
  });
  expect(res.status).toBe(200);
}

async function flush(port: number, sessionId: string): Promise<void> {
  const res = await fetch(`http://localhost:${port}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { observations_created: number };
  expect(body.observations_created).toBeGreaterThanOrEqual(1);
}

// vec_chunk_meta is a plain SQLite table (no vec0 extension needed) kept 1:1
// with vec_chunks: vector.add inserts both, vector.delete removes both. Counting
// it directly reflects how many vector rows exist for the collection.
function vectorRowCount(vectorDbPath: string, projectId: string): number {
  const db = new Database(vectorDbPath, { readonly: true });
  try {
    const row = db
      .query('SELECT COUNT(*) AS n FROM vec_chunk_meta WHERE collection_name = ?')
      .get(`am_${projectId}`) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

test('Test A — failed --force reindex preserves the observation\'s old vectors', async () => {
  const projectId = 'reindex-crashsafe-A';
  const workDir = mkdtempSync(join(tmpdir(), 'captain-memo-reindex-A-'));
  try {
    // Worker A: index one observation with skipEmbed (zero-vectors get added,
    // so vec_chunks/vec_chunk_meta gets rows for this observation).
    const workerA = await startWorker(baseOpts(workDir, projectId));
    await enqueueOne(workerA.port, 's-A');
    await flush(workerA.port, 's-A');
    await workerA.stop();

    const before = vectorRowCount(join(workDir, 'vec.db'), projectId);
    expect(before).toBeGreaterThan(0);

    // Worker B: same dataDir, but real embedding against an UNREACHABLE endpoint
    // so the reindex embed call throws.
    const optsB: WorkerOptions = {
      ...baseOpts(workDir, projectId),
      skipEmbed: false,
      embedderEndpoint: 'http://127.0.0.1:1/unused',
    };
    const workerB = await startWorker(optsB);

    const res = await fetch(`http://localhost:${workerB.port}/reindex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'observation', force: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { errors: number; indexed: number };
    expect(body.errors).toBeGreaterThan(0); // embed failed
    expect(body.indexed).toBe(0);

    await workerB.stop();

    // The bug: delete-then-rebuild drops these vectors before the failed embed,
    // so the count collapses to 0. Embed-then-swap keeps them intact.
    const after = vectorRowCount(join(workDir, 'vec.db'), projectId);
    expect(after).toBe(before);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('Test B — successful --force reindex preserves tide_state and stability_days', async () => {
  const projectId = 'reindex-crashsafe-B';
  const workDir = mkdtempSync(join(tmpdir(), 'captain-memo-reindex-B-'));
  let worker: WorkerHandle | undefined;
  try {
    worker = await startWorker(baseOpts(workDir, projectId));
    await enqueueOne(worker.port, 's-B');
    await flush(worker.port, 's-B');

    const obs = worker.store!.listForSession('s-B')[0]!;
    const obsId = obs.id;

    // Set tide lifecycle columns directly (raw UPDATE) — reindex must never
    // touch these; it should only rewrite stored_tokens.
    const obsDb = new Database(join(workDir, 'obs.db'));
    obsDb.query("UPDATE observations SET tide_state = 'dormant', stability_days = 42 WHERE id = ?").run(obsId);
    obsDb.close();

    const res = await fetch(`http://localhost:${worker.port}/reindex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'observation', force: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { indexed: number; errors: number };
    expect(body.indexed).toBeGreaterThan(0);
    expect(body.errors).toBe(0);

    const reloaded = new Database(join(workDir, 'obs.db'), { readonly: true });
    const row = reloaded
      .query('SELECT tide_state, stability_days FROM observations WHERE id = ?')
      .get(obsId) as { tide_state: string; stability_days: number };
    reloaded.close();

    expect(row.tide_state).toBe('dormant');
    expect(row.stability_days).toBe(42);
  } finally {
    if (worker) await worker.stop();
    rmSync(workDir, { recursive: true, force: true });
  }
});
