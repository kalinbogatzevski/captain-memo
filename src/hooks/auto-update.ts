// src/hooks/auto-update.ts — one pass of the OPT-IN git self-update (CAPTAIN_MEMO_AUTO_UPDATE=1), shared by the
// SessionStart and UserPromptSubmit hooks. Both go through the same `.last-update-check` stamp and the same
// `.auto-update.lock`, so they make ONE check per interval between them, however many sessions are open.
//
// Why a hook and not a worker timer: the updater is synchronous (a check is two network round trips, a `bun install`
// can run minutes) and would stall the worker's event loop; and only a process OUTSIDE the worker survives its restart
// to confirm the new code boots and roll the checkout back if it does not.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA_DIR, DEFAULT_WORKER_PORT } from '../shared/paths.ts';
import { VERSION } from '../shared/version.ts';
import { compareSemver } from '../shared/self-update.ts';
import { runAutoUpdate, rollbackTo, isUpdateCheckDue, updateCheckIntervalFromEnv, nextUpdateCheckDelayMs, formatUpdateStamp, parseUpdateStamp, type ApplyResult, type UpdaterPort } from '../worker/self-updater.ts';
import { markTransition, clearTransition } from '../shared/worker-transition.ts';
import { restartWorker } from '../shared/worker-control.ts';
import { acquireHealLock, releaseHealLock } from '../shared/worker-heal-lock.ts';
import { probeHealthOnce, readWorkerInstance } from '../shared/worker-health-probe.ts';
import { hookEntryPath, logHookError } from './shared.ts';

export const AUTO_UPDATE_LOCK = join(DATA_DIR, '.auto-update.lock');
export const UPDATE_STAMP = join(DATA_DIR, '.last-update-check');
/** The release that failed to boot and was rolled back. Checks ignore it, and anything older, until a newer one is published. */
export const SKIPPED_RELEASE_FILE = join(DATA_DIR, '.auto-update-skip');

/** Read one string field from <dir>/package.json, or null. Used by the auto-updater's port to read
 *  the post-update version and to confirm the resolved checkout is actually captain-memo. */
function readPkgField(dir: string, field: 'version' | 'name'): string | null {
  try { return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as Record<string, string>)[field] ?? null; }
  catch { return null; }
}

/** The deadline for one git call: what the caller asked for (default 20 s), but a network call (fetch, ls-remote) is
 *  also held to `networkCapMs` when given. Only the network calls: killing a `git merge` midway leaves .git/index.lock. */
export function gitTimeoutFor(argv: string[], requestedMs: number | undefined, networkCapMs: number | undefined): number {
  const network = argv[1] === 'fetch' || argv[1] === 'ls-remote';
  return Math.min(requestedMs ?? 20_000, network ? networkCapMs ?? Infinity : Infinity);
}

export type AutoUpdateOutcome =
  | { kind: 'none' }                                                                          // not due, lock held, already current, or the pass failed open
  | { kind: 'blocked'; res: ApplyResult }                                                     // a safety gate refused: dirty tree, detached HEAD, a fast-forward that does not apply
  | { kind: 'updated'; res: ApplyResult & { installFailed?: boolean } }                       // new code is up and the worker answers on it
  | { kind: 'rolled-back'; res: ApplyResult & { installFailed?: boolean }; rolled: boolean }; // the new code did not boot; `rolled` says whether the checkout went back

export interface AutoUpdateOptions {
  /** Hook name, for the log lines. */
  event: string;
  /** Called once the new worker process is up, for a caller that wants to refresh what it knows about the worker.
   *  Its result is not what decides whether the update booted. */
  afterBoot?: () => Promise<unknown>;
  /** Hold fetch and ls-remote to this many ms (default 20 s). A hook the user is waiting on passes less. */
  networkTimeoutMs?: number;
  /** Test seams: the git port, the running version, the worker restart, and how a new worker process is recognised. */
  port?: UpdaterPort;
  version?: string;
  restart?: (graceful: boolean) => Promise<void>;
  readInstance?: (port: number) => Promise<number | null>;
  probe?: (port: number) => Promise<boolean>;
  bootWait?: { waitMs: number; pollMs: number };
}

