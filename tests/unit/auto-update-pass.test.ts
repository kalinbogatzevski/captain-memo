import { test, expect, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { DATA_DIR } from '../../src/shared/paths.ts';
import { runAutoUpdatePass, gitTimeoutFor, AUTO_UPDATE_LOCK, UPDATE_STAMP, SKIPPED_RELEASE_FILE } from '../../src/hooks/auto-update.ts';
import { readTransition, clearTransition } from '../../src/shared/worker-transition.ts';
import { parseUpdateStamp, formatUpdateStamp, type UpdaterPort, type ExecResult } from '../../src/worker/self-updater.ts';

// DATA_DIR is the preload's scratch home (tests/preload.ts), so the stamp, lock and breadcrumb below are throwaway.
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const FAIL: ExecResult = { code: 1, stdout: '', stderr: 'nope' };

/** A scripted git: first matching route wins (startsWith on the joined argv), anything else succeeds silently. */
function scriptPort(routes: Record<string, ExecResult>, pkgVersion: string | null = '0.99.0'): { port: UpdaterPort; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    port: {
      run: (argv) => { const key = argv.join(' '); calls.push(key); for (const [pat, res] of Object.entries(routes)) if (key.startsWith(pat)) return res; return ok(); },
      readPackageVersion: () => pkgVersion,
      readPackageName: () => 'captain-memo',
    },
  };
}
const ORIGIN = { 'git rev-parse --show-toplevel': ok('/clone\n'), 'git remote get-url origin': ok('https://example.test/r.git\n'), 'git rev-parse --abbrev-ref HEAD': ok('master\n'), 'git rev-parse HEAD': ok('abc123\n') };
const tags = (...names: string[]): Record<string, ExecResult> => ({ ...ORIGIN, 'git ls-remote --tags origin': ok(names.map((n) => `a1\trefs/tags/${n}`).join('\n') + '\n') });
const NEWER = tags('v0.99.0');

let restarts: boolean[];
let afterBootCalls: number;
/** The worker as the pass sees it: instance 100 before the restart; after the first restart the NEW code is instance 200
 *  (`newBoots`) or nothing; after the rollback restart the old code is instance 300 (`oldBoots`) or nothing. */
const deps = (port: UpdaterPort, w: { newBoots?: boolean; oldBoots?: boolean; restartFails?: boolean; statsUp?: boolean } = {}) => ({
  event: 'Test', port, version: '0.54.0',
  restart: async (graceful: boolean) => { restarts.push(graceful); if (w.restartFails) throw new Error('service manager missing'); },
  readInstance: async () => (restarts.length === 0 ? 100 : restarts.length === 1 ? (w.newBoots === false ? null : 200) : (w.oldBoots === false ? null : 300)),
  probe: async () => false,
  bootWait: { waitMs: 60, pollMs: 5 },
  afterBoot: async () => { afterBootCalls++; return w.statsUp ?? false; },
});

beforeEach(() => {
  restarts = [];
  afterBootCalls = 0;
  mkdirSync(DATA_DIR, { recursive: true });
  for (const f of [UPDATE_STAMP, AUTO_UPDATE_LOCK, SKIPPED_RELEASE_FILE]) rmSync(f, { force: true });
  clearTransition();
});

test('not due: one stat and one read of the stamp, no git, no lock', async () => {
  writeFileSync(UPDATE_STAMP, formatUpdateStamp(new Date(), 3_600_000, 0));
  const { port, calls } = scriptPort(NEWER);
  expect(await runAutoUpdatePass(deps(port))).toEqual({ kind: 'none' });
  expect(calls).toEqual([]);
  expect(existsSync(AUTO_UPDATE_LOCK)).toBe(false);
});

