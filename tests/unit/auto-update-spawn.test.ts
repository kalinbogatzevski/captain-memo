import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { DATA_DIR } from '../../src/shared/paths.ts';
import { startPromptUpdate, applyPromptUpdate, spawnDetached, UPDATE_STAMP, UPDATE_SPAWN_LOCK, UNSHOWN_OUTCOME_FILE, type AutoUpdateOutcome } from '../../src/hooks/auto-update.ts';
import { main as updateApply } from '../../src/hooks/update-apply.ts';
import { hookEntryPath } from '../../src/hooks/shared.ts';
import { formatUpdateStamp } from '../../src/worker/self-updater.ts';

// #950: the UserPromptSubmit hook no longer runs the opt-in self-update in-line (Claude Code cuts the hook at 30 s and kills its
// tree): on Linux/macOS it does a cheap due-check and spawns `<dispatcher entry> UpdateApply` DETACHED. Here: the spawner with an
// injected platform / spawn / clock / pass, the UpdateApply handler, and ONE real process pair for the detach itself. The hook as
// a whole (real processes through bin/captain-memo-hook.ts) is in tests/hooks/user-prompt-submit.test.ts.
// DATA_DIR is the preload's scratch home (tests/preload.ts), so the stamp and locks below are throwaway.
const ENTRY = '/plugin/dist/captain-memo-hook.js';
const BUN = '/opt/bun';
const HOOK_LOG = join(homedir(), '.captain-memo', 'logs', 'hook.log');
const NO_OUTCOME = async (): Promise<AutoUpdateOutcome> => ({ kind: 'none' });

let spawned: string[][];
let passArgs: unknown[];
const spawn = (cmd: string[]): void => { spawned.push(cmd); };
const pass = async (o: unknown): Promise<AutoUpdateOutcome> => { passArgs.push(o); return { kind: 'none' }; };
const due = (): void => { writeFileSync(UPDATE_STAMP, formatUpdateStamp(new Date('2020-01-01'), 3_600_000, 0)); utimesSync(UPDATE_STAMP, new Date('2020-01-01'), new Date('2020-01-01')); };
const hookLog = (): string => { try { return readFileSync(HOOK_LOG, 'utf-8'); } catch { return ''; } };
/** How many log lines say `text` (the stack under each line repeats the message, so count the `[Event] Error: ` heads). */
const logged = (text: string): number => hookLog().split(`[UserPromptSubmit] Error: ${text}`).length - 1;
const savedOptIn = process.env.CAPTAIN_MEMO_AUTO_UPDATE;

beforeEach(() => {
  spawned = []; passArgs = [];
  mkdirSync(DATA_DIR, { recursive: true });
  for (const f of [UPDATE_STAMP, UPDATE_SPAWN_LOCK, UNSHOWN_OUTCOME_FILE]) rmSync(f, { force: true });
});
afterEach(() => { if (savedOptIn === undefined) delete process.env.CAPTAIN_MEMO_AUTO_UPDATE; else process.env.CAPTAIN_MEMO_AUTO_UPDATE = savedOptIn; });

test('posix, check due: one child re-runs the dispatcher entry with UpdateApply, and the pass does not run in this process', async () => {
  due();
  expect(await startPromptUpdate({ platform: 'linux', entry: ENTRY, execPath: BUN, spawn, pass })).toBe('spawned');
  expect(spawned).toEqual([[BUN, ENTRY, 'UpdateApply']]);
  expect(passArgs).toEqual([]);
  expect(existsSync(UPDATE_SPAWN_LOCK)).toBe(true);
});

test('win32: the pass runs in-line with its old arguments, nothing is spawned, no spawn lock is taken', async () => {
  due();
  expect(await startPromptUpdate({ platform: 'win32', entry: ENTRY, execPath: BUN, spawn, pass })).toBe('inline');
  expect(passArgs).toEqual([{ event: 'UserPromptSubmit', networkTimeoutMs: 8_000 }]);
  expect(spawned).toEqual([]);
  expect(existsSync(UPDATE_SPAWN_LOCK)).toBe(false);
});

test('posix, no check due: nothing is spawned and no lock is taken', async () => {
  writeFileSync(UPDATE_STAMP, formatUpdateStamp(new Date(), 3_600_000, 0));
  expect(await startPromptUpdate({ platform: 'darwin', entry: ENTRY, execPath: BUN, spawn, pass })).toBe('not-due');
  expect(spawned).toEqual([]);
  expect(existsSync(UPDATE_SPAWN_LOCK)).toBe(false);
});

