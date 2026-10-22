import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { spawn } from 'bun';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { homeworkWaitMs } from '../../src/hooks/user-prompt-submit.ts';
import { parseUpdateStamp } from '../../src/worker/self-updater.ts';
import { BOOT_SLACK_MS } from '../support/worker-boot.ts';
import { makeDirtyCloneBehindOrigin } from '../support/dirty-clone-behind-origin.ts';

const FIXTURE = readFileSync(
  join(import.meta.dir, '../fixtures/hooks/user-prompt-submit.input.json'),
  'utf-8',
);
const HOOK_PATH = join(import.meta.dir, '../../src/hooks/user-prompt-submit.ts');

let server: ReturnType<typeof Bun.serve>;
let port = 0;
let lastReceived: unknown = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/homework/add') {
        lastReceived = await req.json();
        return Response.json({ item: { id: '7', text: (lastReceived as { text: string }).text, topics: [], by: 'hook', created_at: 1 }, open: 3 });
      }
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
  port = server.port ?? 0;
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
      CAPTAIN_MEMO_WORKER_PORT: String(port),
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
  const { stdout, exitCode } = await runHook(FIXTURE, { CAPTAIN_MEMO_WORKER_PORT: '1', CAPTAIN_MEMO_DISABLE_SELF_HEAL: '1' });
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain('<memory-context');
  expect(stdout).toContain('How do I run the worker');
});

test('UserPromptSubmit — respects CAPTAIN_MEMO_HOOK_TIMEOUT_MS', async () => {
  const start = Date.now();
  const { stdout, exitCode } = await runHook(FIXTURE, {
    CAPTAIN_MEMO_WORKER_PORT: '1',
    CAPTAIN_MEMO_HOOK_TIMEOUT_MS: '50',
    CAPTAIN_MEMO_DISABLE_SELF_HEAL: '1',
  });
  const elapsed = Date.now() - start;
  expect(exitCode).toBe(0);
  expect(elapsed).toBeLessThan(800);
  expect(stdout).toContain('How do I run the worker');
});

// The opt-in self-update also runs from this hook (a session kept open for days never reaches SessionStart again). #950: on
// Linux/macOS the hook only spawns it, DETACHED, as `<dispatcher entry> UpdateApply` (Claude Code cuts the hook at 30 s and kills
// its tree), so these tests run the hook through the dispatcher entry, as Claude Code does (the spawn re-runs that same file).
// `.auto-update-spawn.lock` is taken by the hook BEFORE it spawns and exits with it, so it is the synchronous witness that a child
// was started; what the child does comes later and is polled for.
const ENTRY = join(import.meta.dir, '../../bin/captain-memo-hook.ts');
const SPAWN_LOCK = '.auto-update-spawn.lock';
// win32 keeps the pass in-line (nothing is spawned, so no spawn lock): the tests that need a child are POSIX-only.
const posix = process.platform !== 'win32';

async function runEntry(event: string, input: string, env: Record<string, string> = {}): Promise<{ stdout: string; exitCode: number; ms: number }> {
  const t0 = performance.now();
  const proc = spawn({ cmd: ['bun', ENTRY, event], stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CAPTAIN_MEMO_WORKER_PORT: String(port), ...env } });
  proc.stdin.write(input); proc.stdin.end();
  // Both pipes are read to EOF: a child that kept either one open would hold this up until it exited.
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { stdout, exitCode: await proc.exited, ms: performance.now() - t0 };
}
async function waitFor(cond: () => boolean, ms = 20_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end && !cond();) await Bun.sleep(40);
  return cond();
}
/** Make the check due again, as a stamp from 2020 does. Returns the stamp's text. */
function dueStamp(dataDir: string): string {
  const stamp = join(dataDir, '.last-update-check');
  writeFileSync(stamp, '2020-01-01T00:00:00.000Z delay_ms=3600000 failures=0\n'); utimesSync(stamp, new Date('2020-01-01'), new Date('2020-01-01'));
  return readFileSync(stamp, 'utf-8');
}
// GIT_DIR points nowhere, so a pass that does run finds "not a git checkout" and changes nothing but the stamp it rewrites.
const updateEnv = (dataDir: string): Record<string, string> => ({ CAPTAIN_MEMO_AUTO_UPDATE: '1', CAPTAIN_MEMO_DATA_DIR: dataDir, GIT_DIR: join(dataDir, 'no-such-git-dir'), CAPTAIN_MEMO_DISABLE_SELF_HEAL: '1' });
/** The child has finished its pass: the stamp is rewritten and the pass released `.auto-update.lock`. */
const passDone = (dataDir: string, before: string): boolean => readFileSync(join(dataDir, '.last-update-check'), 'utf-8') !== before && !existsSync(join(dataDir, '.auto-update.lock'));

