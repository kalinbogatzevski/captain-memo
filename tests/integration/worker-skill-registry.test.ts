import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

let worker: WorkerHandle;
let workDir: string;
let skillPath: string;
let port: number;

async function eventually<T>(fn: () => Promise<T | null>, timeoutMs = 4_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for skill registry');
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-skills-'));
  const skillDir = join(workDir, '.agents', 'skills', 'release');
  mkdirSync(skillDir, { recursive: true });
  skillPath = join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, `---\nname: release\ndescription: Safely publish a moonbeam package\n---\n\n# Release\n\nVerify the moonbeam checksum.\n`);
  writeFileSync(join(skillDir, 'NOTES.md'), '# Companion notes are not a skill\n');
  worker = await startWorker({
    port: 0, projectId: 'skill-test', metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused', embedderModel: 'voyage-4-nano',
    vectorDbPath: ':memory:', embeddingDimension: 8, skipEmbed: true,
    watchSources: [{ paths: [join(workDir, '.agents', 'skills', '*', 'SKILL.md')], channel: 'skill' }],
  });
  port = worker.port;
});

afterAll(async () => {
  await worker.stop();
  rmWorkDir(workDir);
});

test('skill registry recommends, loads full instructions, and follows CLI updates', async () => {
  const first = await eventually(async () => {
    const res = await fetch(`http://localhost:${port}/skills/recommend`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'publish moonbeam package', top_k: 3 }),
    });
    const body = await res.json() as { skills: Array<{ doc_id: string; description: string }> };
    return body.skills[0] ?? null;
  });
  expect(first.description).toContain('Safely publish');

  const listed = await fetch(`http://localhost:${port}/skills/list`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source_agent: 'codex', limit: 10 }),
  }).then((res) => res.json()) as {
    count: number;
    skills: Array<{ name: string; source_agent: string; doc_id: string }>;
  };
  expect(listed.count).toBe(1);
  expect(listed.skills[0]).toMatchObject({ name: 'release', source_agent: 'codex' });
  expect(listed.skills[0]!.doc_id).toStartWith('skill:');

  const loaded = await fetch(`http://localhost:${port}/get_full`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc_id: first.doc_id }),
  }).then((res) => res.json()) as { content: string; metadata: Record<string, unknown> };
  expect(loaded.content).toContain('Verify the moonbeam checksum.');
  expect(loaded.metadata.advisory).toBe(true);

  writeFileSync(skillPath, `---\nname: release\ndescription: Safely publish a moonbeam package\n---\n\n# Release\n\nVerify the updated nebula signature.\n`);
  const updated = await eventually(async () => {
    const res = await fetch(`http://localhost:${port}/skills/recommend`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'publish moonbeam package', top_k: 3 }),
    });
    const body = await res.json() as { skills: Array<{ doc_id: string }> };
    const hit = body.skills[0];
    if (!hit) return null;
    const full = await fetch(`http://localhost:${port}/get_full`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc_id: hit.doc_id }),
    }).then((response) => response.json()) as { content?: string };
    return full.content?.includes('updated nebula signature') ? full : null;
  });
  expect(updated.content).toContain('updated nebula signature');
});
