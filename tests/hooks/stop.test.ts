import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

// Each hook runs in a THROWAWAY data dir. These hooks write state (the .degraded-<session_id> flag,
// the .worker-transition breadcrumb, .install-version) and default to the real ~/.captain-memo —
// which is how test litter reached a developer's live data dir once already.
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'captain-memo-hooktest-'));

import { readFileSync } from 'fs';
import { spawn } from 'bun';

let port = 0;
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
    port: 0,
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
  port = server.port ?? 0;
});

afterAll(() => server.stop());

async function runHook(env: Record<string, string> = {}) {
  const proc = spawn({
    cmd: ['bun', HOOK_PATH],
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, CAPTAIN_MEMO_DATA_DIR: TEST_DATA_DIR, CAPTAIN_MEMO_WORKER_PORT: String(port), ...env },
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

// The other half of the one-shot banner: a session told "memory is paused" must hear when it is back.
const DEGRADED_FLAG = '.degraded-ses_2026-05-07T12-00-00_abc123';

test('Stop — announces the recovery once for a session that was told memory was down', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'captain-memo-degraded-'));
  try {
    writeFileSync(join(dir, DEGRADED_FLAG), new Date().toISOString(), 'utf-8');
    const first = await runHook({ CAPTAIN_MEMO_DATA_DIR: dir });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('back online');
    // Consumed: a second turn must not repeat it.
    const second = await runHook({ CAPTAIN_MEMO_DATA_DIR: dir });
    expect(second.stdout).not.toContain('back online');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Stop — a failed flush KEEPS the flag, so the notice is not burned on a still-down worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'captain-memo-degraded-'));
  try {
    writeFileSync(join(dir, DEGRADED_FLAG), new Date().toISOString(), 'utf-8');
    const { stdout } = await runHook({ CAPTAIN_MEMO_DATA_DIR: dir, CAPTAIN_MEMO_WORKER_PORT: '1' });
    expect(stdout).not.toContain('back online');
    expect(existsSync(join(dir, DEGRADED_FLAG))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
