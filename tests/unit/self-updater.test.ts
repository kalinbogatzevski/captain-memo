import { test, expect } from 'bun:test';
import {
  pickUpdateTarget, applyUpdateToRef, runAutoUpdate, rollbackTo, isUpdateCheckDue, isGitCheckout, originUrl,
  type UpdaterPort, type ExecResult,
} from '../../src/worker/self-updater.ts';

/** Scripted port: map an argv (joined) to a canned ExecResult. Records the argv sequence so tests
 *  can assert the exact git commands run (e.g. ff-only merge, never a plain merge). pkgName defaults
 *  to 'captain-memo' so the repo-identity gate passes unless a test overrides it. */
function scriptPort(
  routes: Record<string, ExecResult | ((argv: string[]) => ExecResult)>,
  pkgVersion: string | null = null, pkgName: string | null = 'captain-memo',
): { port: UpdaterPort; calls: string[][] } {
  const calls: string[][] = [];
  const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
  const port: UpdaterPort = {
    run: (argv) => {
      calls.push(argv);
      const key = argv.join(' ');
      for (const [pat, res] of Object.entries(routes)) {
        if (key.startsWith(pat)) return typeof res === 'function' ? res(argv) : res;
      }
      return ok(); // default: succeed silently (checkout, reset, install, etc.)
    },
    readPackageVersion: () => pkgVersion,
    readPackageName: () => pkgName,
  };
  return { port, calls };
}

const FAIL: ExecResult = { code: 1, stdout: '', stderr: 'nope' };
// Two tags, both vended by origin — the default ls-remote response for the happy-path tests.
const LSREMOTE = (names: string[]): ExecResult =>
  ({ code: 0, stdout: names.map((n, i) => `${'a'.repeat(40).slice(0, 39)}${i}\trefs/tags/${n}`).join('\n'), stderr: '' });

// ── pickUpdateTarget ──

test('pickUpdateTarget picks the NEWEST ff-safe stable tag strictly newer than running', () => {
  const { port } = scriptPort({
    'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'master', stderr: '' },
    'git ls-remote --tags origin': LSREMOTE(['v0.24.0', 'v0.24.1', 'v0.24.2', 'v0.23.0']),
    'git merge-base --is-ancestor': { code: 0, stdout: '', stderr: '' },   // all ff-reachable
  });
  expect(pickUpdateTarget(port, '/repo', '0.24.0')).toEqual({ ref: 'v0.24.2', version: 'v0.24.2' });
});

test('pickUpdateTarget REJECTS pre-release / build-metadata tags', () => {
  const { port } = scriptPort({
    'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'master', stderr: '' },
    'git ls-remote --tags origin': LSREMOTE(['v0.25.0-rc1', 'v0.25.0+build', 'v0.24.2']),
    'git merge-base --is-ancestor': { code: 0, stdout: '', stderr: '' },
  });
  // The rc1 sorts "newer" only if the -suffix leaks through; it must be ignored, leaving v0.24.2.
  expect(pickUpdateTarget(port, '/repo', '0.24.0')).toEqual({ ref: 'v0.24.2', version: 'v0.24.2' });
});

test('SECURITY: pickUpdateTarget only considers tags ORIGIN vends — a locally-added fork tag is ignored', () => {
  // git tag --list would show a fork-added v99.0.0; ls-remote origin does NOT, so it must be rejected
  // even though it is semver-newer and (per the ancestor stub) ff-reachable. This is the origin gate.
  const { port, calls } = scriptPort({
    'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'master', stderr: '' },
    'git ls-remote --tags origin': LSREMOTE(['v0.24.2']),   // origin only has v0.24.2
    'git merge-base --is-ancestor': { code: 0, stdout: '', stderr: '' },
  });
  // Even asked as if running 0.24.2 (so v0.24.2 isn't newer), a rogue v99 must not appear.
  expect(pickUpdateTarget(port, '/repo', '0.24.2')).toBeNull();
  // And it must never enumerate the local tag namespace.
  expect(calls.some((c) => c.join(' ').startsWith('git tag --list'))).toBe(false);
});

test('SECURITY: pickUpdateTarget refuses a dash-named branch (git argument-injection)', () => {
  const { port, calls } = scriptPort({
    'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: '--upload-pack=touch /tmp/x', stderr: '' },
  });
  expect(pickUpdateTarget(port, '/repo', '0.24.0')).toBeNull();
  // Must bail BEFORE running any fetch with the poisoned branch.
  expect(calls.some((c) => c.includes('fetch'))).toBe(false);
});

