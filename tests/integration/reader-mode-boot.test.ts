import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, statSync } from 'fs';
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

// Fix #4 — the meta DB persists the E2E private scalars, so startWorker tightens it to owner-only 0600
// (best-effort). On POSIX the low 9 mode bits must read 0o600 after boot.
test('meta DB file is chmod 0600 after writer boot (E2E private keys at rest)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-chmod-'));
  const opts = baseOpts(dir);
  const w = await startWorker(opts);
  stop = w.stop;
  const mode = statSync(opts.metaDbPath).mode & 0o777;
  expect(mode).toBe(0o600);
});
