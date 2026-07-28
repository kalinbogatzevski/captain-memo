// src/shared/sqlite-extensions.ts — make SQLite able to load extensions on macOS.
//
// macOS ships Apple's own libsqlite3 with SQLITE_OMIT_LOAD_EXTENSION, and Bun links
// against the system library by default. Any attempt to load `vec0` therefore dies with:
//
//   error: This build of sqlite3 does not support dynamic extension loading
//       at load (node_modules/sqlite-vec/index.mjs:44)
//       at new VectorStore (src/worker/vector-store.ts)
//
// which is what the first macOS install hit (2026-07-28) — the LaunchAgent was healthy,
// launchd relaunched it faithfully, and the worker died on its first vector open every
// time. Bun's escape hatch is Database.setCustomSQLite(), pointing at a build that keeps
// extension loading in — Homebrew's does.
//
// MUST run before the first Database is opened in the process: setCustomSQLite is
// global and Bun ignores it once a connection exists. Call it at worker startup.
//
// Linux and Windows are unaffected: Bun bundles its own SQLite there, extensions and all.

import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { isMac } from './platform.ts';

/** Where Homebrew puts a extension-capable libsqlite3, newest layout first.
 *  `sqlite` is keg-only, so it is NOT symlinked into /opt/homebrew/lib — the versioned
 *  opt path is the one that actually exists on a normal install. */
export const MACOS_SQLITE_CANDIDATES = [
  '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',   // Apple Silicon
  '/usr/local/opt/sqlite/lib/libsqlite3.dylib',      // Intel
  '/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib',
  '/usr/local/opt/sqlite3/lib/libsqlite3.dylib',
];

/** The remedy, as one string, so the worker log and the CLI say the same thing. */
export const MACOS_SQLITE_REMEDY =
  'macOS ships SQLite without extension support, so the vector index cannot load.\n'
  + '  Fix:  brew install sqlite\n'
  + '  Then: captain-memo restart\n'
  + '  (Or install with the embedder set to "skip" for keyword-only retrieval, which needs no extension.)';

let applied: string | null | undefined;   // undefined = not tried, null = nothing found

/**
 * Point Bun at an extension-capable SQLite when the platform needs it. Idempotent, and a
 * no-op off macOS. Returns the library path adopted, or null when none was found — the
 * caller decides whether that is fatal, because a keyword-only install never loads vec0
 * and must not be blocked by a missing Homebrew.
 */
export function ensureExtensionCapableSqlite(): string | null {
  if (applied !== undefined) return applied;
  if (!isMac) { applied = null; return null; }
  for (const path of MACOS_SQLITE_CANDIDATES) {
    if (!existsSync(path)) continue;
    try {
      Database.setCustomSQLite(path);
      applied = path;
      return path;
    } catch {
      // Wrong architecture, or a connection was already opened. Keep looking; the caller
      // still gets an actionable message if nothing works.
    }
  }
  applied = null;
  return null;
}

/** TEST-ONLY: forget the memoised result so a test can exercise the probe again. */
export function _resetSqliteExtensionProbe(): void { applied = undefined; }

/** True when the message is SQLite refusing to load extensions, whatever wording the
 *  underlying build used. Kept here so the worker and the CLI classify it identically. */
export function isExtensionLoadingUnsupported(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err ?? '');
  return /does not support dynamic extension loading|not authorized|enable_load_extension/i.test(m);
}
