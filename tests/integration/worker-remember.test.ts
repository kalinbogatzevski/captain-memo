import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import type { SummarizerTransport } from '../../src/worker/summarizer.ts';

let worker: WorkerHandle;
let port = 0;
let dir = '';

const transport: SummarizerTransport = async () => ({
  content: [{ type: 'text', text: JSON.stringify({
    name: 'Use Bun for all scripts',
    description: 'Project standardizes on Bun over Node.',
    slug: 'use-bun',
    type: 'decision',
  }) }],
  model: 'test-model',
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cm-remember-'));
  worker = await startWorker({
    port: 0,
    projectId: 'test-project',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: ':memory:',
    embeddingDimension: 1024,
    skipEmbed: true,
    summarizerTransport: transport,
  });
  port = worker.port;
});

afterAll(async () => {
  try { await worker.stop(); } catch { /* best-effort */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test('POST /remember writes a memory file to targetDirOverride and indexes it', async () => {
  const res = await fetch(`http://localhost:${port}/remember`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      body: 'We standardize on Bun for all scripts and tests.',
      type: 'decision',
      targetDirOverride: dir,
    }),
  });
  expect(res.status).toBe(200);
  const out = await res.json() as { ok: boolean; path: string; action: string; doc_id: string };
  expect(out.ok).toBe(true);
  expect(out.action).toBe('created');
  expect(existsSync(out.path)).toBe(true);
  expect(out.path.startsWith(dir)).toBe(true);
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  expect(files.length).toBe(1);
  const content = readFileSync(out.path, 'utf-8');
  expect(content).toContain('Bun');
});

test('POST /remember rejects a body missing required fields with 400', async () => {
  const res = await fetch(`http://localhost:${port}/remember`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'decision' }),
  });
  expect(res.status).toBe(400);
  const out = await res.json() as { error: string };
  expect(out.error).toBe('invalid_request');
});

test('POST /remember second overlapping call updates in place (one file)', async () => {
  const again = await fetch(`http://localhost:${port}/remember`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      body: 'We standardize on Bun; also use bun test for the suite.',
      type: 'decision',
      slug: 'use-bun',
      targetDirOverride: dir,
    }),
  });
  expect(again.status).toBe(200);
  const out = await again.json() as { ok: boolean; action: string };
  expect(out.ok).toBe(true);
  expect(out.action).toBe('updated');
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  expect(files.length).toBe(1);
});
