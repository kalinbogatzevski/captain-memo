import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { readFileSync } from 'fs';
import { spawn } from 'bun';

const PORT = 39904;
const FIXTURE = readFileSync(
  join(import.meta.dir, '../fixtures/hooks/session-start.input.json'),
  'utf-8',
);
const HOOK_PATH = join(import.meta.dir, '../../src/hooks/session-start.ts');

let statsCalls = 0;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/stats') {
        statsCalls++;
        return Response.json({
          total_chunks: 1234,
          by_channel: { memory: 100, observation: 1134 },
          observations: { total: 5, queue_pending: 0, queue_processing: 0 },
          indexing: { status: 'ready', total: 100, done: 100, errors: 0, percent: 100 },
          project_id: 'test',
          embedder: { model: 'voyage-4-lite', endpoint: 'https://api.voyageai.com/v1/embeddings' },
        });
      }
      return new Response('nf', { status: 404 });
    },
  });
});

afterAll(() => server.stop());

async function runHook(env: Record<string, string> = {}) {
  const proc = spawn({
    cmd: ['bun', HOOK_PATH],
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, CAPTAIN_MEMO_WORKER_PORT: String(PORT), ...env },
  });
  proc.stdin.write(FIXTURE);
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

test('SessionStart — fetches /stats and prints corpus banner', async () => {
  statsCalls = 0;
  const { stdout, exitCode } = await runHook();
  expect(exitCode).toBe(0);
  expect(statsCalls).toBeGreaterThanOrEqual(1);
  expect(stdout).toContain('Captain Memo');
  expect(stdout).toContain('1,234 chunks');
  expect(stdout).toContain('memory=100');
  expect(stdout).toContain('voyage-4-lite');
});

test('SessionStart — exits 0 even when worker unreachable', async () => {
  const { exitCode } = await runHook({ CAPTAIN_MEMO_WORKER_PORT: '1' });
  expect(exitCode).toBe(0);
});
