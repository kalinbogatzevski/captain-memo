import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { readFileSync } from 'fs';
import { spawn } from 'bun';

const PORT = 39906;
const FIXTURE = readFileSync(
  join(import.meta.dir, '../fixtures/hooks/pre-compact.input.json'),
  'utf-8',
);
const HOOK_PATH = join(import.meta.dir, '../../src/hooks/pre-compact.ts');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let received: any[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/observation/enqueue') {
        const body = await req.json();
        received.push(body);
        return Response.json({ id: 1, queued: true });
      }
      return new Response('nf', { status: 404 });
    },
  });
});

afterAll(() => server.stop());

async function runHook(input: string, env: Record<string, string> = {}) {
  const proc = spawn({
    cmd: ['bun', HOOK_PATH],
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, CAPTAIN_MEMO_WORKER_PORT: String(PORT), ...env },
  });
  proc.stdin.write(input);
  proc.stdin.end();
  await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode };
}

test('PreCompact — enqueues a RawObservationEvent with source="pre-compact"', async () => {
  received = [];
  await runHook(FIXTURE);
  expect(received).toHaveLength(1);
  const ev = received[0];
  expect(ev.source).toBe('pre-compact');
  expect(ev.session_id).toBe('ses_2026-05-11T09-00-00_precompact1');
  expect(ev.tool_name).toBe('pre-compact');
  expect(typeof ev.tool_result_summary).toBe('string');
});

test('PreCompact — fire-and-forget on worker down', async () => {
  const { exitCode } = await runHook(FIXTURE, { CAPTAIN_MEMO_WORKER_PORT: '1' });
  expect(exitCode).toBe(0);
});

test('PreCompact — invalid stdin → exit 0 without crashing', async () => {
  const { exitCode } = await runHook('not json');
  expect(exitCode).toBe(0);
});
