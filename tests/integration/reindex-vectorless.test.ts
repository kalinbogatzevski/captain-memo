import { test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { startWorker, type WorkerOptions } from '../../src/worker/index.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

// A plain `reindex` (no --force) must re-embed rows whose vector is gone, not skip them as "already indexed".
// Field 2026-08-03, an outside user: `reindex --redim 1024` deletes the vector index and keeps the chunk rows; it was
// rate-limited at "indexed 115, errors 20394"; the documented re-run (README: "resumable, re-run without --force") then
// answered "indexed 2, skipped 20493, errors 0" at exit 0 over a corpus that was 99% unembedded. Only --force worked.

const SUMMARIZE: NonNullable<WorkerOptions['summarize']> = async (events) => ({
  type: 'change',
  title: `summary of ${events.length} events`,
  narrative: 'stub narrative',
  facts: events.map(e => `${e.tool_name}: ${e.tool_input_summary}`),
  concepts: ['stub'],
});

function opts(workDir: string, projectId: string): WorkerOptions {
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
    observationTickMs: 0,
  };
}

const post = (port: number, path: string, body: unknown) =>
  fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const reindex = async (port: number, force = false) =>
  await (await post(port, '/reindex', { channel: 'observation', force })).json() as { indexed: number; skipped: number; errors: number };

function vectorRows(vecDb: string, projectId: string): number {
  const db = new Database(vecDb, { readonly: true });
  try { return (db.query('SELECT COUNT(*) AS n FROM vec_chunk_meta WHERE collection_name = ?').get(`am_${projectId}`) as { n: number }).n; }
  finally { db.close(); }
}

test('a plain reindex skips an observation that has its vector, and re-embeds one whose vector is gone', async () => {
  const projectId = 'reindex-vectorless';
  const workDir = mkdtempSync(join(tmpdir(), 'captain-memo-reindex-vectorless-'));
  try {
    const w1 = await startWorker(opts(workDir, projectId));
    expect((await post(w1.port, '/observation/enqueue', {
      session_id: 's1', project_id: 'p1', prompt_number: 1, tool_name: 'Edit', tool_input_summary: 'edit foo.ts',
      tool_result_summary: 'ok', files_read: [], files_modified: ['foo.ts'], ts_epoch: 1_700_000_000,
    })).status).toBe(200);
    expect((await post(w1.port, '/observation/flush', { session_id: 's1' })).status).toBe(200);

    // Control: the vector is there, so a plain re-run has nothing to do.
    expect(vectorRows(join(workDir, 'vec.db'), projectId)).toBeGreaterThan(0);
    expect(await reindex(w1.port)).toMatchObject({ indexed: 0, skipped: 1, errors: 0 });

    // What --redim leaves behind: the chunk rows survive, the vectors are gone. (vec_chunk_meta is the presence table
    // the check reads; the vec0 rows are rewritten by the re-embed regardless.)
    const vec = new Database(join(workDir, 'vec.db'));
    vec.query('DELETE FROM vec_chunk_meta WHERE collection_name = ?').run(`am_${projectId}`);
    vec.close();
    expect(vectorRows(join(workDir, 'vec.db'), projectId)).toBe(0);

    // The bug: this answered {indexed: 0, skipped: 1} and the corpus stayed unembedded.
    expect(await reindex(w1.port)).toMatchObject({ indexed: 1, skipped: 0, errors: 0 });
    expect(vectorRows(join(workDir, 'vec.db'), projectId)).toBeGreaterThan(0);

    // And once it has its vector again the next re-run is a no-op, i.e. genuinely resumable.
    expect(await reindex(w1.port)).toMatchObject({ indexed: 0, skipped: 1, errors: 0 });
    await w1.stop();
  } finally {
    rmWorkDir(workDir);
  }
});
