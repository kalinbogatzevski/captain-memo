// tests/unit/sqlite-extensions.test.ts
//
// macOS ships Apple's libsqlite3 built with SQLITE_OMIT_LOAD_EXTENSION, and Bun links
// against the system library — so `vec0` cannot load and the worker dies on its first
// vector open. Reported 2026-07-28: the LaunchAgent was healthy and launchd relaunched it
// faithfully, forever, while the real error scrolled past as
// "This build of sqlite3 does not support dynamic extension loading".

import { test, expect } from 'bun:test';
import {
  ensureExtensionCapableSqlite, isExtensionLoadingUnsupported,
  MACOS_SQLITE_CANDIDATES, MACOS_SQLITE_REMEDY, _resetSqliteExtensionProbe,
} from '../../src/shared/sqlite-extensions.ts';

test('the probe is a no-op off macOS, and never throws', () => {
  _resetSqliteExtensionProbe();
  // On Linux/Windows Bun bundles its own extension-capable SQLite; forcing a custom one
  // would be a regression, not a fix.
  expect(() => ensureExtensionCapableSqlite()).not.toThrow();
  if (process.platform !== 'darwin') expect(ensureExtensionCapableSqlite()).toBeNull();
});

test('the probe is memoised — setCustomSQLite is global and one-shot', () => {
  _resetSqliteExtensionProbe();
  const a = ensureExtensionCapableSqlite();
  const b = ensureExtensionCapableSqlite();
  expect(b).toBe(a);
});

test('the candidate list covers both Homebrew prefixes', () => {
  // sqlite is keg-only, so it is NOT symlinked into /opt/homebrew/lib — the versioned
  // opt path is the one that exists on a normal install. Miss it and the probe finds
  // nothing on a machine that is correctly set up.
  expect(MACOS_SQLITE_CANDIDATES.some(p => p.startsWith('/opt/homebrew/opt/sqlite/'))).toBe(true);
  expect(MACOS_SQLITE_CANDIDATES.some(p => p.startsWith('/usr/local/opt/sqlite/'))).toBe(true);
  expect(MACOS_SQLITE_CANDIDATES.every(p => p.endsWith('.dylib'))).toBe(true);
});

test('the failure is recognised whatever wording the build used', () => {
  expect(isExtensionLoadingUnsupported(new Error('This build of sqlite3 does not support dynamic extension loading'))).toBe(true);
  expect(isExtensionLoadingUnsupported(new Error('not authorized'))).toBe(true);
  expect(isExtensionLoadingUnsupported(new Error('disk I/O error'))).toBe(false);
  expect(isExtensionLoadingUnsupported(null)).toBe(false);
});

test('the remedy names the actual command, not a description of the problem', () => {
  // The bare error points at sqlite-vec internals and gives a user nothing to do. What
  // makes it actionable is one line they can paste.
  expect(MACOS_SQLITE_REMEDY).toContain('brew install sqlite');
  expect(MACOS_SQLITE_REMEDY).toContain('captain-memo restart');
});
