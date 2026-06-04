import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerOptions } from '../../src/worker/index.ts';

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

function baseOpts(dir: string): WorkerOptions {
  return {
    port: 0, projectId: 'default',
    metaDbPath: join(dir, 'meta.db'),
    embedderEndpoint: 'http://127.0.0.1:1/none', embedderModel: 'm',
    vectorDbPath: join(dir, 'vec.db'), embeddingDimension: 4,
    skipEmbed: true, observationsDbPath: join(dir, 'obs.db'),
    noServe: true,
  };
}

test('writer boot initializes the dbs, then a reader opens them readonly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-wr-'));
  const writer = await startWorker(baseOpts(dir));
  await writer.stop();
  const reader = await startWorker({ ...baseOpts(dir), readOnly: true });
  stop = reader.stop;
  expect(reader.handler).toBeDefined();
});

test('reader boot serves a read handler', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-rd-'));
  const w = await startWorker(baseOpts(dir)); await w.stop();
  const reader = await startWorker({ ...baseOpts(dir), readOnly: true });
  stop = reader.stop;
  const res = await reader.handler!(new Request('http://x/observations/recent'));
  expect(res.status).toBe(200);
});
