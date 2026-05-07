import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { readFileSync } from 'fs';
import { spawn } from 'bun';

const PORT = 39906;
const FIXTURE = readFileSync(
  join(import.meta.dir, '../fixtures/hooks/stop.input.json'),
  'utf-8',
);
const HOOK_PATH = join(import.meta.dir, '../../src/hooks/stop.ts');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let flushBodies: any[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/observation/flush') {
        const body = await req.json();
        flushBodies.push(body);
        return Response.json({ processed: 3, observations_created: 1, pending_remaining: 0 });
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

test('Stop — flushes the queue with the session_id', async () => {
  flushBodies = [];
  await runHook();
  expect(flushBodies).toHaveLength(1);
  expect(flushBodies[0].session_id).toBe('ses_2026-05-07T12-00-00_abc123');
});

test('Stop — completes within 5s when worker is fast', async () => {
  const start = Date.now();
  const { exitCode } = await runHook();
  const elapsed = Date.now() - start;
  expect(exitCode).toBe(0);
  expect(elapsed).toBeLessThan(5_500);
});

test('Stop — completes within ~5s budget when worker unreachable', async () => {
  const start = Date.now();
  const { exitCode } = await runHook({ CAPTAIN_MEMO_WORKER_PORT: '1' });
  const elapsed = Date.now() - start;
  expect(exitCode).toBe(0);
  expect(elapsed).toBeLessThan(7_000);
});
