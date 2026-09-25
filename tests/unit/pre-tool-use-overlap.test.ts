// The work-board overlap warning printed the CALLER's own paths (the worker's `overlapping`) under the peer's session
// id and called every peer "another captain", so two sessions each looked like they were editing the other's files.
// formatOverlapWarning names the PEER's own matching paths and labels whole-repo claims.
import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { formatOverlapWarning } from '../../src/hooks/pre-tool-use.ts';
import { detectRepoRootSync } from '../../src/worker/branch.ts';

test('no overlaps, no warning', () => {
  expect(formatOverlapWarning([])).toBeNull();
});

test('a file hit names the PEER\'s matching paths, and the caller\'s side separately', () => {
  const w = formatOverlapWarning([{
    session_id: '0b5a87fc-17ae-4f3c', agent: 'claude', kind: 'files',
    files: ['/repo/tasks/loader.php', '/repo/notes/list.html'], overlapping: ['/repo/notes/list.html'],
  }])!;
  expect(w).toContain('another session on this captain (0b5a87fc-17a, claude)');
  expect(w).toContain('holds /repo/notes/list.html, which overlaps your /repo/notes/list.html');
  expect(w).not.toContain('another captain');
  expect(w).not.toContain('loader.php');   // only what actually overlaps
});

test('a peer whose only claim is whole-repo is labelled, and my files are not printed as its', () => {
  const w = formatOverlapWarning([{
    session_id: '0b5a87fc', agent: 'claude', kind: 'files', repo_root: '/repo',
    files: ['/repo/**'], overlapping: ['/repo/admin/rpc.php', '/repo/notes/functions.php'],
  }])!;
  expect(w).toContain('holds /repo/**, which overlaps your /repo/admin/rpc.php, /repo/notes/functions.php');
  expect(w).toContain('a whole-repo claim: it ran a shell edit whose file could not be named');
});

test('my own whole-repo claim is labelled as mine', () => {
  const w = formatOverlapWarning([{ session_id: 'p', agent: 'codex', kind: 'files', files: ['/repo/a.ts'], overlapping: ['/repo/**'] }], '/repo')!;
  expect(w).toContain('holds /repo/a.ts, which overlaps your /repo/**');
  expect(w).toContain('your side is a whole-repo claim');
});

test('a topic hit, a repo hit and a semantic hit each read as what they are', () => {
  const w = formatOverlapWarning([
    { session_id: 'topic-1', agent: 'claude', kind: 'topics', overlapping: ['billing-rounding'], what: 'fixing rounding' },
    { session_id: 'repo-1', agent: 'claude', kind: 'repo', overlapping: ['/r'] },
    { session_id: 'sem-1', agent: 'claude', kind: 'semantic', what: 'same idea', similarity: 0.91 },
  ])!;
  expect(w).toContain('holds the same topic: billing-rounding ("fixing rounding")');
  expect(w).toContain('works in the same repository (/r)');
  expect(w).toContain('by meaning: "same idea" (~0.91)');
  expect(w).not.toContain('holds billing-rounding');   // a topic is never printed as a file
});

// #103: a ghost claim (its session ended, the lease is running out) must not read like live work, and when it is
// the only overlap the warning must not tell the caller to go coordinate with it.
test('a stale peer is worded as stale, and only-stale overlaps do not ask the caller to coordinate', () => {
  const ghost = { session_id: 'ghost-1', agent: 'codex', kind: 'topics' as const, overlapping: ['billing'], what: 'x', stale: true, age_s: 47 * 60 };
  const only = formatOverlapWarning([ghost])!;
  expect(only).toContain('(ghost-1, codex; stale, last refreshed 47m ago; its session has probably ended)');
  expect(only).toContain('treat it as information, not a blocker');
  expect(only).not.toContain('coordinate');
  expect(only).not.toContain('continue');   // it can merge with pre-git's advice to isolate a mutating git op
  const mixed = formatOverlapWarning([ghost, { session_id: 'live-1', agent: 'claude', kind: 'topics', overlapping: ['billing'], what: 'y' }])!;
  expect(mixed).toContain('(live-1, claude) holds the same topic');
  expect(mixed).toContain('coordinate');
});

test('a DECLARED directory claim is not called whole-repo, and named files beside a coarse claim drop the caveat', () => {
  const declared = formatOverlapWarning([{ session_id: 'p', agent: 'claude', kind: 'files', repo_root: '/repo', files: ['/repo/billing/**'], overlapping: ['/repo/billing/x.ts'] }], '/repo')!;
  expect(declared).toContain('holds /repo/billing/**');
  expect(declared).not.toContain('whole-repo');
  const mixed = formatOverlapWarning([{ session_id: 'p', agent: 'claude', kind: 'files', repo_root: '/repo', files: ['/repo/**', '/repo/a.ts'], overlapping: ['/repo/a.ts'] }], '/repo')!;
  expect(mixed).not.toContain('whole-repo');
});

test('the hook passes the caller\'s repo root, so its own whole-repo side is labelled', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'cm-overlap-hook-'));
  execSync('git init -q', { cwd: repoDir });
  const root = detectRepoRootSync(repoDir)!;
  const srv = Bun.serve({ port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/worknote/active') return Response.json({ claims: [] });
    if (path === '/worknote/set') return Response.json({ session_id: 'me', ttl_s: 1800, overlaps: [{ session_id: 'peer', agent: 'claude', kind: 'files', files: [`${root}/x.ts`], overlapping: [`${root}/**`] }] });
    return new Response('not found', { status: 404 });
  } });
  try {
    const proc = Bun.spawn(['bun', join(import.meta.dir, '../../src/hooks/pre-tool-use.ts')], {
      stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
      env: { ...process.env, CAPTAIN_MEMO_WORKER_PORT: String(srv.port) },
    });
    proc.stdin.write(JSON.stringify({ session_id: 'me', cwd: repoDir, tool_name: 'Edit', tool_input: { file_path: `${root}/x.ts` } }));
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain('your side is a whole-repo claim');
  } finally {
    srv.stop(true);
    rmSync(repoDir, { recursive: true, force: true });
  }
});
