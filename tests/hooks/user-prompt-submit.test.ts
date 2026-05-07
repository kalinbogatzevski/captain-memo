import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { readFileSync } from 'fs';
import { spawn } from 'bun';

const PORT = 39903;
const FIXTURE = readFileSync(
  join(import.meta.dir, '../fixtures/hooks/user-prompt-submit.input.json'),
  'utf-8',
);
const HOOK_PATH = join(import.meta.dir, '../../src/hooks/user-prompt-submit.ts');

let server: ReturnType<typeof Bun.serve>;
let lastReceived: unknown = null;

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/inject/context') {
        lastReceived = await req.json();
        return Response.json({
          envelope: '<memory-context project="t" k="1" budget-tokens="1000">stub</memory-context>',
          hit_count: 1,
          budget_tokens: 1000,
          used_tokens: 50,
          channels_searched: ['memory'],
          degradation_flags: [],
          elapsed_ms: 12,
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
});

afterAll(() => server.stop());

async function runHook(input: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ['bun', HOOK_PATH],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      AELITA_MCP_WORKER_PORT: String(PORT),
      ...env,
    },
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

test('UserPromptSubmit — passes envelope to stdout', async () => {
  const { stdout, exitCode } = await runHook(FIXTURE);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('<memory-context');
  expect(stdout).toContain('stub');
});

test('UserPromptSubmit — preserves the original prompt at the bottom', async () => {
  const { stdout } = await runHook(FIXTURE);
  expect(stdout).toContain('How do I run the worker against a custom data dir?');
  expect(stdout.indexOf('</memory-context>')).toBeLessThan(stdout.indexOf('How do I run'));
});

test('UserPromptSubmit — fails open when worker is unreachable (no envelope, exit 0)', async () => {
  const { stdout, exitCode } = await runHook(FIXTURE, { AELITA_MCP_WORKER_PORT: '1' });
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain('<memory-context');
  expect(stdout).toContain('How do I run the worker');
});

test('UserPromptSubmit — respects AELITA_MCP_HOOK_TIMEOUT_MS', async () => {
  const start = Date.now();
  const { stdout, exitCode } = await runHook(FIXTURE, {
    AELITA_MCP_WORKER_PORT: '1',
    AELITA_MCP_HOOK_TIMEOUT_MS: '50',
  });
  const elapsed = Date.now() - start;
  expect(exitCode).toBe(0);
  expect(elapsed).toBeLessThan(800);
  expect(stdout).toContain('How do I run the worker');
});

test('UserPromptSubmit — empty stdin is tolerated', async () => {
  const { exitCode } = await runHook('');
  expect(exitCode).toBe(0);
});
