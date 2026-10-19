// src/shared/windows-shim.ts — where the Windows `captain-memo.cmd` PATH shim lives, and whether it still works.
//
// `captain-memo install` WRITES it (install.ts windowsCliShim: `bun "<checkout>\src\cli\index.ts" %*`). Before
// v0.44.0 it COPIED the checkout's bin\captain-memo.cmd instead, whose `bun "%~dp0..\src\cli\index.ts" %*` resolves
// the entry point relative to ITSELF — dead once it sits under %LOCALAPPDATA% (`Module not found ...\captain-memo\bin\..\src\cli\index.ts`)
// on an install that was never re-run. `doctor` and the session-start upgrade notice use this to say so.
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { isWindows } from './platform.ts';

/** %LOCALAPPDATA%\captain-memo\bin\captain-memo.cmd — the one path install writes and doctor reads. */
export function windowsCliShimPath(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'captain-memo', 'bin', 'captain-memo.cmd');
}

/** The repair, as typed: it rewrites the shim (and registers the worker task) from the checkout. A stale shim cannot start
 *  `captain-memo doctor` either, so the line also says how to run doctor until the repair is done. */
export const WINDOWS_SHIM_FIX = 'bun src\\cli\\index.ts install --yes   (run it from the captain-memo checkout; `captain-memo doctor` cannot start while the shim is stale, use `bun src\\cli\\index.ts doctor` there)';

export type WindowsShimState = { state: 'ok'; entry: string } | { state: 'stale'; reason: string } | { state: 'unknown' };

/** Judge a shim body: 'stale' when it resolves the entry point with %~dp0 (the pre-0.44.0 copy) or names an entry point
 *  that does not exist; 'ok' when it names one that does; 'unknown' for a body that is not `bun "<path>"` at all (hand-edited:
 *  not ours to judge). `exists` is injectable so the Windows paths can be judged anywhere. */
export function windowsShimState(body: string, exists: (path: string) => boolean = existsSync): WindowsShimState {
  const entry = /^\s*bun\s+"([^"]+)"/im.exec(body)?.[1];
  if (!entry) return { state: 'unknown' };
  if (entry.includes('%~dp0')) return { state: 'stale', reason: 'it locates the entry point relative to itself (%~dp0), which only works inside the checkout\'s bin folder' };
  return exists(entry) ? { state: 'ok', entry } : { state: 'stale', reason: `it points at ${entry}, which does not exist` };
}

/** One line for a person: what is wrong with the shim at `path`, and the fix. */
export function windowsShimStaleText(path: string, reason: string): string {
  return `The captain-memo command on your PATH (${path}) is stale: ${reason}, so \`captain-memo <anything>\` fails with "Module not found". Fix: ${WINDOWS_SHIM_FIX}`;
}

/** The stale-shim line for the installed shim, or null: not Windows, no shim, unreadable, fine, or not judgeable.
 *  Never throws. Arguments are for tests; the defaults are the real shim on a real Windows box. */
export function staleWindowsShimNotice(path: string | null = isWindows ? windowsCliShimPath() : null, exists: (p: string) => boolean = existsSync): string | null {
  if (!path) return null;
  let body: string;
  try { body = readFileSync(path, 'utf-8'); } catch { return null; }
  const s = windowsShimState(body, exists);
  return s.state === 'stale' ? windowsShimStaleText(path, s.reason) : null;
}