test('due and a newer stable tag fast-forwards: worker restarted gracefully onto it, stamp reset, lock released', async () => {
  const { port, calls } = scriptPort(NEWER);
  const out = await runAutoUpdatePass(deps(port));
  expect(out.kind).toBe('updated');
  expect(out.kind === 'updated' && out.res).toMatchObject({ ok: true, from: '0.54.0', to: '0.99.0', priorSha: 'abc123' });
  expect(calls).toContain('git merge --ff-only v0.99.0');
  expect(restarts).toEqual([true]);
  expect(parseUpdateStamp(readFileSync(UPDATE_STAMP, 'utf-8')).failures).toBe(0);
  expect(existsSync(AUTO_UPDATE_LOCK)).toBe(false);
  expect(readTransition()?.phase).toBe('updating');   // the breadcrumb a concurrent session waits on; the incoming worker clears it
  expect(afterBootCalls).toBe(1);
});

test('a new worker process is the proof it booted: /stats still answering 503 (a big corpus indexing) must not roll a good update back', async () => {
  const { port, calls } = scriptPort(NEWER);
  const out = await runAutoUpdatePass(deps(port, { statsUp: false }));   // afterBoot is the stats refresh: it reports "not up yet"
  expect(out.kind).toBe('updated');
  expect(calls.some((c) => c.startsWith('git reset'))).toBe(false);
  expect(restarts).toEqual([true]);
  expect(existsSync(SKIPPED_RELEASE_FILE)).toBe(false);
});

test('the OUTGOING worker still answering is not a restart: the same instance does not count', async () => {
  const out = await runAutoUpdatePass({ ...deps(scriptPort(NEWER).port), readInstance: async () => 100 });
  expect(out.kind).toBe('rolled-back');
});

test('no worker was running before the update: any /health answer is enough', async () => {
  let up = false;
  const out = await runAutoUpdatePass({ ...deps(scriptPort(NEWER).port), readInstance: async () => null, probe: async () => up, restart: async (g: boolean) => { restarts.push(g); up = true; } });
  expect(out.kind).toBe('updated');
});

test('a second pass inside the interval does nothing (SessionStart and the prompt hook share one throttle)', async () => {
  await runAutoUpdatePass(deps(scriptPort(NEWER).port));
  const second = scriptPort(NEWER);
  expect(await runAutoUpdatePass(deps(second.port))).toEqual({ kind: 'none' });
  expect(second.calls).toEqual([]);
});

test('another session holds the update lock: no git at all', async () => {
  writeFileSync(AUTO_UPDATE_LOCK, String(Date.now()));
  const { port, calls } = scriptPort(NEWER);
  expect(await runAutoUpdatePass(deps(port))).toEqual({ kind: 'none' });
  expect(calls).toEqual([]);
  expect(existsSync(AUTO_UPDATE_LOCK)).toBe(true);   // not ours to release
});

test('already current: nothing applied, nothing restarted, stamp written clean', async () => {
  const { port } = scriptPort(tags('v0.54.0'));
  expect(await runAutoUpdatePass(deps(port))).toEqual({ kind: 'none' });
  expect(restarts).toEqual([]);
  expect(parseUpdateStamp(readFileSync(UPDATE_STAMP, 'utf-8')).failures).toBe(0);
});

test('a dirty tree is reported as blocked and the worker is left alone', async () => {
  const { port, calls } = scriptPort({ ...NEWER, 'git status --porcelain': ok(' M src/x.ts\n') });
  const out = await runAutoUpdatePass(deps(port));
  expect(out.kind === 'blocked' && out.res.code).toBe('dirty_tree');
  expect(calls.some((c) => c.startsWith('git merge --ff-only'))).toBe(false);
  expect(restarts).toEqual([]);
});

test('a failed fetch counts as a failure so the next check backs off', async () => {
  const { port } = scriptPort({ ...ORIGIN, 'git fetch': FAIL, 'git ls-remote': FAIL });
  expect(await runAutoUpdatePass(deps(port))).toEqual({ kind: 'none' });
  expect(parseUpdateStamp(readFileSync(UPDATE_STAMP, 'utf-8')).failures).toBe(1);
});

