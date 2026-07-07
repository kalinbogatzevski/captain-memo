import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { spawn } from 'bun';
import { parseGitOp } from '../../src/hooks/pre-git.ts';
import { detectRepoRootSync } from '../../src/worker/branch.ts';

test('parseGitOp detects mutating subcommands, ignores read-only + non-git', () => {
  expect(parseGitOp('git checkout master')).toBe('checkout');
  expect(parseGitOp('git switch -c feat')).toBe('switch');
  expect(parseGitOp('cd /proj && git commit -m x')).toBe('commit');
  expect(parseGitOp('GIT_PAGER=cat git reset --hard')).toBe('reset');
  expect(parseGitOp('git status')).toBeNull();
  expect(parseGitOp('git log --oneline')).toBeNull();
  expect(parseGitOp('ls -la')).toBeNull();
  expect(parseGitOp('echo git commit')).toBeNull();   // not an invoked git
});

test('parseGitOp skips value-taking global flags (-C <dir>, -c <name=value>) to find the subcommand', () => {
  expect(parseGitOp('git -C /repo checkout main')).toBe('checkout');
  expect(parseGitOp('git -c user.name=x commit')).toBe('commit');
});

// ─── runPreGit's warning branch (acceptance criterion #2) ──────────────────
// pre-git.ts exports no standalone entrypoint of its own — production reaches
// runPreGit() via pre-tool-use.ts's dispatch (tool_name === 'Bash'). Drive it the
// same way tests/hooks/*.test.ts drive every other hook: spawn the real hook
// process against a stub worker (CAPTAIN_MEMO_WORKER_PORT) and read its actual
// stdout — no mocking of writeStdout/workerFetch internals.

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Captain Memo Test',
  GIT_AUTHOR_EMAIL: 'test@captain-memo.local',
  GIT_COMMITTER_NAME: 'Captain Memo Test',
  GIT_COMMITTER_EMAIL: 'test@captain-memo.local',
};
function git(cmd: string, dir: string): void {
  execSync(cmd, { cwd: dir, env: GIT_ENV });
}

const PRE_TOOL_USE_HOOK_PATH = join(import.meta.dir, '../../src/hooks/pre-tool-use.ts');
const SELF_SESSION = 'self-session-abc';

let repoDir: string;
let repoRoot: string;
let server: ReturnType<typeof Bun.serve>;
let port = 0;
// Mutated per-test to control the stub's /worknote/repo-active response.
let stubHolders: unknown[] | 'not-found' = [];

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'cm-pre-git-hook-'));
  git('git init -b main', repoDir);
  git('git commit --allow-empty -m init', repoDir);
  repoRoot = detectRepoRootSync(repoDir)!;

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/worknote/repo-active') {
        if (stubHolders === 'not-found') return new Response('nope', { status: 404 });
        return Response.json({ holders: stubHolders });
      }
      return new Response('not found', { status: 404 });
    },
  });
  port = server.port ?? 0;
});

afterAll(() => {
  server.stop();
  rmSync(repoDir, { recursive: true, force: true });
});

async function runPreToolUseHook(payload: unknown, env: Record<string, string> = {}): Promise<string> {
  const proc = spawn({
    cmd: ['bun', PRE_TOOL_USE_HOOK_PATH],
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, CAPTAIN_MEMO_WORKER_PORT: String(port), ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

function gitOpPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SELF_SESSION,
    cwd: repoDir,
    tool_name: 'Bash',
    tool_input: { command: 'git checkout main' },
    ...overrides,
  };
}

test('runPreGit — a PEER holder of the repo emits an advisory additionalContext warning', async () => {
  stubHolders = [{ session_id: 'peer-session-999', agent: 'claude', branch: 'feature/x', is_dirty: true }];
  const stdout = await runPreToolUseHook(gitOpPayload());
  expect(stdout).toContain('additionalContext');
  expect(stdout).toContain(repoRoot);
  expect(stdout).toContain('peer-session');
});

test('runPreGit — a SELF-ONLY holder (same session_id as the payload) is silent', async () => {
  stubHolders = [{ session_id: SELF_SESSION, agent: 'claude' }];
  const stdout = await runPreToolUseHook(gitOpPayload());
  expect(stdout).toBe('');
});

test('runPreGit — worker responds non-ok (e.g. 404) fails open, silent', async () => {
  stubHolders = 'not-found';
  const stdout = await runPreToolUseHook(gitOpPayload());
  expect(stdout).toBe('');
});

test('runPreGit — worker unreachable fails open, silent', async () => {
  stubHolders = [];
  const stdout = await runPreToolUseHook(gitOpPayload(), { CAPTAIN_MEMO_WORKER_PORT: '1' });
  expect(stdout).toBe('');
});
