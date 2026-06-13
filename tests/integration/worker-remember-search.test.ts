// End-to-end for the curated-memory WRITE path. A real worker boots with a temp
// rememberDir; POST /remember writes a markdown file there; the entry is then
// retrievable via POST /search/memory. FTS-only (skipEmbed) so it's deterministic
// with no live embedder. Windows-safe teardown (env reset BEFORE rmWorkDir).
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

let worker: WorkerHandle | null = null;
let workDir = '';
let rememberDir = '';
let port = 0;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-remember-int-'));
  rememberDir = join(workDir, 'memory');
  process.env.CAPTAIN_MEMO_REMEMBER_DIR = rememberDir;
  worker = await startWorker({
    port: 0,
    projectId: 'remember-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    watchPaths: [join(rememberDir, '*.md')],
    watchChannel: 'memory',
  });
  port = worker.port;
});

afterEach(async () => {
  if (worker) { await worker.stop(); worker = null; }
  delete process.env.CAPTAIN_MEMO_REMEMBER_DIR;
  rmWorkDir(workDir); workDir = ''; rememberDir = '';
});

async function remember(payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`http://localhost:${port}/remember`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

test('POST /remember writes a markdown file to the remember dir', async () => {
  const { status, body } = await remember({
    body: 'Always deploy to staging before production on the billing service.',
    type: 'decision',
    name: 'billing deploy order',
    slug: 'billing-deploy-order',
  });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.action).toBe('created');
  expect(existsSync(body.path)).toBe(true);
  expect(body.path.startsWith(rememberDir)).toBe(true);
  const files = readdirSync(rememberDir).filter(f => f.endsWith('.md'));
  expect(files.length).toBe(1);
  const contents = readFileSync(body.path, 'utf-8');
  expect(contents).toContain('Always deploy to staging before production');
  expect(contents).toContain('type: decision');
});

test('a remembered entry is retrievable via POST /search/memory', async () => {
  await remember({
    body: 'Never round in the middle of a billing calculation; round only at the end.',
    type: 'decision',
    name: 'billing rounding rule',
    slug: 'billing-rounding-rule',
  });
  const res = await fetch(`http://localhost:${port}/search/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'billing rounding calculation', top_k: 5 }),
  });
  expect(res.status).toBe(200);
  const { results } = await res.json() as { results: Array<{ source_path: string; channel: string; snippet: string }> };
  const hit = results.find(r => r.source_path.endsWith('.md') && r.snippet.includes('round only at the end'));
  expect(hit).toBeDefined();
  expect(hit!.channel).toBe('memory');
});

test('a second overlapping /remember updates in place — one file, re-chunked', async () => {
  const first = await remember({
    body: 'Deploy the worker via systemd --user on Linux.',
    type: 'decision',
    name: 'worker deploy method',
    slug: 'worker-deploy-method',
  });
  expect(first.body.ok).toBe(true);
  expect(first.body.action).toBe('created');

  const second = await remember({
    body: 'Deploy the worker via systemd --user on Linux and a Scheduled Task on Windows.',
    type: 'decision',
    name: 'worker deploy method',
    slug: 'worker-deploy-method',
  });
  expect(second.status).toBe(200);
  expect(second.body.ok).toBe(true);
  expect(second.body.action).toBe('updated');
  expect(second.body.path).toBe(first.body.path);

  const files = readdirSync(rememberDir).filter(f => f.endsWith('.md'));
  expect(files.length).toBe(1);
  const contents = readFileSync(second.body.path, 'utf-8');
  expect(contents).toContain('Scheduled Task on Windows');

  const res = await fetch(`http://localhost:${port}/search/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'worker deploy Scheduled Task Windows', top_k: 5 }),
  });
  const { results } = await res.json() as { results: Array<{ snippet: string }> };
  expect(results.some(r => r.snippet.includes('Scheduled Task on Windows'))).toBe(true);
});