test('the new code does not come up: the checkout goes back to the prior sha, the old worker is restarted, the release is remembered as bad', async () => {
  const { port, calls } = scriptPort(NEWER);
  const out = await runAutoUpdatePass(deps(port, { newBoots: false, oldBoots: true }));
  expect(out).toMatchObject({ kind: 'rolled-back', rolled: true });
  expect(calls).toContain('git reset --hard abc123');
  expect(restarts).toEqual([true, false]);
  expect(readTransition()?.to).toBe('0.54.0');   // rolling back to the known-good version
  expect(readFileSync(SKIPPED_RELEASE_FILE, 'utf-8').trim()).toBe('0.99.0');
});

test('a release that failed to boot is not tried again until a newer one is published, and the banner still says from the running version', async () => {
  await runAutoUpdatePass(deps(scriptPort(NEWER).port, { newBoots: false, oldBoots: true }));
  rmSync(UPDATE_STAMP, { force: true });                      // the next check comes due
  restarts = [];
  const again = scriptPort(NEWER);
  expect(await runAutoUpdatePass(deps(again.port))).toEqual({ kind: 'none' });   // v0.99.0 again: skipped
  expect(again.calls.some((c) => c.startsWith('git merge --ff-only'))).toBe(false);
  expect(restarts).toEqual([]);
  rmSync(UPDATE_STAMP, { force: true });
  const fixed = scriptPort(tags('v0.99.0', 'v0.99.1'), '0.99.1');
  const out = await runAutoUpdatePass(deps(fixed.port));
  expect(fixed.calls).toContain('git merge --ff-only v0.99.1');
  expect(out.kind === 'updated' && out.res).toMatchObject({ from: '0.54.0', to: '0.99.1' });
});

test('neither the new nor the old code comes up: the breadcrumb is cleared, so nothing shields a dead worker', async () => {
  const out = await runAutoUpdatePass(deps(scriptPort(NEWER).port, { newBoots: false, oldBoots: false }));
  expect(out.kind).toBe('rolled-back');
  expect(readTransition()).toBeNull();
});

test('a restart that throws is swallowed, and the breadcrumb it left is cleared', async () => {
  const out = await runAutoUpdatePass(deps(scriptPort(NEWER).port, { restartFails: true }));
  expect(out).toEqual({ kind: 'none' });
  expect(readTransition()).toBeNull();
  expect(existsSync(AUTO_UPDATE_LOCK)).toBe(false);
});

test('gitTimeoutFor: only fetch and ls-remote are held to the network cap; a merge or install keeps its own budget', () => {
  expect(gitTimeoutFor(['git', 'fetch', '--tags'], 20_000, 8_000)).toBe(8_000);
  expect(gitTimeoutFor(['git', 'ls-remote', '--tags', 'origin'], undefined, 8_000)).toBe(8_000);
  expect(gitTimeoutFor(['git', 'merge', '--ff-only', 'v1.0.0'], undefined, 8_000)).toBe(20_000);
  expect(gitTimeoutFor(['/bun', 'install'], 300_000, 8_000)).toBe(300_000);
  expect(gitTimeoutFor(['git', 'fetch'], 20_000, undefined)).toBe(20_000);   // SessionStart: no cap
  expect(gitTimeoutFor(['git', 'fetch'], 5_000, 8_000)).toBe(5_000);          // never raises a shorter ask
});

test('the stamp, lock and skip files the pass uses sit in the data dir under their long-standing names', () => {
  expect(UPDATE_STAMP.endsWith('.last-update-check')).toBe(true);
  expect(AUTO_UPDATE_LOCK.endsWith('.auto-update.lock')).toBe(true);
  expect(SKIPPED_RELEASE_FILE.startsWith(DATA_DIR)).toBe(true);
});