test('posix, hook not launched through the dispatcher entry: nothing is spawned, one line is logged, no lock is taken', async () => {
  due();
  const before = logged('auto-update: not started, this hook was not launched through the dispatcher entry');
  expect(await startPromptUpdate({ platform: 'linux', entry: null, execPath: BUN, spawn, pass })).toBe('no-entry');
  expect(spawned).toEqual([]);
  expect(existsSync(UPDATE_SPAWN_LOCK)).toBe(false);
  expect(logged('auto-update: not started, this hook was not launched through the dispatcher entry')).toBe(before + 1);
});

test('a failing spawn does not throw, is logged once, and the hook carries on', async () => {
  due();
  const boom = (): void => { throw new Error('spawn ENOENT: no such bun'); };
  const before = logged('auto-update: could not start the detached apply: spawn ENOENT: no such bun');
  await expect(startPromptUpdate({ platform: 'linux', entry: ENTRY, execPath: BUN, spawn: boom, pass })).resolves.toBe('spawn-failed');
  expect(logged('auto-update: could not start the detached apply: spawn ENOENT: no such bun')).toBe(before + 1);
});

test('two prompts in quick succession spawn once; the spawn lock lapses after its TTL so a later prompt can try again', async () => {
  due();
  const t = Date.now();
  expect(await startPromptUpdate({ platform: 'linux', entry: ENTRY, execPath: BUN, spawn, pass, now: t })).toBe('spawned');
  expect(await startPromptUpdate({ platform: 'linux', entry: ENTRY, execPath: BUN, spawn, pass, now: t + 500 })).toBe('in-flight');
  expect(spawned.length).toBe(1);
  expect(await startPromptUpdate({ platform: 'linux', entry: ENTRY, execPath: BUN, spawn, pass, now: t + 21_000 })).toBe('spawned');   // the first child never stamped: it died, or deferred for a live session
  expect(spawned.length).toBe(2);
});

test('hookEntryPath: the dispatcher bundle and bin entry count, a handler module run directly does not', () => {
  expect(hookEntryPath('/home/u/.claude/plugins/x/dist/captain-memo-hook.js')).toBe(resolve('/home/u/.claude/plugins/x/dist/captain-memo-hook.js'));
  expect(hookEntryPath('/repo/bin/captain-memo-hook.ts')).toBe(resolve('/repo/bin/captain-memo-hook.ts'));
  expect(hookEntryPath('/repo/bin/captain-memo-hook')).toBe(resolve('/repo/bin/captain-memo-hook'));
  expect(hookEntryPath('/repo/src/hooks/user-prompt-submit.ts')).toBeNull();
  expect(hookEntryPath('/repo/dist/not-captain-memo-hook-x.js')).toBeNull();
  expect(hookEntryPath(undefined)).toBeNull();
});

test('UpdateApply: opted in, it runs the pass once with the prompt path\'s arguments, tagged UpdateApply', async () => {
  process.env.CAPTAIN_MEMO_AUTO_UPDATE = '1';
  await updateApply({ pass });
  expect(passArgs).toEqual([{ event: 'UpdateApply', networkTimeoutMs: 8_000 }]);
});

test('UpdateApply: not opted in, it does nothing', async () => {
  process.env.CAPTAIN_MEMO_AUTO_UPDATE = '';
  await updateApply({ pass });
  expect(passArgs).toEqual([]);
});

test('UpdateApply: a pass that never ends is cut by the backstop, and so is a process that outlives a pass that ended', async () => {
  process.env.CAPTAIN_MEMO_AUTO_UPDATE = '1';
  const exits: number[] = [];
  void updateApply({ pass: () => new Promise<AutoUpdateOutcome>(() => {}), backstopMs: 30, exit: (c) => { exits.push(c); } });
  await Bun.sleep(150);
  expect(exits).toEqual([0]);
  exits.length = 0;
  await updateApply({ pass: NO_OUTCOME, backstopMs: 60, exit: (c) => { exits.push(c); } });
  await Bun.sleep(150);
  expect(exits).toEqual([0]);   // the pass ended and something kept the process up: still cut
});

