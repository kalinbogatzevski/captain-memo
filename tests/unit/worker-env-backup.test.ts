// tests/unit/worker-env-backup.test.ts
//
// worker.env carries the user's API keys and settings. An uninstall used to delete it outright, so an
// uninstall + reinstall (a tidy-up, a folder move) sent the owner back through the wizard with their
// keys gone. Now: uninstall moves it to worker.env.bak, install restores from the .bak when the live
// file is missing, and every rewrite copies the previous state aside first.
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { backupWorkerEnv, retireWorkerEnv, restoreWorkerEnvBackup, workerEnvBackupPath } from '../../src/shared/worker-env.ts';

function scratch(): { dir: string; env: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cm-env-bak-'));
  return { dir, env: join(dir, 'worker.env') };
}

test('retire (uninstall) moves the file aside; restore (install) brings it back untouched', () => {
  const { dir, env } = scratch();
  try {
    expect(retireWorkerEnv(env)).toBeNull();                         // nothing to retire
    writeFileSync(env, 'CAPTAIN_MEMO_EMBEDDER=voyage-hosted\nVOYAGE_API_KEY=pa-secret\n');
    const bak = retireWorkerEnv(env)!;
    expect(bak).toBe(workerEnvBackupPath(env));
    expect(existsSync(env)).toBe(false);
    expect(readFileSync(bak, 'utf8')).toContain('pa-secret');
    expect(restoreWorkerEnvBackup(env)).toBe(bak);
    expect(readFileSync(env, 'utf8')).toContain('pa-secret');
    expect(existsSync(bak)).toBe(true);                             // the copy stays until the next rewrite refreshes it
    expect(restoreWorkerEnvBackup(env)).toBeNull();                 // live file present ⇒ never overwritten by a stale .bak
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backup before a rewrite keeps the previous state, one rolling copy', () => {
  const { dir, env } = scratch();
  try {
    expect(backupWorkerEnv(env)).toBeNull();
    writeFileSync(env, 'A=1\n');
    expect(backupWorkerEnv(env)).toBe(env + '.bak');
    writeFileSync(env, 'A=2\n');
    expect(readFileSync(env + '.bak', 'utf8')).toBe('A=1\n');
    if (process.platform !== 'win32') expect(statSync(env + '.bak').mode & 0o777).toBe(0o600);   // keys: owner-only, whatever the live file's mode
    backupWorkerEnv(env);
    expect(readFileSync(env + '.bak', 'utf8')).toBe('A=2\n');       // rolling: the last good state, not a history
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
