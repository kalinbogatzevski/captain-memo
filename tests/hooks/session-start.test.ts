import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

// Each hook runs in a THROWAWAY data dir. These hooks write state (the .degraded-<session_id> flag,
// the .worker-transition breadcrumb, .install-version) and default to the real ~/.captain-memo —
// which is how test litter reached a developer's live data dir once already.
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'captain-memo-hooktest-'));

import { readFileSync } from 'fs';
import { spawn } from 'bun';
import { VERSION } from '../../src/shared/version.ts';
import { LOCAL_ARTICLES } from '../../src/hooks/local-articles.ts';
import { sanitizeGreeting } from '../../src/hooks/session-start.ts';

// The greeting tests need the setting UNSET in the spawned hook, whatever the developer's own shell exports.
delete process.env.CAPTAIN_MEMO_GREETING;

let port = 0;
const FIXTURE = readFileSync(
  join(import.meta.dir, '../fixtures/hooks/session-start.input.json'),
  'utf-8',
);
const HOOK_PATH = join(import.meta.dir, '../../src/hooks/session-start.ts');

let statsCalls = 0;
let homeworkItems: unknown[] = [];
let statsExtra: Record<string, unknown> = {};   // merged over the default /stats body, per test
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
          ...statsExtra,
        });
      }
      if (url.pathname === '/homework/list') return Response.json({ items: homeworkItems });
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

// The full SKILL.md reaches Claude only as a model-invoked skill, so a session that never reads it had no rules.
// The local articles (work-board Foundation first) ride in on the hook envelope, beside the banner.
test('SessionStart — injects the local articles as additionalContext', async () => {
  const { stdout, exitCode } = await runHook();
  expect(exitCode).toBe(0);
  const env = JSON.parse(stdout);
  expect(env.hookSpecificOutput?.hookEventName).toBe('SessionStart');
  expect(env.hookSpecificOutput?.additionalContext).toBe(LOCAL_ARTICLES);
  expect(env.systemMessage).toContain('Captain Memo');   // banner still intact alongside it
});

test('SessionStart — the articles are injected even when the worker is unreachable', async () => {
  const { stdout, exitCode } = await runHook({ CAPTAIN_MEMO_WORKER_PORT: '1', CAPTAIN_MEMO_DISABLE_SELF_HEAL: '1' });
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout).hookSpecificOutput?.additionalContext).toBe(LOCAL_ARTICLES);
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

// Homework due times. The hook runs on the real clock, so these use a due time far in the past and one far in the future;
// the zone is pinned so the printed times are exact. The ordering and label rules themselves are in homework.test.ts.
const homeworkLines = async () => {
  const { stdout, exitCode } = await runHook({ TZ: 'UTC' });
  expect(exitCode).toBe(0);
  const msg = JSON.parse(stdout).systemMessage as string;
  return { msg, hw: msg.split('\n').filter((l) => /^\s{13}\S/.test(l)).map((l) => l.trim()) };
};
const hwItem = (id: string, extra: Record<string, unknown> = {}) => ({ id, text: `item ${id}`, topics: [], by: 't', created_at: Number(id), ...extra });

test('SessionStart — a homework item that is due leads the banner, marked; one not due yet keeps its place', async () => {
  homeworkItems = [hwItem('1'), hwItem('2', { due: '2099-01-01T00:00:00.000Z' }), hwItem('3', { due: '2020-01-01T00:00:00.000Z', claimed_by: 'erp-18' }), hwItem('4', { due: '2019-06-30T12:30:00.000Z' })];
  try {
    const { msg, hw } = await homeworkLines();
    expect(hw).toEqual(['⏰ #4 item 4 (DUE since 2019-06-30 12:30)', '⏰ #3 item 3 (DUE since 2020-01-01 00:00) (claimed by erp-18)', '#1 item 1', '… 1 more']);
    expect(msg).toContain('Homework   4 open');
  } finally { homeworkItems = []; }
});

test('SessionStart — homework without due times is listed exactly as before, and a done item is never marked due', async () => {
  homeworkItems = [hwItem('1'), hwItem('2', { claimed_by: 'x' }), hwItem('3', { due: '2020-01-01T00:00:00.000Z', done_at: 9 })];
  try {
    expect((await homeworkLines()).hw).toEqual(['#1 item 1', '#2 item 2 (claimed by x)', '#3 item 3']);
  } finally { homeworkItems = []; }
});