test('the prompt path\'s result handling: a blocked pass is left for SessionStart, an updated one clears it and is logged', async () => {
  const blocked: AutoUpdateOutcome = { kind: 'blocked', res: { ok: false, from: '1.0.0', code: 'dirty_tree', reason: 'x' } };
  await applyPromptUpdate('UpdateApply', async () => blocked);
  expect(JSON.parse(readFileSync(UNSHOWN_OUTCOME_FILE, 'utf-8'))).toMatchObject({ kind: 'blocked', res: { code: 'dirty_tree' } });
  await applyPromptUpdate('UpdateApply', async () => ({ kind: 'updated', res: { ok: true, from: '1.0.0', to: '1.0.1' } }));
  expect(existsSync(UNSHOWN_OUTCOME_FILE)).toBe(false);
  expect(hookLog()).toContain('[UpdateApply] Error: auto-updated v1.0.0 -> v1.0.1');
});

// ONE real process pair. The child waits for a `go` file the test writes only AFTER the parent has exited, so "it outlived its
// parent" needs no timing assumption; it polls for at most 8 s, so a failed run leaks nothing. Linux only (/proc).
const live = process.platform === 'linux';
let fixture: Promise<{ parentExit: number; aliveAfterParent: boolean; doneBeforeGo: boolean; sid: number | null; fds: (string | null)[]; doneAfterGo: boolean }> | null = null;
const fixtureDir = mkdtempSync(join(tmpdir(), 'cm-detached-'));
let childPid = 0;
function detachedFixture(): NonNullable<typeof fixture> {
  return fixture ??= (async () => {
    const f = (n: string): string => join(fixtureDir, n);
    const childCode = `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(f('pid'))}, String(process.pid));
      for (let i = 0; i < 160 && !fs.existsSync(${JSON.stringify(f('go'))}); i++) await Bun.sleep(50);
      if (fs.existsSync(${JSON.stringify(f('go'))})) fs.writeFileSync(${JSON.stringify(f('done'))}, 'x');`;
    writeFileSync(f('parent.ts'), `import { spawnDetached } from ${JSON.stringify(join(import.meta.dir, '../../src/hooks/auto-update.ts'))};\nspawnDetached([process.execPath, '-e', ${JSON.stringify(childCode)}]);\n`);
    // The parent's own stdio are PIPES (never read), so a child that inherited them would show up as `pipe:[..]` below, not /dev/null.
    const parent = Bun.spawn(['timeout', '-k', '5', '30', process.execPath, f('parent.ts')], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: process.env as Record<string, string> });
    const parentExit = await parent.exited;
    for (let i = 0; i < 200 && !existsSync(f('pid')); i++) await Bun.sleep(25);
    childPid = existsSync(f('pid')) ? Number(readFileSync(f('pid'), 'utf-8')) : 0;
    const read = <T>(fn: () => T): T | null => { try { return fn(); } catch { return null; } };
    const aliveAfterParent = childPid > 0 && read(() => process.kill(childPid, 0)) === true;
    const stat = read(() => readFileSync(`/proc/${childPid}/stat`, 'utf-8'));
    const sid = stat ? Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]) : null;   // fields after the comm: state ppid pgrp session
    const fds = [0, 1, 2].map((n) => read(() => readlinkSync(`/proc/${childPid}/fd/${n}`)));
    const doneBeforeGo = existsSync(f('done'));
    writeFileSync(f('go'), '');
    for (let i = 0; i < 200 && !existsSync(f('done')); i++) await Bun.sleep(25);
    return { parentExit, aliveAfterParent, doneBeforeGo, sid, fds, doneAfterGo: existsSync(f('done')) };
  })();
}
afterAll(() => {
  if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone: the normal case */ } }
  rmSync(fixtureDir, { recursive: true, force: true });
});

test.skipIf(!live)('spawnDetached: the child outlives the parent that exited, and then finishes', async () => {
  const r = await detachedFixture();
  expect(r.parentExit).toBe(0);
  expect(r.aliveAfterParent).toBe(true);
  expect(r.doneBeforeGo).toBe(false);
  expect(r.doneAfterGo).toBe(true);
});

test.skipIf(!live)('spawnDetached: the child leads its own session (setsid)', async () => {
  const r = await detachedFixture();
  expect(childPid).toBeGreaterThan(0);
  expect(r.sid).toBe(childPid);
});

test.skipIf(!live)('spawnDetached: the child holds none of its parent\'s stdio (Claude Code waits for, or refuses, a hook whose child keeps the pipes)', async () => {
  const r = await detachedFixture();
  expect(r.fds).toEqual(['/dev/null', '/dev/null', '/dev/null']);
});