test('UserPromptSubmit — with CAPTAIN_MEMO_AUTO_UPDATE=1 and no check due, the prompt is unchanged, nothing is fetched and no child is started', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'captain-memo-hook-autoupdate-'));
  const stamp = join(dataDir, '.last-update-check');
  writeFileSync(stamp, `${new Date().toISOString()} delay_ms=3600000 failures=0\n`);
  const before = readFileSync(stamp, 'utf-8');
  const { stdout, exitCode } = await runEntry('UserPromptSubmit', FIXTURE, updateEnv(dataDir));
  expect(exitCode).toBe(0);
  expect(stdout).toContain('<memory-context');
  expect(stdout).toContain('How do I run the worker');
  expect(readFileSync(stamp, 'utf-8')).toBe(before);
  expect(existsSync(join(dataDir, SPAWN_LOCK))).toBe(false);
  rmSync(dataDir, { recursive: true, force: true });
});

test('UserPromptSubmit — a due check starts a detached child that makes it (stamp rewritten), but none while the worker is down', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'captain-memo-hook-autoupdate-due-'));
  const stamp = join(dataDir, '.last-update-check');
  const env = updateEnv(dataDir);
  try {
    let before = dueStamp(dataDir);
    const r = await runEntry('UserPromptSubmit', FIXTURE, env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('<memory-context');                             // the prompt is served as ever
    if (posix) expect(existsSync(join(dataDir, SPAWN_LOCK))).toBe(true);       // a child was started...
    expect(await waitFor(() => passDone(dataDir, before))).toBe(true);         // ...and it ran the pass: the stamp is rewritten
    expect(parseUpdateStamp(readFileSync(stamp, 'utf-8')).failures).toBe(0);
    rmSync(join(dataDir, SPAWN_LOCK), { force: true });
    before = dueStamp(dataDir);
    expect((await runEntry('UserPromptSubmit', FIXTURE, { ...env, CAPTAIN_MEMO_WORKER_PORT: '1' })).exitCode).toBe(0);
    expect(existsSync(join(dataDir, SPAWN_LOCK))).toBe(false);                 // worker down: no child, left for SessionStart / the next prompt
    expect(readFileSync(stamp, 'utf-8')).toBe(before);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

// The point of #950: the hook does not wait for the apply. A PATH-first `git` that takes 1.2 s per call and fails makes the child's
// pass last at least 2.4 s (two git calls before it gives up), so it cannot be done when the hook exits. Both of the hook's pipes were
// read to EOF in runEntry: a child that held either would have kept this open until it ended.
test.skipIf(!posix)('UserPromptSubmit — the hook exits before the child it started has finished its check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'captain-memo-hook-autoupdate-async-'));
  try {
    const dataDir = join(root, 'data'); mkdirSync(dataDir);
    const fakeBin = join(root, 'bin'); mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'git'), '#!/bin/sh\nsleep 1.2\nexit 1\n', { mode: 0o755 });
    const before = dueStamp(dataDir);
    const r = await runEntry('UserPromptSubmit', FIXTURE, { ...updateEnv(dataDir), PATH: `${fakeBin}:${process.env.PATH}` });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(dataDir, SPAWN_LOCK))).toBe(true);
    expect(passDone(dataDir, before)).toBe(false);                             // the child is still inside its first slow git call
    expect(await waitFor(() => passDone(dataDir, before))).toBe(true);         // and it does finish, on its own, after the hook is gone
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('UpdateApply — with closed stdin it runs the pass once and exits', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'captain-memo-hook-autoupdate-applyonce-'));
  try {
    const before = dueStamp(dataDir);
    const r = await runEntry('UpdateApply', '', updateEnv(dataDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');                                                 // the child has no stdout to speak of
    const after = readFileSync(join(dataDir, '.last-update-check'), 'utf-8');
    expect(after).not.toBe(before);                                            // the pass ran and used the slot...
    expect(parseUpdateStamp(after).failures).toBe(0);
    expect(existsSync(join(dataDir, '.auto-update.lock'))).toBe(false);        // ...and finished: its exit is the end of the pass
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('UpdateApply — without the opt-in it does nothing, whatever is due', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'captain-memo-hook-autoupdate-applyoff-'));
  try {
    const before = dueStamp(dataDir);
    expect((await runEntry('UpdateApply', '', { ...updateEnv(dataDir), CAPTAIN_MEMO_AUTO_UPDATE: '' })).exitCode).toBe(0);
    expect(readFileSync(join(dataDir, '.last-update-check'), 'utf-8')).toBe(before);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('UserPromptSubmit — a due check is not made without the opt-in', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'captain-memo-hook-autoupdate-off-'));
  try {
    const before = dueStamp(dataDir);
    expect((await runEntry('UserPromptSubmit', FIXTURE, { ...updateEnv(dataDir), CAPTAIN_MEMO_AUTO_UPDATE: '' })).exitCode).toBe(0);
    expect(existsSync(join(dataDir, SPAWN_LOCK))).toBe(false);
    expect(readFileSync(join(dataDir, '.last-update-check'), 'utf-8')).toBe(before);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

// #913(4): the child's stdout is nobody's, and the check it makes uses the hourly slot, so a refused check (REAL git: a newer tag
// on a local origin, a dirty clone) is left for the next SessionStart to announce. Nothing is printed.
test('UpdateApply — a due check refused by the dirty-tree gate uses the slot, prints nothing, and is left for SessionStart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'captain-memo-hook-autoupdate-unshown-'));
  try {
    const { env: gitEnv, head, git } = makeDirtyCloneBehindOrigin(root);
    const dataDir = join(root, 'data'); mkdirSync(dataDir);
    const stamp = join(dataDir, '.last-update-check');
    writeFileSync(stamp, '2020-01-01T00:00:00.000Z delay_ms=3600000 failures=0\n'); utimesSync(stamp, new Date('2020-01-01'), new Date('2020-01-01'));
    const before = readFileSync(stamp, 'utf-8');
    const r = await runEntry('UpdateApply', '', { ...gitEnv, CAPTAIN_MEMO_AUTO_UPDATE: '1', CAPTAIN_MEMO_DATA_DIR: dataDir, CAPTAIN_MEMO_DISABLE_SELF_HEAL: '1' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(readFileSync(stamp, 'utf-8')).not.toBe(before);                     // the pass ran and used the slot
    expect(git(join(root, 'work'), 'rev-parse', 'HEAD')).toBe(head);          // nothing was applied
    expect(JSON.parse(readFileSync(join(dataDir, '.auto-update-unshown'), 'utf-8'))).toMatchObject({ kind: 'blocked', res: { code: 'dirty_tree' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Behaviour behind the source check below: a native host (Codex, Gemini, Kimi) kills this hook at 5 s, a check takes longer.
test('UserPromptSubmit — a due check is made for Claude Code but not for a native host (Codex), though both are opted in and healthy', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'captain-memo-hook-autoupdate-native-'));
  const stamp = join(dataDir, '.last-update-check');
  const env = updateEnv(dataDir);
  try {
    let before = dueStamp(dataDir);
    const claude = await runEntry('UserPromptSubmit', FIXTURE, env);
    expect(claude.exitCode).toBe(0);
    if (posix) expect(existsSync(join(dataDir, SPAWN_LOCK))).toBe(true);       // control: this entry does start the check...
    expect(await waitFor(() => passDone(dataDir, before))).toBe(true);         // ...and it is made
    rmSync(join(dataDir, SPAWN_LOCK), { force: true });
    before = dueStamp(dataDir);
    const codex = await runEntry('CodexUserPromptSubmit', FIXTURE, env);
    expect(codex.exitCode).toBe(0);
    expect(codex.stdout).toContain('stub');                                    // the worker answered: the gate that stopped the check is the host timeout
    expect(existsSync(join(dataDir, SPAWN_LOCK))).toBe(false);
    expect(readFileSync(stamp, 'utf-8')).toBe(before);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('UserPromptSubmit — the self-update step runs only for an opted-in, healthy, Claude Code (no host timeout) prompt', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/hooks/user-prompt-submit.ts'), 'utf8');
  const at = src.indexOf("await import('./auto-update.ts')");
  expect(at).toBeGreaterThan(0);
  const gate = src.slice(src.lastIndexOf('if (', at), at);
  expect(gate).toContain('result.ok');
  expect(gate).toContain("process.env.CAPTAIN_MEMO_AUTO_UPDATE === '1'");
  expect(gate).toContain('options.hostTimeoutMs === undefined');
  expect(src.slice(at)).toContain('startPromptUpdate()');                     // the hook starts the child; it no longer runs the pass itself
  expect(src.slice(at)).not.toContain('runAutoUpdatePass');
  expect(src.indexOf('writeStdout(prompt)')).toBeLessThan(at);   // the prompt is written before the check starts (the host still waits for the hook to exit)
});

test('UserPromptSubmit — empty stdin is tolerated', async () => {
  const { exitCode } = await runHook('');
  expect(exitCode).toBe(0);
});

test('UserPromptSubmit — envelope conforms to spec §3 template', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'captain-memo-hook-contract-'));
  const memDir = join(workDir, 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'feedback_no_null.md'),
    `---\ntype: feedback\ndescription: No NULL\n---\nNo NULL — use 0 / "" sentinels.`,
  );

  const worker: WorkerHandle = await startWorker({
    port: 0,
    projectId: 'contract-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    watchPaths: [join(memDir, '*.md')],
    watchChannel: 'memory',
    hookBudgetTokens: 2000,
  });
  const workerPort = worker.port;
  // Wait until the watcher has indexed the memory file (a fixed 500 ms sleep lost that race under load,
  // and the envelope then came back with no local-memory section).
  for (const end = Date.now() + 10_000; Date.now() < end; await Bun.sleep(100)) {
    const r = await fetch(`http://127.0.0.1:${workerPort}/search/all`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'NULL sentinels', top_k: 5 }),
    });
    if (((await r.json()) as { results?: Array<{ channel: string }> }).results?.some(h => h.channel === 'memory')) break;
  }

  try {
    const fixture = JSON.stringify({
      ...JSON.parse(FIXTURE),
      prompt: 'when do I use NULL in this codebase?',
    });
    const proc = spawn({
      cmd: ['bun', HOOK_PATH],
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        CAPTAIN_MEMO_WORKER_PORT: String(workerPort),
        // Bun cold-start + fetch can exceed 250ms on the dev box; loosen for
        // this specific contract test (production cap is unchanged).
        CAPTAIN_MEMO_HOOK_TIMEOUT_MS: '2000',
      },
    });
    proc.stdin.write(fixture);
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // Spec §3 — envelope template assertions.
    expect(stdout).toMatch(/<memory-context retrieved-by="captain-memo"/);
    expect(stdout).toMatch(/project="contract-test"/);
    expect(stdout).toMatch(/k="\d+"/);
    expect(stdout).toMatch(/budget-tokens="2000"/);
    expect(stdout).toMatch(/The user did NOT see this/);
    expect(stdout).toMatch(/<\/memory-context>/);
    expect(stdout).toMatch(/## Local memory \(\d+ results\)/);
    expect(stdout).toMatch(/\[full: get_full\("memory:/);
  } finally {
    await worker.stop();
    rmSync(workDir, { recursive: true, force: true });
  }
}, 20_000 + BOOT_SLACK_MS);   // boots a real worker (its own timeout, so it adds the Windows boot slack) + spawns the hook: ~0.6 s; the 5.3 s once measured here was the boot digest of the REAL recall-audit.jsonl (tests/preload.ts)

test('UserPromptSubmit — `idea:` files homework instead of recalling, and tells the model in one line', async () => {
  const input = JSON.stringify({ session_id: 's-1', cwd: '/tmp/p', prompt: 'idea: let the banner show what is parked' });
  const res = await runHook(input);
  expect(res.exitCode).toBe(0);
  expect((lastReceived as { text: string }).text).toBe('let the banner show what is parked');   // the prefix is stripped
  expect((lastReceived as { by: string }).by).toBe('s-1');                                       // the session is the filer
  expect(res.stdout).toContain('📝 Filed as homework #7');
  expect(res.stdout).toContain('(3 open)');
  expect(res.stdout).not.toContain('<memory-context');                                           // no recall on an aside
  expect(res.stdout.trim().endsWith('idea: let the banner show what is parked')).toBe(true);     // the prompt still goes through
});

test('UserPromptSubmit — a plain prompt is not homework', async () => {
  const input = JSON.stringify({ session_id: 's-1', cwd: '/tmp/p', prompt: 'I had an idea: what does this function do?' });
  const res = await runHook(input);
  expect(res.stdout).toContain('<memory-context');
  expect(res.stdout).not.toContain('Filed as homework');
});

test('homework wait: 6 s under Claude Code, the rest of the host budget under a native CLI', () => {
  expect(homeworkWaitMs(undefined, 9_999)).toBe(6_000);   // Claude Code: its own hook timeout is 60 s
  expect(homeworkWaitMs(5_000, 600)).toBe(3_650);          // 5 s host, 0.6 s cold start, 0.75 s exit margin
  expect(homeworkWaitMs(5_000, 4_900)).toBe(0);            // budget already spent: answer at once
  expect(homeworkWaitMs(60_000, 100)).toBe(6_000);         // a roomy host never waits longer than Claude does
});