// 2026-10-13, an outside user: the Claude OAuth token was revoked, the provider chain emptied, and for 19.5 h every
// new session printed a healthy banner plus "(drains every 5s)" over a queue that could not drain.
test('SessionStart — a dead summarizer is flagged, and the queue line stops claiming it drains', async () => {
  statsExtra = {
    observations: { total: 5, queue_pending: 228, queue_processing: 0 },
    summarizer: {
      enabled: false,
      demoted: [{ provider: 'claude-oauth', reason: 'claude-oauth: HTTP 401 OAuth access token has been revoked.' }],
      last_error: 'claude-oauth: HTTP 401: OAuth access token has been revoked.',
    },
  };
  try {
    const { stdout, exitCode } = await runHook();
    expect(exitCode).toBe(0);
    const banner = JSON.parse(stdout).systemMessage as string;
    expect(banner).toContain('Summarizer DOWN');
    expect(banner).toContain('OAuth access token has been revoked');
    expect(banner).toContain('captain-memo restart');
    expect(banner).toContain('pending=228');
    expect(banner).toContain('stalled — summarizer down');
    expect(banner).not.toContain('drains every 5s');
  } finally { statsExtra = {}; }
});

test('SessionStart — a working summarizer keeps the banner exactly as before', async () => {
  statsExtra = {
    observations: { total: 5, queue_pending: 3, queue_processing: 1 },
    summarizer: { enabled: true, demoted: [], last_error: null },
  };
  try {
    const banner = JSON.parse((await runHook()).stdout).systemMessage as string;
    expect(banner).not.toContain('Summarizer DOWN');
    expect(banner).toContain('pending=3 processing=1 (drains every 5s)');
  } finally { statsExtra = {}; }
});

test('SessionStart — a worker that does not report the summarizer changes nothing', async () => {
  statsExtra = { observations: { total: 5, queue_pending: 2, queue_processing: 0 } };
  try {
    const banner = JSON.parse((await runHook()).stdout).systemMessage as string;
    expect(banner).not.toContain('Summarizer DOWN');
    expect(banner).toContain('(drains every 5s)');
  } finally { statsExtra = {}; }
});

