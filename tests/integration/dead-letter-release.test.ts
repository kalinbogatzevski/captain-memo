import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker } from '../../src/worker/index.ts';
import { ObservationQueue } from '../../src/worker/observation-queue.ts';
import type { RawObservationEvent } from '../../src/shared/types.ts';

// A dead letter used to be permanent. markPermanent stops retrying an auth failure on purpose — a retry
// storm burns quota to no end — but nothing ever released the rows afterwards, so every observation
// queued while a credential was lapsed was lost silently and forever.
//
// The re-probe covers the captain that boots with NO provider. This covers the ORDINARY case it misses:
// an operator repairs the credential by hand and restarts, and the rows from the outage are still there.
// One workstation is why: its 37 came back only because someone knew a CLI command existed.

const ev = (n: number): RawObservationEvent => ({
  session_id: 'ses-dead', project_id: 'p', prompt_number: n,
  tool_name: 'Read', tool_input_summary: `file_path=/f${n}`, tool_result_summary: 'ok',
  files_read: [`/f${n}`], files_modified: [], ts_epoch: Math.floor(Date.now() / 1000),
});

/** Seed a queue db with `n` rows already dead-lettered, exactly as a credential outage leaves it. */
function seedDeadLetters(queueDb: string, n: number): void {
  const q = new ObservationQueue(queueDb);
  const ids = Array.from({ length: n }, (_, i) => q.enqueue(ev(i + 1)));
  q.takeBatch(n);
  q.markPermanent(ids, 'claude-oauth: no OAuth token at ~/.claude/.credentials.json');
  expect(q.failedCount()).toBe(n);
  q.close();
}

const baseOpts = (workDir: string) => ({
  port: 0,
  projectId: 'dead-letter',
  metaDbPath: ':memory:',
  embedderEndpoint: 'http://localhost:0/unused',
  embedderModel: 'voyage-4-nano',
  vectorDbPath: join(workDir, 'vec.db'),
  embeddingDimension: 8,
  skipEmbed: true,
  observationQueueDbPath: join(workDir, 'queue.db'),
  observationsDbPath: join(workDir, 'obs.db'),
  pendingEmbedDbPath: join(workDir, 'pending.db'),
  observationTickMs: 0,          // no draining — this test is about the RELEASE, not the summarising
});

test('a worker that boots WITH a summarizer releases what the outage dead-lettered', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'cm-deadletter-'));
  const queueDb = join(workDir, 'queue.db');
  seedDeadLetters(queueDb, 4);

  const worker = await startWorker({
    ...baseOpts(workDir),
    summarize: async () => ({
      type: 'feature', title: 'stub', narrative: '', facts: [], concepts: [],
    }),
  });
  await worker.stop();

  const q = new ObservationQueue(queueDb);
  expect(q.failedCount()).toBe(0);      // nothing left dead
  expect(q.pendingCount()).toBe(4);     // all of it drainable again
  q.close();
  rmSync(workDir, { recursive: true, force: true });
});

test('a worker that boots WITHOUT one leaves them alone — there is nothing to succeed against', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'cm-deadletter-none-'));
  const queueDb = join(workDir, 'queue.db');
  seedDeadLetters(queueDb, 3);

  // No summarize: releasing here would just re-dead-letter the rows and lose their error text. The
  // re-probe releases them later, once a provider actually comes back.
  const worker = await startWorker(baseOpts(workDir));
  await worker.stop();

  const q = new ObservationQueue(queueDb);
  expect(q.failedCount()).toBe(3);
  expect(q.pendingCount()).toBe(0);
  q.close();
  rmSync(workDir, { recursive: true, force: true });
});

test('a read-only worker never writes to the queue', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'cm-deadletter-ro-'));
  const queueDb = join(workDir, 'queue.db');
  const metaDb = join(workDir, 'meta.db');
  const summarize = async () => ({
    type: 'feature' as const, title: 's', narrative: '', facts: [], concepts: [],
  });

  // A read-only worker cannot CREATE its databases (and ':memory:' cannot be opened read-only at all),
  // so make them with a normal boot first. Seed the dead letters AFTER it stops, or that boot would
  // release them and there would be nothing left to prove.
  const seed = await startWorker({ ...baseOpts(workDir), metaDbPath: metaDb, summarize });
  await seed.stop();
  seedDeadLetters(queueDb, 2);

  const worker = await startWorker({
    ...baseOpts(workDir), metaDbPath: metaDb, readOnly: true, summarize,
  });
  await worker.stop();

  const q = new ObservationQueue(queueDb);
  expect(q.failedCount()).toBe(2);      // untouched — read-only means read-only
  q.close();
  rmSync(workDir, { recursive: true, force: true });
});
