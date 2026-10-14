import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

// worker.env is read by the worker and never by the hooks, so CAPTAIN_MEMO_GREETING reaches the SessionStart banner
// only through /stats. The hook side is tested in tests/hooks/session-start.test.ts.
let worker: WorkerHandle | undefined;
let workDir = '';
const saved = { greeting: process.env.CAPTAIN_MEMO_GREETING, cache: process.env.CAPTAIN_MEMO_STATS_CACHE_MS };
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  rmWorkDir(workDir);
  restore('CAPTAIN_MEMO_GREETING', saved.greeting);
  restore('CAPTAIN_MEMO_STATS_CACHE_MS', saved.cache);
});

test('GET /stats — carries the worker\'s CAPTAIN_MEMO_GREETING when set, and no greeting key when not', async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-greet-'));
  process.env.CAPTAIN_MEMO_STATS_CACHE_MS = '0';   // /stats is stale-while-revalidate: with 0 each call starts a refresh
  worker = await startWorker({
    port: 0,
    projectId: 'greet-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    summarize: async () => ({ type: 'change', title: 't', narrative: 'n', facts: [], concepts: [] }),
    observationTickMs: 0,
  });
  const stats = async () => await (await fetch(`http://localhost:${worker!.port}/stats`)).json() as Record<string, unknown>;
  // The call that finds the cache stale is answered from it and starts the refresh, so poll until the answer changes.
  const greetingNow = async (want: string | undefined) => {
    let g: unknown;
    for (let i = 0; i < 50; i++) { g = (await stats()).greeting; if (g === want) break; await Bun.sleep(100); }
    return g;
  };

  delete process.env.CAPTAIN_MEMO_GREETING;
  expect('greeting' in await stats()).toBe(false);
  process.env.CAPTAIN_MEMO_GREETING = 'Samo Levski!';
  expect(await greetingNow('Samo Levski!')).toBe('Samo Levski!');
  delete process.env.CAPTAIN_MEMO_GREETING;
  expect(await greetingNow(undefined)).toBeUndefined();
  expect('greeting' in await stats()).toBe(false);
});