// 2026-10-13: /health is derived from the writer thread's heartbeat and answers 503 once that is >5 s old, so a worker
// that is merely BUSY answered 503 too. SessionStart read that as down and restarted it (10:45:03 and 10:53:29 that day),
// and every cold start stalls the writer again. A PATH-first fake `systemctl` records any restart attempt, so a
// regression here cannot restart this machine's real worker.
test('SessionStart — /health 503 from a stalled writer (it carries `instance`) is a BUSY worker: no restart, busy banner', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'cm-fake-systemctl-'));
  const calls = join(bin, 'calls.log');
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 0\n`);
  chmodSync(join(bin, 'systemctl'), 0o755);
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return Response.json({ healthy: false, degraded: 'engine unresponsive 7312ms (on http /observation/enqueue)', instance: 4242 }, { status: 503 });
      }
      if (url.pathname === '/stats') return new Response('busy', { status: 503 });
      return new Response('nf', { status: 404 });
    },
  });
  try {
    const { stdout, exitCode } = await runHook({
      CAPTAIN_MEMO_WORKER_PORT: String(srv.port ?? 0),
      CAPTAIN_MEMO_DISABLE_SELF_HEAL: '0',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('active (stats snapshot slow to load)');
    expect(stdout).not.toContain('worker unreachable');
    expect(existsSync(calls)).toBe(false);   // systemctl was never asked to restart anything
  } finally {
    srv.stop();
    rmSync(bin, { recursive: true, force: true });
  }
});

test('SessionStart — /stats fails but /health OK: shows "active (stats slow)", never "unreachable", no self-heal', async () => {
  // A busy-but-ALIVE worker: /stats is unavailable/slow (503 here) while /health answers.
  // The hook must consult /health, conclude the worker is alive, skip the self-heal restart,
  // and show the non-alarming "active (stats snapshot slow to load)" banner — NOT "unreachable".
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return Response.json({ healthy: true });
      if (url.pathname === '/stats') return new Response('busy', { status: 503 });
      return new Response('nf', { status: 404 });
    },
  });
  try {
    // self-heal ENABLED (=0): if the /health gate were absent, the hook would try to restart
    // (and the busy banner would never appear). Its appearance proves the /health short-circuit fired.
    const { stdout, exitCode } = await runHook({
      CAPTAIN_MEMO_WORKER_PORT: String(srv.port ?? 0),
      CAPTAIN_MEMO_DISABLE_SELF_HEAL: '0',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('active (stats snapshot slow to load)');
    expect(stdout).not.toContain('worker unreachable');
  } finally {
    srv.stop();
  }
});

// CAPTAIN_MEMO_GREETING (#660): one opt-in line first in the banner. The hooks never read worker.env, so the worker
// reports its own value in /stats; the AI tool's environment, which the hook does read, wins over it.
const bannerOf = async (env: Record<string, string> = {}) => JSON.parse((await runHook(env)).stdout).systemMessage as string;

test('SessionStart — no greeting set: the banner is what it always was; set, it gains exactly one first line', async () => {
  const plain = await bannerOf();
  expect(plain.startsWith('\n\n⚓ Captain Memo')).toBe(true);
  const greeted = await bannerOf({ CAPTAIN_MEMO_GREETING: 'Samo Levski!' });
  expect(greeted).toBe(plain.replace('\n\n⚓', '\n\nSamo Levski!\n⚓'));
});

test('SessionStart — the worker\'s greeting (worker.env) shows, and the tool\'s own environment wins over it', async () => {
  statsExtra = { greeting: 'From the worker' };
  try {
    expect((await bannerOf()).split('\n')[2]).toBe('From the worker');
    expect((await bannerOf({ CAPTAIN_MEMO_GREETING: 'From the tool' })).split('\n')[2]).toBe('From the tool');
    expect((await bannerOf({ CAPTAIN_MEMO_GREETING: '' })).split('\n')[2]).toStartWith('⚓ Captain Memo');   // blanked for this tool
  } finally { statsExtra = {}; }
});

test('SessionStart — a hostile greeting is one clean line of at most 80 characters', async () => {
  statsExtra = { greeting: `Ahoy\n\x1b[31m\x1b]0;pwned\x07 ${'x'.repeat(200)}` };
  try {
    const banner = await bannerOf();
    expect(banner).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);   // no control character but the newlines between lines
    const line = banner.split('\n')[2]!;
    expect(line.startsWith('Ahoy [31m')).toBe(true);
    expect(line.length).toBe(80);
    expect(banner.split('\n')[3]).toStartWith('⚓ Captain Memo');
  } finally { statsExtra = {}; }
});

test('sanitizeGreeting — control characters out, 80 code points at most, nothing in means nothing out', () => {
  expect(sanitizeGreeting('  Samo Levski!  ')).toBe('Samo Levski!');
  expect(sanitizeGreeting('a\r\nb\tc\u0085d\u2028e')).toBe('a b c d e');
  expect(sanitizeGreeting('😀'.repeat(100))).toBe('😀'.repeat(80));   // never half an emoji
  expect(sanitizeGreeting('y'.repeat(79) + 'é!!!')).toBe('y'.repeat(79) + 'é');
  for (const none of [undefined, '', '   ', '\n\x1b\t', 42, null, {}]) expect(sanitizeGreeting(none)).toBe('');
});

// #913(4): the prompt hook cannot announce a refused or rolled-back check and has used the hourly slot, so it leaves the result
// (`.auto-update-unshown`) and the stamp fresh; SessionStart's own pass is then not due, and announces the left result, once.
test('SessionStart — with auto-update on, a check the prompt hook found blocked or rolled back is announced once, though its own pass is not due', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cm-autoupd-unshown-'));
  const left = join(dataDir, '.auto-update-unshown');
  const env = { CAPTAIN_MEMO_DATA_DIR: dataDir, GIT_DIR: join(dataDir, 'no-such-git-dir') };   // git cannot touch this checkout
  const banner = async (extra: Record<string, string> = { CAPTAIN_MEMO_AUTO_UPDATE: '1' }): Promise<string> => JSON.parse((await runHook({ ...env, ...extra })).stdout).systemMessage as string;
  try {
    writeFileSync(join(dataDir, '.last-update-check'), `${new Date().toISOString()} delay_ms=3600000 failures=0\n`);   // the slot is used
    const res = { ok: false, from: VERSION, code: 'dirty_tree', reason: 'working tree not clean — refusing to auto-update over local edits' };
    writeFileSync(left, JSON.stringify({ kind: 'blocked', res }));
    expect(await banner({ CAPTAIN_MEMO_AUTO_UPDATE: '' })).not.toContain('BLOCKED');      // not opted in: nothing said, nothing consumed
    expect(existsSync(left)).toBe(true);
    const first = await banner();
    expect(first).toContain('auto-update is BLOCKED');
    expect(first).toContain('working tree not clean');
    expect(first).toContain(`stays on v${VERSION}`);
    expect(existsSync(left)).toBe(false);
    expect(await banner()).not.toContain('BLOCKED');                                       // once

    writeFileSync(left, JSON.stringify({ kind: 'rolled-back', rolled: true, res: { ok: true, from: VERSION, to: '99.0.0' } }));
    const rolled = await banner();
    expect(rolled).toContain('auto-update to v99.0.0 FAILED to start');
    expect(rolled).toContain(`rolled back to v${VERSION}`);

    writeFileSync(left, JSON.stringify({ kind: 'blocked', res: { ...res, from: '0.0.1' } }));   // written by another version: the checkout moved on
    expect(await banner()).not.toContain('BLOCKED');
    expect(existsSync(left)).toBe(false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
