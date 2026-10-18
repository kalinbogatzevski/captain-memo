// `connect` and `doctor` follow the CODEX_HOME of the shell; the worker's boot refresh of Codex's tool approvals
// follows worker.env (src/worker/index.ts refreshCodexApprovals). Where they differ, doctor says so.
import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { codexHomeVerdict } from '../../src/cli/commands/doctor.ts';

const HOME = '/home/u';
const WENV = '/home/u/.config/captain-memo/worker.env';
const DEFAULT = join(HOME, '.codex');   // how codexHomeDir builds the default folder: backslashes on Windows, so not a literal '/home/u/.codex'

test('silent when they agree: both unset, both empty, the same folder (quotes, slashes, trailing slash do not matter)', () => {
  expect(codexHomeVerdict(undefined, null, WENV, HOME)).toBeNull();
  expect(codexHomeVerdict('', '', WENV, HOME)).toBeNull();                         // Codex reads an empty CODEX_HOME as unset
  expect(codexHomeVerdict('/data/codex', '/data/codex', WENV, HOME)).toBeNull();
  expect(codexHomeVerdict('/data/codex', '"/data/codex/"', WENV, HOME)).toBeNull();   // loadWorkerEnv strips one pair of quotes
  expect(codexHomeVerdict('D:\\codex', "'D:/codex'", WENV, HOME)).toBeNull();
  expect(codexHomeVerdict('/home/u/.codex', null, WENV, HOME)).toBeNull();           // the shell names the default folder explicitly
});

test('shell sets it, worker.env does not: WARN, names both folders, remedy adds it to worker.env', () => {
  const c = codexHomeVerdict('/data/codex', null, WENV, HOME)!;
  expect(c.status).toBe('WARN');
  expect(c.name).toBe('codex home');
  expect(c.detail).toContain('/data/codex');
  expect(c.detail).toContain(DEFAULT);
  expect(c.detail).toContain(WENV);
  expect(c.remedy).toContain(`add CODEX_HOME=/data/codex to ${WENV}`);
  expect(c.remedy).toContain('captain-memo restart');
});

test('worker.env sets it, the shell does not: WARN, remedy sets it in the shell or removes it from worker.env', () => {
  const c = codexHomeVerdict(undefined, '/srv/codex', WENV, HOME)!;
  expect(c.status).toBe('WARN');
  expect(c.detail).toContain(DEFAULT);
  expect(c.detail).toContain('/srv/codex');
  expect(c.remedy).toContain('set CODEX_HOME to /srv/codex in your shell profile');
  expect(c.remedy).toContain(`remove CODEX_HOME from ${WENV}`);
});

test('both set to different folders: WARN', () => {
  const c = codexHomeVerdict('/a/codex', "'/b/codex'", WENV, HOME)!;
  expect(c.status).toBe('WARN');
  expect(c.detail).toContain('/a/codex');
  expect(c.detail).toContain('/b/codex');
});

test('wired: doctor runs the row, reading worker.env through readWorkerEnvVar and the shell through process.env', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/cli/commands/doctor.ts'), 'utf-8');
  expect(src.slice(src.indexOf('export async function doctorCommand('))).toContain('  checkCodexHome();');
  expect(src).toMatch(/codexHomeVerdict\(process\.env\.CODEX_HOME, readWorkerEnvVar\('CODEX_HOME'\)/);
});
