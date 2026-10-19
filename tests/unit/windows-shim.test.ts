// A Windows PATH shim written before v0.44.0 is a COPY of bin\captain-memo.cmd (`%~dp0..\src\...`) and is dead under
// %LOCALAPPDATA% ("Module not found ...\captain-memo\bin\..\src\cli\index.ts"); doctor and the update announcement must say so.
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { windowsCliShim } from '../../src/cli/commands/install.ts';
import { windowsShimCheck } from '../../src/cli/commands/doctor.ts';
import { windowsCliShimPath, windowsShimState, staleWindowsShimNotice, WINDOWS_SHIM_FIX } from '../../src/shared/windows-shim.ts';

const root = mkdtempSync(join(tmpdir(), 'cm-win-shim-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const DIR = 'C:\\projects\\captain-memo';
const ENTRY = `${DIR}\\src\\cli\\index.ts`;
// What the installer put on PATH before 0.44.0: a copy of the checkout's bin\captain-memo.cmd, comments abridged (git show b683be0f:bin/captain-memo.cmd).
const COPIED = '@echo off\r\nREM Windows CLI shim for captain-memo. Invokes Bun directly on the TypeScript\r\nREM entry point.\r\nbun "%~dp0..\\src\\cli\\index.ts" %*\r\n';

test('the shim install writes today is judged ok when its entry point exists, stale when it does not', () => {
  expect(windowsShimState(windowsCliShim(DIR), (p) => p === ENTRY)).toEqual({ state: 'ok', entry: ENTRY });
  expect(windowsShimState(windowsCliShim('C:\\Users\\a b\\cm'), (p) => p === 'C:\\Users\\a b\\cm\\src\\cli\\index.ts')).toEqual({ state: 'ok', entry: 'C:\\Users\\a b\\cm\\src\\cli\\index.ts' });
  const gone = windowsShimState(windowsCliShim(DIR), () => false);
  expect(gone.state).toBe('stale');
  expect(gone.state === 'stale' && gone.reason).toContain(`${ENTRY}, which does not exist`);
});

test('the pre-0.44.0 copy (and the checkout\'s own bin file) is stale by its %~dp0, whatever exists', () => {
  for (const body of [COPIED, readFileSync(join(import.meta.dir, '../../bin/captain-memo.cmd'), 'utf-8')]) {
    const s = windowsShimState(body, () => true);
    expect(s.state).toBe('stale');
    expect(s.state === 'stale' && s.reason).toContain('%~dp0');
  }
});

// The file the old installer really copied (git show b683be0f:bin/captain-memo.cmd): LF endings and longer REM lines than COPIED above;
// a checkout with autocrlf carries it with CRLF. Either way the %~dp0 line must be read as stale, never as "not ours to judge".
const HISTORIC = [
  '@echo off',
  'REM Windows CLI shim for captain-memo. Invokes Bun directly on the TypeScript',
  'REM entry point so there is no dependency on shebang dispatch (which cmd/PowerShell',
  "REM cannot honor). %~dp0 is this file's directory (\u2026\\bin\\); the source sits one",
  'REM level up. Quotes guard against spaces in the install path. Requires bun on PATH.',
  'bun "%~dp0..\\src\\cli\\index.ts" %*',
  '',
].join('\n');

test('the real pre-0.44.0 file, with LF or CRLF endings, is stale: the doctor row WARNs with the fix, even where the path exists', () => {
  for (const body of [HISTORIC, HISTORIC.replace(/\n/g, '\r\n')]) {
    expect(windowsShimState(body, () => true).state).toBe('stale');
    const row = windowsShimCheck('C:\\Users\\x\\AppData\\Local\\captain-memo\\bin\\captain-memo.cmd', body, () => true)!;
    expect(row.status).toBe('WARN');
    expect(row.remedy).toContain('install --yes');
  }
});

test('a body that is not `bun "<path>"` is not ours to judge', () => {
  expect(windowsShimState('@echo off\r\nC:\\tools\\bun.exe C:\\mine\\cm.ts %*\r\n', () => false)).toEqual({ state: 'unknown' });
  expect(windowsShimState('', () => false)).toEqual({ state: 'unknown' });
});

test('doctor row: WARN with the install fix for a stale shim, PASS for a good one, nothing for no shim or a hand-edited one', () => {
  const P = 'C:\\Users\\x\\AppData\\Local\\captain-memo\\bin\\captain-memo.cmd';
  const stale = windowsShimCheck(P, COPIED, () => true)!;
  expect(stale.status).toBe('WARN');
  expect(stale.detail).toContain(P);
  expect(stale.detail).toContain('%~dp0');
  expect(stale.detail).toContain('Module not found');
  expect(stale.remedy).toBe(WINDOWS_SHIM_FIX);
  expect(stale.remedy).toContain('bun src\\cli\\index.ts doctor');   // the stale command cannot start `captain-memo doctor`: the line says how to run it
  expect(WINDOWS_SHIM_FIX).toContain('bun src\\cli\\index.ts install --yes');
  expect(windowsShimCheck(P, windowsCliShim(DIR), () => false)!.status).toBe('WARN');   // names a checkout that is gone
  const good = windowsShimCheck(P, windowsCliShim(DIR), () => true)!;
  expect(good.status).toBe('PASS');
  expect(good.detail).toContain(ENTRY);
  expect(windowsShimCheck(P, null, () => true)).toBeNull();
  expect(windowsShimCheck(P, 'echo hi', () => true)).toBeNull();
});

test('the update notice: the stale file gives one line with the fix; a good, missing or foreign one gives none; off Windows it never looks', () => {
  const stale = join(root, 'stale.cmd'), good = join(root, 'good.cmd');
  writeFileSync(stale, COPIED);
  writeFileSync(good, windowsCliShim(DIR));
  const note = staleWindowsShimNotice(stale, () => true)!;
  expect(note).toContain(stale);
  expect(note).toContain('stale');
  expect(note).toContain(WINDOWS_SHIM_FIX);
  expect(note).toContain('bun src\\cli\\index.ts doctor');
  expect(note).not.toContain('\n');
  expect(staleWindowsShimNotice(good, () => true)).toBeNull();
  expect(staleWindowsShimNotice(good, () => false)).toContain('does not exist');
  expect(staleWindowsShimNotice(join(root, 'absent.cmd'), () => true)).toBeNull();
  if (process.platform !== 'win32') expect(staleWindowsShimNotice()).toBeNull();   // the default path is null off Windows
});

test('windowsCliShimPath is the folder install writes: %LOCALAPPDATA%\\captain-memo\\bin, else <home>\\AppData\\Local', () => {
  expect(windowsCliShimPath({ LOCALAPPDATA: join(root, 'la') }, '/h')).toBe(join(root, 'la', 'captain-memo', 'bin', 'captain-memo.cmd'));
  expect(windowsCliShimPath({}, '/h')).toBe(join('/h', 'AppData', 'Local', 'captain-memo', 'bin', 'captain-memo.cmd'));
});

// --- wiring pins: the three readers/writers are really connected ------------------------------------------------
test('wired: install writes to windowsCliShimPath(), doctor runs the row, the session-start notices carry the shim line', () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, '../..', rel), 'utf-8');
  expect(read('src/cli/commands/install.ts')).toContain('path: windowsCliShimPath()');
  const doctor = read('src/cli/commands/doctor.ts');
  expect(doctor.slice(doctor.indexOf('export async function doctorCommand('))).toContain('  checkWindowsShim();');
  expect(doctor).toMatch(/function checkWindowsShim\(\): void \{\s*if \(!isWindows\) return;/);
  const hook = read('src/hooks/session-start.ts');
  expect(hook).toContain('[autoUpdateNotice, upgradeNotice, shimNotice]');
  expect(hook).toMatch(/const shimNotice = \(autoUpdateNotice \|\| upgrade\) \? \(staleWindowsShimNotice\(\) \?\? ''\) : '';/);
});
