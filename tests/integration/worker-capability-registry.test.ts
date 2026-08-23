import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

let worker: WorkerHandle;
let workDir: string;
let manifestPath: string;
let port: number;

async function eventually<T>(fn: () => Promise<T | null>, timeoutMs = 4_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for capability registry');
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-capabilities-'));
  const root = join(workDir, '.gemini', 'extensions', 'nanobanana');
  mkdirSync(join(root, 'commands'), { recursive: true });
  writeFileSync(join(root, 'commands', 'generate.toml'), 'description = "Generate an image"');
  writeFileSync(join(root, 'commands', 'edit.toml'), 'description = "Edit an image"');
  manifestPath = join(root, 'gemini-extension.json');
  writeFileSync(manifestPath, JSON.stringify({
    name: 'nanobanana', version: '1.0.10', description: 'Generate and manipulate moonbeam images',
    mcpServers: { nanobanana: { command: 'node', env: { API_KEY: 'must-not-leak' } } },
  }));
  const claudeRoot = join(workDir, '.claude', 'plugins', 'cache', 'reviewer', '1.0.0');
  mkdirSync(join(claudeRoot, '.claude-plugin'), { recursive: true });
  const claudeManifest = join(claudeRoot, '.claude-plugin', 'plugin.json');
  writeFileSync(claudeManifest, JSON.stringify({ name: 'reviewer', description: 'Review pull requests', version: '1.0.0' }));
  worker = await startWorker({
    port: 0, projectId: 'capability-test', metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused', embedderModel: 'voyage-4-nano',
    vectorDbPath: ':memory:', embeddingDimension: 8, skipEmbed: true,
    watchSources: [{ paths: [join(workDir, '.gemini', 'extensions', '*', 'gemini-extension.json'), claudeManifest], channel: 'capability' }],
  });
  port = worker.port;
});

afterAll(async () => { await worker.stop(); rmWorkDir(workDir); });

test('capability registry lists, recommends, details, and follows manifest updates', async () => {
  const first = await eventually(async () => {
    const body = await fetch(`http://localhost:${port}/capabilities/recommend`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'generate moonbeam image', top_k: 3 }),
    }).then(res => res.json()) as { capabilities: Array<Record<string, unknown>> };
    return body.capabilities[0] ?? null;
  });
  expect(first).toMatchObject({ name: 'nanobanana', source_agent: 'gemini', executable: false });
  expect(first.operations).toEqual(['edit', 'generate']);
  expect(JSON.stringify(first)).not.toContain('must-not-leak');

  const listed = await fetch(`http://localhost:${port}/capabilities/list`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_agent: 'gemini' }),
  }).then(res => res.json()) as { count: number; capabilities: Array<{ capability_ref: string }> };
  expect(listed.count).toBe(1);
  const detail = await fetch(`http://localhost:${port}/capabilities/get`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability_ref: listed.capabilities[0]!.capability_ref }),
  }).then(res => res.json()) as { capability: { description: string; execution: { runtime: string } } };
  expect(detail.capability.execution.runtime).toBe('gemini');

  writeFileSync(manifestPath, JSON.stringify({
    name: 'nanobanana', version: '1.0.11', description: 'Generate, edit, and restore moonbeam images',
    mcpServers: { nanobanana: { command: 'different-secret-command' } },
  }));
  const updated = await eventually(async () => {
    const body = await fetch(`http://localhost:${port}/capabilities/list`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then(res => res.json()) as { capabilities: Array<{ version: string }> };
    return body.capabilities[0]?.version === '1.0.11' ? body.capabilities[0] : null;
  });
  expect(updated.version).toBe('1.0.11');
  expect(JSON.stringify(updated)).not.toContain('different-secret-command');
});

test('literal active-plugin manifest paths are indexed without broad cache globs', async () => {
  const listed = await eventually(async () => {
    const body = await fetch(`http://localhost:${port}/capabilities/list`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_agent: 'claude-code' }),
    }).then(res => res.json()) as { capabilities: Array<{ name: string }> };
    return body.capabilities[0] ?? null;
  });
  expect(listed.name).toBe('reviewer');
});