test('pickUpdateTarget fetch drops the branch positional entirely (no injection surface)', () => {
  const { calls } = (() => {
    const s = scriptPort({
      'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'master', stderr: '' },
      'git ls-remote --tags origin': LSREMOTE(['v0.24.2']),
      'git merge-base --is-ancestor': { code: 0, stdout: '', stderr: '' },
    });
    pickUpdateTarget(s.port, '/repo', '0.24.0');
    return s;
  })();
  const fetch = calls.find((c) => c[1] === 'fetch');
  expect(fetch).toEqual(['git', 'fetch', '--tags', '--force', 'origin']);   // no trailing <branch>
});

test('pickUpdateTarget skips a tag HEAD cannot fast-forward to', () => {
  const { port } = scriptPort({
    'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'master', stderr: '' },
    'git ls-remote --tags origin': LSREMOTE(['v0.24.2']),
    'git merge-base --is-ancestor': FAIL,   // NOT an ancestor → diverged history
  });
  expect(pickUpdateTarget(port, '/repo', '0.24.0')).toBeNull();
});

test('pickUpdateTarget returns null when nothing is newer than running', () => {
  const { port } = scriptPort({
    'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'master', stderr: '' },
    'git ls-remote --tags origin': LSREMOTE(['v0.24.0', 'v0.24.2']),
    'git merge-base --is-ancestor': { code: 0, stdout: '', stderr: '' },
  });
  expect(pickUpdateTarget(port, '/repo', '0.24.2')).toBeNull();
});

