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
import { VERSION } from '../../src/shared/version.ts';

let port = 0;
const FIXTURE = readFileSync(
  join(import.meta.dir, '../fixtures/hooks/session-start.input.json'),
  'utf-8',
);
const HOOK_PATH = join(import.meta.dir, '../../src/hooks/session-start.ts');

let statsCalls = 0;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
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
          version: VERSION,
        });
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
  const { exitCode } = await runHook({ CAPTAIN_MEMO_WORKER_PORT: '1', CAPTAIN_MEMO_DISABLE_SELF_HEAL: '1' });
  expect(exitCode).toBe(0);
});

test('SessionStart — current worker: shows banner, no heal attempted', async () => {
  statsCalls = 0;
  const { stdout, exitCode } = await runHook(); // fake /stats returns version === VERSION
  expect(exitCode).toBe(0);
  expect(stdout).toContain('Captain Memo');
  expect(stdout).toContain('1,234 chunks');
});

// The banner branch this release exists for: a worker that is unreachable but left a breadcrumb must
// read as "updating / still starting", NOT as "unreachable", and must raise the per-session flag the
// Stop hook announces from. Self-heal is disabled here on purpose — the destructive half would drive
// the real service manager; the guard and the banner read the same variable, so a regression in
// computing it shows up in these assertions.
test('SessionStart — a fresh breadcrumb yields the transition banner, not "unreachable"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'captain-memo-transition-'));
  try {
    writeFileSync(join(dir, '.worker-transition'),
      JSON.stringify({ phase: 'updating', from: '0.41.1', to: '0.41.2', ts: Date.now() }), 'utf-8');
    const { stdout, exitCode } = await runHook({
      CAPTAIN_MEMO_DATA_DIR: dir,
      CAPTAIN_MEMO_WORKER_PORT: '1',
      CAPTAIN_MEMO_DISABLE_SELF_HEAL: '1',
      CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS: '300',
      CAPTAIN_MEMO_SESSION_START_TRANSITION_WAIT_MS: '300',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('updating (v0.41.1 → v0.41.2)');
    expect(stdout).not.toContain('unreachable');
    // …and the session is flagged, or the Stop hook has nothing to announce from.
    expect(existsSync(join(dir, '.degraded-ses_2026-05-07T12-00-00_abc123'))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SessionStart — a STALE breadcrumb falls through to the honest degraded banner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'captain-memo-transition-'));
  try {
    writeFileSync(join(dir, '.worker-transition'),
      JSON.stringify({ phase: 'booting', ts: Date.now() - 10 * 60_000 }), 'utf-8');
    const { stdout } = await runHook({
      CAPTAIN_MEMO_DATA_DIR: dir,
      CAPTAIN_MEMO_WORKER_PORT: '1',
      CAPTAIN_MEMO_DISABLE_SELF_HEAL: '1',
      CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS: '300',
    });
    expect(stdout).toContain('unreachable');
    expect(stdout).not.toContain('still starting up');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