/** Wait for a NEW worker process: one whose instance stamp differs from `before` (the process that was running when the
 *  restart began; null when none was). This is what `captain-memo restart` accepts as "it came back". It is NOT "/stats
 *  answers": during the startup indexing burst of a large corpus /stats is a 503 for longer than any sane wait (field
 *  2026-09-19, 34k chunks), and judging by it rolled a good update back. With no worker before, any /health 200 will do. */
async function awaitNewProcess(
  before: number | null, port: number, read: (port: number) => Promise<number | null>, o: Pick<AutoUpdateOptions, 'probe' | 'bootWait'>,
): Promise<boolean> {
  const probe = o.probe ?? ((p: number) => probeHealthOnce(p, 1500));
  const { waitMs, pollMs } = o.bootWait ?? { waitMs: 30_000, pollMs: 500 };
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const cur = await read(port);
    if (cur !== null && (before === null || cur > before)) return true;
    if (before === null && await probe(port)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

/** A `blocked` or `rolled-back` result the PROMPT hook consumed, left for the next SessionStart (recordUnshownOutcome). */
export const UNSHOWN_OUTCOME_FILE = join(DATA_DIR, '.auto-update-unshown');
type UnshownOutcome = Extract<AutoUpdateOutcome, { kind: 'blocked' | 'rolled-back' }>;

/** The prompt hook cannot announce what its pass found: its stdout reaches the model as context (Claude Code shows the user no
 *  entry for it), and the pass has already used the hourly slot, so the next SessionStart finds no check due and says nothing.
 *  While sessions keep prompting, a dirty checkout or a release that would not boot was never reported. So the prompt hook
 *  leaves the result here and SessionStart announces it (takeUnshownOutcome). A pass that updated clears an older one. */
export function recordUnshownOutcome(out: AutoUpdateOutcome): void {
  try {
    if (out.kind === 'blocked' || out.kind === 'rolled-back') writeFileSync(UNSHOWN_OUTCOME_FILE, JSON.stringify(out));
    else if (out.kind === 'updated') rmSync(UNSHOWN_OUTCOME_FILE, { force: true });
  } catch { /* best-effort, like the stamp: the log line the pass wrote stays */ }
}

/** Read and remove what the prompt hook left. Null when there is nothing or it is unreadable, and when it was written by
 *  another version than `version` (the checkout was updated by hand since, so the block it reports is gone). */
export function takeUnshownOutcome(version: string = VERSION): UnshownOutcome | null {
  let raw: string;
  try { raw = readFileSync(UNSHOWN_OUTCOME_FILE, 'utf-8'); } catch { return null; }
  try { rmSync(UNSHOWN_OUTCOME_FILE, { force: true }); } catch { /* announced again next session at worst */ }
  try {
    const out = JSON.parse(raw) as UnshownOutcome;
    return (out.kind === 'blocked' || out.kind === 'rolled-back') && out.res?.from === version ? out : null;
  } catch { return null; }
}

function readSkippedRelease(): string | null {
  try { return readFileSync(SKIPPED_RELEASE_FILE, 'utf-8').trim() || null; } catch { return null; }
}

/** The configured interval, the stamp's contents and whether a check is due now: one stat and one small read. The pass and the
 *  prompt hook's cheap due-check (startPromptUpdate) both ask THIS, so they can never disagree about "due". */
function readStampState(now: number = Date.now()): { intervalMs: number; stamp: { delayMs: number | null; failures: number }; due: boolean } {
  const intervalMs = updateCheckIntervalFromEnv(process.env.CAPTAIN_MEMO_AUTO_UPDATE_INTERVAL_MS);
  let lastCheck: number | null = null;
  let stamp: { delayMs: number | null; failures: number } = { delayMs: null, failures: 0 };
  try { lastCheck = statSync(UPDATE_STAMP).mtimeMs; stamp = parseUpdateStamp(readFileSync(UPDATE_STAMP, 'utf-8')); } catch { /* never checked */ }
  return { intervalMs, stamp, due: isUpdateCheckDue(lastCheck, now, stamp.delayMs ?? intervalMs) };
}

/** One throttled pass: if a check is due and no other session is running one, find the newest stable tag that
 *  fast-forwards (see worker/self-updater.ts for the gates), apply it, restart the worker onto it, and roll back if it
 *  does not come up. Never throws. Every other caller sees `{kind:'none'}` at the cost of one stat and one small read. */
export async function runAutoUpdatePass(o: AutoUpdateOptions): Promise<AutoUpdateOutcome> {
  let wroteTransition = false;   // did WE leave a breadcrumb that must not outlive a failed restart?
  const readInstance = o.readInstance ?? ((p: number) => readWorkerInstance(p, 1500));
  try {
    const port: UpdaterPort = o.port ?? {
      run: (argv, cwd, timeoutMs) => {
        // env: make git FAIL FAST instead of blocking on a credential / host-key prompt (which would otherwise stall
        // the hook for the whole timeout). timeoutMs is per-call: short for git fetch, generous for `bun install`
        // (installDeps passes 300s).
        const r = Bun.spawnSync(argv, {
          cwd, stdout: 'pipe', stderr: 'pipe', timeout: gitTimeoutFor(argv, timeoutMs, o.networkTimeoutMs),
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oConnectTimeout=10' } as Record<string, string>,
        });
        return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
      },
      readPackageVersion: (dir) => readPkgField(dir, 'version'),
      readPackageName: (dir) => readPkgField(dir, 'name'),
    };
    // A failed fetch (offline, dead credential) can cost its whole deadline, so failures back off: noted here, counted
    // in the stamp, and nextUpdateCheckDelayMs doubles the wait per failure.
    let fetchFailed = false;
    const runGit = port.run;
    port.run = (argv, cwd, timeoutMs) => {
      const r = runGit(argv, cwd, timeoutMs);
      if (argv[1] === 'fetch' && r.code !== 0) fetchFailed = true;
      return r;
    };
    try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* dir may exist */ }
    const { intervalMs, stamp, due } = readStampState();
    const writeStamp = (failures: number): void => {
      try { writeFileSync(UPDATE_STAMP, formatUpdateStamp(new Date(), nextUpdateCheckDelayMs(intervalMs, failures), failures)); } catch { /* stamp best-effort */ }
    };
    // Lock serializes concurrent sessions: only one may fetch/ff/install/restart at a time.
    if (!due || !acquireHealLock(AUTO_UPDATE_LOCK)) return { kind: 'none' };
    try {
      writeStamp(stamp.failures + 1);   // counted as failed until it finishes: a hook killed mid-fetch still backs off
      const version = o.version ?? VERSION;
      const top = port.run(['git', 'rev-parse', '--show-toplevel'], import.meta.dir);
      const installDir = (top.code === 0 && top.stdout.trim()) ? top.stdout.trim() : import.meta.dir;
      // A release that failed to boot is skipped until a newer one appears: the target must be strictly newer than the
      // running version, so the skipped release stands in for it. `from` is put back for the banner and the log.
      const skipped = readSkippedRelease();
      const res = runAutoUpdate(port, installDir, skipped && compareSemver(skipped, version) > 0 ? skipped : version, process.execPath);
      if (res) res.from = version;
      writeStamp(fetchFailed ? stamp.failures + 1 : 0);
      if (res?.ok) {
        const wport = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
        const restart = o.restart ?? (async (graceful: boolean) => {
          const { getServiceManager } = await import('../services/service-manager/index.ts');
          await restartWorker(getServiceManager(), 'captain-memo-worker', graceful ? { port: wport, graceful: true } : { port: wport });
        });
        // Same breadcrumb the worker leaves when it replaces itself: a CONCURRENT session starting during this
        // replacement must wait it out, not reclaim the port from under us. It MUST be cleared again on every path where
        // the replacement does not land — otherwise a hook reads its own note back, shields the worker it just failed to
        // restart, and tells the user "updating, coming back by itself" about a worker that is simply dead.
        wroteTransition = true;
        const outgoing = await readInstance(wport);   // identified BEFORE it is touched
        markTransition({ phase: 'updating', from: res.from, ...(res.to ? { to: res.to } : {}) });
        await restart(true);
        if (await awaitNewProcess(outgoing, wport, readInstance, o)) { await o.afterBoot?.(); return { kind: 'updated', res }; }
        // New code didn't boot (bad deps / crash-loop). Roll the checkout back to the prior sha and restart the OLD,
        // known-good code rather than strand the worker dead, and do not try this release again.
        const failed = await readInstance(wport);
        const rolled = res.priorSha ? rollbackTo(port, installDir, res.priorSha, process.execPath) : false;
        if (res.to) { try { writeFileSync(SKIPPED_RELEASE_FILE, res.to + '\n'); } catch { /* best-effort: it is tried again next check */ } }
        markTransition({ phase: 'updating', to: res.from });   // rolling BACK to the known-good version
        await restart(false);
        if (!(await awaitNewProcess(failed, wport, readInstance, o))) { clearTransition(); wroteTransition = false; }   // nothing is coming back — stop shielding it
        logHookError(o.event, new Error(`auto-update to ${res.to} failed to boot; rolled back=${rolled}`));
        return { kind: 'rolled-back', res, rolled };
      }
      if (res && !res.ok) {
        // A safety gate refused. Expected, not an error, but it repeats at every check, so the caller says it where
        // the user can see it: logged only, the checkout never updated and nobody knew.
        logHookError(o.event, new Error(`auto-update skipped: ${res.code} — ${res.reason}`));
        return { kind: 'blocked', res };
      }
      return { kind: 'none' };
    } finally {
      releaseHealLock(AUTO_UPDATE_LOCK);
    }
  } catch (err) {
    // The restart itself threw (service manager missing, task locked). Our breadcrumb would otherwise shield a worker
    // nobody restarted, for the full TTL.
    if (wroteTransition) clearTransition();
    logHookError(o.event, err);
    return { kind: 'none' };
  }
}

/** What the PROMPT path does with one pass: the log line and the left-over outcome. No banner on this path (the hook's stdout
 *  is the prompt's context). The version marker is left alone, so the next SessionStart announces the upgrade; the log is where
 *  this one shows. A blocked or rolled-back check has no marker, and it has used the hourly slot: it is left for the next
 *  SessionStart to announce (recordUnshownOutcome). Run in-line by the prompt hook on win32, and by the UpdateApply child
 *  elsewhere (hooks/update-apply.ts). `event` tags the log lines. */
export async function applyPromptUpdate(event: string, pass: typeof runAutoUpdatePass = runAutoUpdatePass): Promise<void> {
  const out = await pass({ event, networkTimeoutMs: 8_000 });
  if (out.kind === 'updated') logHookError(event, new Error(`auto-updated v${out.res.from} -> v${out.res.to ?? '?'}`));
  recordUnshownOutcome(out);
}

/** Held by the prompt hook that spawned the apply child, and NOT released: it expires by itself (the heal lock's 20 s TTL). */
export const UPDATE_SPAWN_LOCK = join(DATA_DIR, '.auto-update-spawn.lock');

/** Start `cmd` fully detached: its own session (Bun `detached` = setsid), no stdio shared with the caller (Claude Code refuses
 *  the output of a hook whose background child holds its pipes, and waits for them), and unref'd so this process may exit
 *  while it runs. Measured 2026-10-22 (Claude Code 2.1.306, `claude -p`): such a child survives its parent's exit and the end
 *  of the session. Throws if the spawn itself fails. `detached` is computed from the platform (the repo's `detached: !win`), so
 *  this is POSIX-only by construction: on win32 a detached child would escape the kill-on-close job (shared/kill-tree.ts), and a
 *  caller that forgot startPromptUpdate's win32 branch still could not start one. `platform` and `spawn` are for tests. */
export function spawnDetached(cmd: string[], platform: NodeJS.Platform = process.platform, spawn: typeof Bun.spawn = Bun.spawn): void {
  spawn(cmd, { stdio: ['ignore', 'ignore', 'ignore'], detached: platform !== 'win32', env: process.env as Record<string, string> }).unref();
}

export type PromptUpdateStart = 'inline' | 'spawned' | 'not-due' | 'in-flight' | 'no-entry' | 'spawn-failed';

export interface PromptUpdateDeps {
  platform?: NodeJS.Platform;
  /** The dispatcher entry to re-run as the child (default: the one this process was launched through). */
  entry?: string | null;
  execPath?: string;
  spawn?: (cmd: string[]) => void;
  pass?: typeof runAutoUpdatePass;
  now?: number;
}

/** The UserPromptSubmit hook's self-update step, after its envelope is out (the caller has checked the opt-in, a healthy worker
 *  and a Claude Code host). Claude Code cuts this hook at 30 s and kills everything still attached to it, so an apply (a
 *  `bun install` alone may take 300 s) cannot run in it: on Linux/macOS it runs as a DETACHED child (`<dispatcher> UpdateApply`,
 *  hooks/update-apply.ts) and the hook exits at once. win32 keeps the in-line pass as before (a plain child there probably
 *  dies with the hook: shared/kill-tree.ts; the WMI launcher is not wired for this). Never throws on the spawn path.
 *
 *  Single flight: the child itself checks the stamp, takes `.auto-update.lock` and stamps BEFORE any git, as the in-line pass
 *  always did. What that cannot cover is the gap between this hook's due-check and the child's stamp (a bun boot, ~0.1 s): a second
 *  prompt in it would see "due" and spawn a second child, which the pass's own lock and stamp would then turn away, at the cost
 *  of a bun boot. So the spawn takes UPDATE_SPAWN_LOCK first: one child per 20 s at most.
 *
 *  COST (measured 2026-10-22, load ~3 on 24 cores, run niced like every heavy job here, so absolute times are ~2.5x a quiet box;
 *  20 alternating runs per arm): a due check adds +9.9 ms at the median (median of the pairwise differences; the spread between runs
 *  is 25-45 ms) to a fresh bun process that does the due-check, the lock and the spawn (348.5 ms not due, 352.7 due, with a 5 s stub
 *  child: the process had exited before the stub in 20/20), and +3.7 ms to the real bundle against a stub worker (388.4 vs 390.1 ms);
 *  the real UpdateApply then finished a median 361 ms AFTER the hook had gone, time the hook used to spend in-line on a pass that
 *  found nothing to do. */
export async function startPromptUpdate(d: PromptUpdateDeps = {}): Promise<PromptUpdateStart> {
  if ((d.platform ?? process.platform) === 'win32') { await applyPromptUpdate('UserPromptSubmit', d.pass); return 'inline'; }
  if (!readStampState(d.now).due) return 'not-due';
  const entry = d.entry === undefined ? hookEntryPath() : d.entry;
  if (!entry) { logHookError('UserPromptSubmit', new Error('auto-update: not started, this hook was not launched through the dispatcher entry')); return 'no-entry'; }
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* dir may exist */ }
  if (!acquireHealLock(UPDATE_SPAWN_LOCK, d.now)) return 'in-flight';
  try {
    (d.spawn ?? spawnDetached)([d.execPath ?? process.execPath, entry, 'UpdateApply']);
    return 'spawned';
  } catch (err) {
    logHookError('UserPromptSubmit', new Error(`auto-update: could not start the detached apply: ${(err as Error).message}`));
    return 'spawn-failed';
  }
}
