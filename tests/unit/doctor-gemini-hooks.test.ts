import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// The helper (geminiHooksToggleRejected) is tested in cross-ai.test.ts; this proves `doctor` actually runs it.
// A real `captain-memo doctor` in a scratch HOME, with a fake `gemini` as the only thing on PATH (no claude, git or
// systemctl, and worker port 1 so the live worker is never probed). POSIX only: the fake is a /bin/sh script.
const root = mkdtempSync(join(tmpdir(), 'cm-doctor-gemini-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cli = join(import.meta.dir, '../../bin/captain-memo');

function doctor(name: string, settings: object): { line: string | undefined; out: string; probed: string | null } {
  const home = join(root, name, 'home'), bin = join(root, name, 'bin'), args = join(root, name, 'args');
  mkdirSync(join(home, '.gemini'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify(settings));
  writeFileSync(join(bin, 'gemini'), `#!/bin/sh\necho "$@" >> '${args}'\necho 0.99.1\n`);
  chmodSync(join(bin, 'gemini'), 0o755);
  const r = Bun.spawnSync([process.execPath, cli, 'doctor'], {
    env: { HOME: home, PATH: bin, CAPTAIN_MEMO_WORKER_PORT: '1', CAPTAIN_MEMO_DISABLE_SELF_HEAL: '1' },
  });
  const out = r.stdout.toString().replace(/\x1b\[[0-9;]*m/g, '');
  const lines = out.split('\n');
  const i = lines.findIndex(l => l.includes('gemini hooks'));
  return { line: i < 0 ? undefined : `${lines[i]}\n${lines[i + 1]}`, out, probed: existsSync(args) ? readFileSync(args, 'utf-8') : null };
}

test.skipIf(process.platform === 'win32')('doctor probes the gemini on PATH and warns, with its version and the connect remedy, about a boolean hooks.enabled', () => {
  const old = doctor('old', { hooks: { enabled: true } });
  expect(old.probed, old.out).toBe('--version\n');
  expect(old.line, old.out).toBeDefined();
  expect(old.line).toMatch(/^\s*! gemini hooks\s+~\/\.gemini\/settings\.json has hooks\.enabled, which \S+\/bin\/gemini 0\.99\.1 rejects at every start\n\s*→ captain-memo connect /);

  // The shape connect writes now: nothing to report, and the version is never asked for.
  const current = doctor('current', { tools: { enableHooks: true }, hooksConfig: { enabled: true } });
  expect(current.out).toContain('remember / promote');   // doctor ran to its report
  expect(current.line).toBeUndefined();
  expect(current.probed).toBeNull();
}, 30_000);
