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

let healthCalls = 0;
let injectCalls: unknown[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        healthCalls++;
        return Response.json({ healthy: true });
      }
      if (url.pathname === '/inject/context') {
        const body = await req.json();
        injectCalls.push(body);
        return Response.json({
          envelope: '<memory-context project="t" k="0" budget-tokens="3000"></memory-context>',
          hit_count: 0, budget_tokens: 3000, used_tokens: 0,
          channels_searched: [], degradation_flags: [], elapsed_ms: 0,
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

test('SessionStart — calls /health to warm worker', async () => {
  healthCalls = 0; injectCalls = [];
  await runHook();
  expect(healthCalls).toBeGreaterThanOrEqual(1);
});

test('SessionStart — exits 0 even when worker unreachable', async () => {
  const { exitCode } = await runHook({ CAPTAIN_MEMO_WORKER_PORT: '1' });
  expect(exitCode).toBe(0);
});
