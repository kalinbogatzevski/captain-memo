// The Windows `captain-memo` command is a .cmd shim COPIED to %LOCALAPPDATA%\captain-memo\bin. The copy in the
// checkout resolves the entry point relative to ITSELF (`%~dp0..\src\cli\index.ts`), which is right in bin\ of
// the checkout and wrong everywhere else — every install whose checkout is not at the default folder got
// `error: Module not found "…\AppData\Local\captain-memo\bin\..\src\cli\index.ts"` (a fleet captain, 2026-09-17).
// The installed shim carries the checkout's ABSOLUTE path instead.
import { test, expect } from 'bun:test';
import { windowsCliShim } from '../../src/cli/commands/install.ts';

test('the installed shim names the checkout absolutely, quoted, and forwards every argument', () => {
  const s = windowsCliShim('C:\\projects\\fleet\\captain-memo');
  expect(s).toContain('bun "C:\\projects\\fleet\\captain-memo\\src\\cli\\index.ts" %*');
  expect(s).not.toContain('%~dp0');
  expect(s.startsWith('@echo off')).toBe(true);
  expect(s.endsWith('\r\n')).toBe(true);                         // cmd.exe wants CRLF
  expect(windowsCliShim('C:\\Users\\a b\\cm')).toContain('bun "C:\\Users\\a b\\cm\\src\\cli\\index.ts" %*');   // spaces stay inside the quotes
});
