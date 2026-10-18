// src/shared/windows-shim.ts — where the Windows `captain-memo.cmd` PATH shim lives.
//
// `captain-memo install` WRITES it (install.ts windowsCliShim: `bun "<checkout>\src\cli\index.ts" %*`).
import { homedir } from 'os';
import { join } from 'path';

/** %LOCALAPPDATA%\captain-memo\bin\captain-memo.cmd — the one path install writes. */
export function windowsCliShimPath(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'captain-memo', 'bin', 'captain-memo.cmd');
}