test('pickUpdateTarget refuses a detached HEAD (advances a branch pointer, never detaches)', () => {
  const { port } = scriptPort({ 'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'HEAD', stderr: '' } });
  expect(pickUpdateTarget(port, '/repo', '0.24.0')).toBeNull();
});

// ── applyUpdateToRef — the safety gates ──

test('applyUpdateToRef fast-forwards a clean checkout and reports the new version', () => {
  const { port, calls } = scriptPort({
    'git rev-parse --show-toplevel': { code: 0, stdout: '/repo', stderr: '' },
    'git status --porcelain': { code: 0, stdout: '', stderr: '' },       // clean
    'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'master', stderr: '' },
    'git merge --ff-only v0.24.2': { code: 0, stdout: '', stderr: '' },
  }, '0.24.2');
  const r = applyUpdateToRef(port, '/repo', 'v0.24.2', '0.24.0');
  expect(r).toEqual({ ok: true, from: '0.24.0', to: '0.24.2' });
  // The merge MUST be --ff-only (never a plain merge that could create a merge commit).
  expect(calls.some((c) => c.join(' ') === 'git merge --ff-only v0.24.2')).toBe(true);
});

test('applyUpdateToRef REFUSES a dirty work-tree (never clobbers local edits)', () => {
  const { port } = scriptPort({
    'git rev-parse --show-toplevel': { code: 0, stdout: '/repo', stderr: '' },
    'git status --porcelain': { code: 0, stdout: ' M src/foo.ts', stderr: '' },   // dirty
  });
  const r = applyUpdateToRef(port, '/repo', 'v0.24.2', '0.24.0');
  expect(r.ok).toBe(false);
  expect(r.code).toBe('dirty_tree');
});

test('applyUpdateToRef refuses a detached HEAD', () => {
  const { port } = scriptPort({
    'git rev-parse --show-toplevel': { code: 0, stdout: '/repo', stderr: '' },
    'git status --porcelain': { code: 0, stdout: '', stderr: '' },
    'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'HEAD', stderr: '' },
  });
  expect(applyUpdateToRef(port, '/repo', 'v0.24.2', '0.24.0').code).toBe('detached_head');
});

test('applyUpdateToRef surfaces a failed fast-forward (diverged) rather than forcing it', () => {
  const { port } = scriptPort({
    'git rev-parse --show-toplevel': { code: 0, stdout: '/repo', stderr: '' },
    'git status --porcelain': { code: 0, stdout: '', stderr: '' },
    'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'master', stderr: '' },
    'git merge --ff-only': { code: 1, stdout: '', stderr: 'Not possible to fast-forward' },
  });
  const r = applyUpdateToRef(port, '/repo', 'v0.24.2', '0.24.0');
  expect(r.ok).toBe(false);
  expect(r.code).toBe('pull_failed');
});

// ── runAutoUpdate — orchestration no-ops ──

test('runAutoUpdate no-ops on a non-git dir (marketplace install)', () => {
  const { port } = scriptPort({ 'git rev-parse --show-toplevel': FAIL });
  expect(runAutoUpdate(port, '/repo', '0.24.0', '/bun')).toBeNull();
});

test('SECURITY: runAutoUpdate no-ops when the resolved repo is NOT captain-memo (nested-repo mis-target)', () => {
  // A marketplace install nested in the user's dotfiles repo resolves show-toplevel to THAT repo.
  const { port } = scriptPort({
    'git rev-parse --show-toplevel': { code: 0, stdout: '/home/me/dotfiles', stderr: '' },
  }, null, 'my-dotfiles');   // package name is not captain-memo
  expect(runAutoUpdate(port, '/home/me/dotfiles', '0.24.0', '/bun')).toBeNull();
});

test('runAutoUpdate no-ops with no origin remote', () => {
  const { port } = scriptPort({
    'git rev-parse --show-toplevel': { code: 0, stdout: '/repo', stderr: '' },
    'git remote get-url origin': FAIL,
  });
  expect(runAutoUpdate(port, '/repo', '0.24.0', '/bun')).toBeNull();
});

test('runAutoUpdate flags installFailed when the ff succeeds but bun install fails', () => {
  const { port } = scriptPort({
    'git rev-parse --show-toplevel': { code: 0, stdout: '/repo', stderr: '' },
    'git remote get-url origin': { code: 0, stdout: 'https://github.com/x/captain-memo.git', stderr: '' },
    'git rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'master', stderr: '' },
    'git ls-remote --tags origin': LSREMOTE(['v0.24.2']),
    'git merge-base --is-ancestor': { code: 0, stdout: '', stderr: '' },
    'git status --porcelain': { code: 0, stdout: '', stderr: '' },
    'git rev-parse HEAD': { code: 0, stdout: 'oldsha', stderr: '' },
    'git merge --ff-only v0.24.2': { code: 0, stdout: '', stderr: '' },
    '/bun install': FAIL,   // deps step fails
  }, '0.24.2');
  const r = runAutoUpdate(port, '/repo', '0.24.0', '/bun');
  expect(r?.ok).toBe(true);
  expect(r?.installFailed).toBe(true);
  expect(r?.priorSha).toBe('oldsha');   // captured for rollback
});

// ── rollbackTo ──

test('rollbackTo hard-resets to the prior sha and reinstalls deps', () => {
  const { port, calls } = scriptPort({ 'git reset --hard oldsha': { code: 0, stdout: '', stderr: '' } });
  expect(rollbackTo(port, '/repo', 'oldsha', '/bun')).toBe(true);
  expect(calls.some((c) => c.join(' ') === 'git reset --hard oldsha')).toBe(true);
  expect(calls.some((c) => c.join(' ') === '/bun install')).toBe(true);   // old deps restored
});

test('rollbackTo refuses a dash-leading sha (defense-in-depth) and a failed reset', () => {
  expect(rollbackTo(scriptPort({}).port, '/repo', '--foo', '/bun')).toBe(false);
  expect(rollbackTo(scriptPort({ 'git reset --hard x': FAIL }).port, '/repo', 'x', '/bun')).toBe(false);
});

// ── helpers ──

test('isGitCheckout / originUrl reflect the port', () => {
  const { port } = scriptPort({
    'git rev-parse --show-toplevel': { code: 0, stdout: '/repo', stderr: '' },
    'git remote get-url origin': { code: 0, stdout: 'git@github.com:x/y.git', stderr: '' },
  });
  expect(isGitCheckout(port, '/repo')).toBe(true);
  expect(originUrl(port, '/repo')).toBe('git@github.com:x/y.git');
});

test('isUpdateCheckDue throttles to the interval', () => {
  const HOUR = 3_600_000;
  expect(isUpdateCheckDue(null, 1000, 6 * HOUR)).toBe(true);          // never checked → due
  expect(isUpdateCheckDue(1000, 1000 + HOUR, 6 * HOUR)).toBe(false);  // 1h ago, interval 6h → not due
  expect(isUpdateCheckDue(1000, 1000 + 6 * HOUR, 6 * HOUR)).toBe(true); // exactly at the interval → due
});
