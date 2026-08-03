// tests/integration/ivf-wiring.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

let workDir: string;
let worker: WorkerHandle;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-ivf-wiring-'));
});

afterEach(async () => {
  if (worker) await worker.stop();
  rmWorkDir(workDir);
  delete process.env.CAPTAIN_MEMO_IVF_SWEEP_MS; // always runs, even if a test throws before its own cleanup
});

test('startWorker — IVF clustering stays off by default, but the sweep (incl. legacy migration) still runs harmlessly and does not error', async () => {
  worker = await startWorker({
    port: 0,
    projectId: 'default',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 4,
    skipEmbed: true,
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    summarize: async (events) => ({
      type: 'change', title: `summary of ${events.length} events`,
      narrative: 'stub', facts: [], concepts: [],
    }),
    observationTickMs: 0,
  });
  // No CAPTAIN_MEMO_IVF_ENABLED set — the worker must start cleanly, and a
  // normal search must still work (brute-force path, since IVF is off).
  const res = await fetch(`http://localhost:${worker.port}/search/all`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'anything', top_k: 5 }),
  });
  expect(res.status).toBe(200);
});

test('startWorker — the real sweep wiring migrates legacy rows over actual ticks, even with IVF clustering disabled', async () => {
  // Proves the ACTUAL index.ts wiring (not just the pure runIvfSweepSlice
  // function, already covered in Task 4's unit tests) drains the old
  // vec_chunks table via real setInterval ticks — the exact end-to-end path
  // a real upgrade hits, with IVF left at its default (disabled).
  const vectorDbPath = join(workDir, 'vec.db');
  const { VectorStore } = await import('../../src/worker/vector-store.ts');
  const seed = new VectorStore({ dbPath: vectorDbPath, dimension: 4 });
  seed.close();
  const { Database } = await import('bun:sqlite');
  const sqliteVec = await import('sqlite-vec');
  const raw = new Database(vectorDbPath);
  sqliteVec.load(raw);
  const blob = new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer);
  raw.query(`INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)`).run('legacy-chunk', blob);
  raw.query(`INSERT INTO vec_chunk_meta (chunk_id, collection_name) VALUES (?, ?)`).run('legacy-chunk', 'am_wiring-test');
  raw.close();

  // No CAPTAIN_MEMO_IVF_ENABLED — this is the critical case: default config.
  // Real sweepIntervalMs default (60s) would make this test slow; override via
  // env BEFORE startWorker, since loadIvfConfig reads process.env synchronously
  // during that call — setting it after would be too late.
  process.env.CAPTAIN_MEMO_IVF_SWEEP_MS = '50';
  worker = await startWorker({
    port: 0,
    projectId: 'wiring-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath,
    embeddingDimension: 4,
    skipEmbed: true,
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    summarize: async (events) => ({
      type: 'change', title: `summary of ${events.length} events`,
      narrative: 'stub', facts: [], concepts: [],
    }),
    observationTickMs: 0,
  });

  const check = new VectorStore({ dbPath: vectorDbPath, dimension: 4, readonly: true });
  const start = Date.now();
  while (check.countLegacyRows() > 0 && Date.now() - start < 5000) {
    await new Promise(r => setTimeout(r, 100));
  }
  expect(check.countLegacyRows()).toBe(0);
  check.close();
});
