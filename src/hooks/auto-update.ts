// src/hooks/auto-update.ts — one pass of the OPT-IN git self-update (CAPTAIN_MEMO_AUTO_UPDATE=1), shared by the
// SessionStart and UserPromptSubmit hooks. Both go through the same `.last-update-check` stamp and the same
// `.auto-update.lock`, so they make ONE check per interval between them, however many sessions are open.
//
// Why a hook and not a worker timer: the updater is synchronous (a check is two network round trips, a `bun install`
// can run minutes) and would stall the worker's event loop; and only a process OUTSIDE the worker survives its restart
// to confirm the new code boots and roll the checkout back if it does not.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA_DIR, DEFAULT_WORKER_PORT } from '../shared/paths.ts';
import { VERSION } from '../shared/version.ts';
import { compareSemver } from '../shared/self-update.ts';
import { runAutoUpdate, rollbackTo, isUpdateCheckDue, updateCheckIntervalFromEnv, nextUpdateCheckDelayMs, formatUpdateStamp, parseUpdateStamp, type ApplyResult, type UpdaterPort } from '../worker/self-updater.ts';
import { markTransition, clearTransition } from '../shared/worker-transition.ts';
import { restartWorker } from '../shared/worker-control.ts';
import { acquireHealLock, releaseHealLock } from '../shared/worker-heal-lock.ts';
import { probeHealthOnce, readWorkerInstance } from '../shared/worker-health-probe.ts';
import { logHookError } from './shared.ts';

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

function readSkippedRelease(): string | null {
  try { return readFileSync(SKIPPED_RELEASE_FILE, 'utf-8').trim() || null; } catch { return null; }
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
    const intervalMs = updateCheckIntervalFromEnv(process.env.CAPTAIN_MEMO_AUTO_UPDATE_INTERVAL_MS);
    try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* dir may exist */ }
    let lastCheck: number | null = null;
    let stamp: { delayMs: number | null; failures: number } = { delayMs: null, failures: 0 };
    try { lastCheck = statSync(UPDATE_STAMP).mtimeMs; stamp = parseUpdateStamp(readFileSync(UPDATE_STAMP, 'utf-8')); } catch { /* never checked */ }
    const writeStamp = (failures: number): void => {
      try { writeFileSync(UPDATE_STAMP, formatUpdateStamp(new Date(), nextUpdateCheckDelayMs(intervalMs, failures), failures)); } catch { /* stamp best-effort */ }
    };
    // Lock serializes concurrent sessions: only one may fetch/ff/install/restart at a time.
    if (!isUpdateCheckDue(lastCheck, Date.now(), stamp.delayMs ?? intervalMs) || !acquireHealLock(AUTO_UPDATE_LOCK)) return { kind: 'none' };
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
