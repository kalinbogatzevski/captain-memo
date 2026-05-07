import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';

const PORT = 39902;
let worker: WorkerHandle;
let workDir: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'aelita-inject-'));
  const memDir = join(workDir, 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, 'feedback_seed.md'), `---\ntype: feedback\ndescription: Seeded\n---\nAlways use erp-components, no custom page styles.\n`);

  worker = await startWorker({
    port: PORT,
    projectId: 'inject-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    watchPaths: [join(memDir, '*.md')],
    watchChannel: 'memory',
    hookBudgetTokens: 2000,
  });
  // Wait for initial indexing
  await new Promise(r => setTimeout(r, 500));
});

afterEach(async () => {
  await worker.stop();
  rmSync(workDir, { recursive: true, force: true });
});

test('POST /inject/context returns envelope under budget', async () => {
  const start = Date.now();
  const res = await fetch(`http://localhost:${PORT}/inject/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'erp-components rule', top_k: 5 }),
  });
  const elapsed = Date.now() - start;
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.envelope).toMatch(/<memory-context/);
  expect(body.envelope).toMatch(/<\/memory-context>/);
  expect(body.used_tokens).toBeLessThanOrEqual(2000);
  expect(body.elapsed_ms).toBeGreaterThanOrEqual(0);
  // Worker side should respond fast even on cold cache (skipEmbed=true).
  expect(elapsed).toBeLessThan(500);
});

test('POST /inject/context — short prompts return empty envelope', async () => {
  const res = await fetch(`http://localhost:${PORT}/inject/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'ok' }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.hit_count).toBe(0);
  expect(body.envelope).toMatch(/<memory-context.*k="0"/);
});

test('POST /inject/context — invalid body → 400', async () => {
  const res = await fetch(`http://localhost:${PORT}/inject/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
});
