import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Runs in a child process: CONFIG_DIR is a module-load constant, and loadWorkerEnv mutates process.env.
function projectFor(cwd: string, workerEnv: string, sessionEnv: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'cm-proj-'));
  writeFileSync(join(dir, 'worker.env'), workerEnv);
  const src = join(import.meta.dir, '../../src');
  const r = Bun.spawnSync(['bun', '-e',
    `const { loadWorkerEnv } = await import('${src}/shared/worker-env.ts');
     const { resolveProjectId } = await import('${src}/hooks/shared.ts');
     loadWorkerEnv(); process.stdout.write(resolveProjectId(${JSON.stringify(cwd)}));`],
    { env: { ...process.env, CAPTAIN_MEMO_PROJECT_ID: '', ...sessionEnv, CAPTAIN_MEMO_CONFIG_DIR: dir } });
  return r.stdout.toString();
}

test('worker.env CAPTAIN_MEMO_PROJECT_ID=default does not override the session cwd', () => {
  expect(projectFor('/home/u/projects/acme-app', 'CAPTAIN_MEMO_PROJECT_ID=default\n')).toBe('acme-app');
});

test('a CAPTAIN_MEMO_PROJECT_ID set in the session environment still wins', () => {
  expect(projectFor('/home/u/projects/acme-app', 'CAPTAIN_MEMO_PROJECT_ID=default\n', { CAPTAIN_MEMO_PROJECT_ID: 'pinned' })).toBe('pinned');
});
