import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Resolve the current git branch for a working directory.
 * Returns null when:
 *   - the path doesn't exist
 *   - the path is not inside a git repo
 *   - git is not installed
 *   - any error occurs (we never throw — branch capture is best-effort)
 *
 * Detached HEAD returns the literal "HEAD" — that's what `git rev-parse
 * --abbrev-ref HEAD` produces in that state. We store it as-is rather than
 * inventing a different convention.
 */
export function detectBranchSync(cwd: string): string | null {
  if (!existsSync(cwd)) return null;
  try {
    const result = spawnSync(
      'git',
      ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf-8', timeout: 2000 },
    );
    if (result.status !== 0) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
