import { afterAll, beforeAll, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

let root: string;
let subfolder: string;
let worktree: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cm-proj-'));
  const repo = join(root, 'acme-app');
  subfolder = join(repo, 'src');
  worktree = join(root, 'acme-app-codex');
  const admin = join(repo, '.git', 'worktrees', 'acme-app-codex');
  mkdirSync(admin, { recursive: true });
  mkdirSync(subfolder, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(admin, 'commondir'), '../..\n');   // as `git worktree add` writes it
  writeFileSync(join(worktree, '.git'), `gitdir: ${admin}\n`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const workerCorpus = 'CAPTAIN_MEMO_PROJECT_ID=default\n';
const workerRepoKey = workerCorpus + 'CAPTAIN_MEMO_PROJECT_KEY="repo"\n';

// CONFIG_DIR is fixed at module load. Only the MCP path loads worker.env before calling the resolver.
function projectFor(cwd: string, workerEnv: string, sessionEnv: Record<string, string> = {}, mcp = false): string {
  const dir = mkdtempSync(join(root, 'config-'));
  writeFileSync(join(dir, 'worker.env'), workerEnv);
  const env: NodeJS.ProcessEnv = { ...process.env, CAPTAIN_MEMO_CONFIG_DIR: dir };
  delete env.CAPTAIN_MEMO_PROJECT_ID;
  delete env.CAPTAIN_MEMO_PROJECT_KEY;
  const src = pathToFileURL(join(import.meta.dir, '../../src')).href;
  const child = Bun.spawnSync(['bun', '-e', `
    ${mcp ? `await import('${src}/mcp-server.ts');` : ''}
    const { resolveProjectId } = await import('${src}/hooks/shared.ts');
    process.stdout.write(resolveProjectId(${JSON.stringify(cwd)}));
  `], { env: { ...env, ...sessionEnv } });
  if (!child.success) throw new Error(child.stderr.toString());
  return child.stdout.toString();
}

test('with the key unset, the folder name is used for a subfolder and worktree', () => {
  expect(projectFor(subfolder, workerCorpus)).toBe('src');
  expect(projectFor(worktree, workerCorpus)).toBe('acme-app-codex');
});

test('the session environment can opt into the repository key', () => {
  expect(projectFor(subfolder, workerCorpus, { CAPTAIN_MEMO_PROJECT_KEY: 'repo' })).toBe('acme-app');
});

test('hooks and the MCP server both honor repo from worker.env', () => {
  expect(projectFor(worktree, workerRepoKey)).toBe('acme-app');
  expect(projectFor(subfolder, workerRepoKey, {}, true)).toBe('acme-app');
});

test('an explicit non-repo session key takes precedence over worker.env', () => {
  expect(projectFor(worktree, workerRepoKey, { CAPTAIN_MEMO_PROJECT_KEY: 'folder' })).toBe('acme-app-codex');
  expect(projectFor(subfolder, workerRepoKey, { CAPTAIN_MEMO_PROJECT_KEY: '' }, true)).toBe('src');
});

test('a CAPTAIN_MEMO_PROJECT_ID set in the session environment still wins', () => {
  expect(projectFor(subfolder, workerRepoKey, { CAPTAIN_MEMO_PROJECT_ID: 'pinned' }, true)).toBe('pinned');
});
