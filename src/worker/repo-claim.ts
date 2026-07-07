// src/worker/repo-claim.ts — classify a work-claim's files into an optional shared-repo stamp.
// A claim gets {repo_root, branch, is_dirty} ONLY when its first ABSOLUTE path resolves to a real
// git checkout whose root is not a per-session scratchpad (…/claude-1000/…). Relative globs and
// scratchpad paths get no stamp, so they stay plain file-claims (no false cross-session overlaps).
import { detectRepoRootSync as _root, detectBranchSync as _branch, detectDirtySync as _dirty } from './branch.ts';
import { dirname, isAbsolute } from 'node:path';

export interface RepoClaimDeps {
  detectRepoRootSync: (cwd: string) => string | null;
  detectBranchSync: (cwd: string) => string | null;
  detectDirtySync: (repoRoot: string) => { is_dirty: boolean; staged: boolean };
}
const DEFAULT: RepoClaimDeps = { detectRepoRootSync: _root, detectBranchSync: _branch, detectDirtySync: _dirty };

/** The current per-session scratchpad convention. A repo root under this is NOT a shared resource. */
function isScratchpad(root: string): boolean { return root.includes('/claude-1000/'); }

export function resolveRepoClaim(files: string[], deps: RepoClaimDeps = DEFAULT): { repo_root?: string; branch?: string; is_dirty?: boolean } {
  for (const f of files ?? []) {
    if (typeof f !== 'string' || !isAbsolute(f)) continue;      // only absolute paths resolve a repo
    const root = deps.detectRepoRootSync(dirname(f));
    if (!root || isScratchpad(root)) continue;                  // no repo, or a scratchpad → not shared
    // exactOptionalPropertyTypes: only include `branch` when resolved (never assign it `undefined` explicitly).
    const branch = deps.detectBranchSync(root);
    return { repo_root: root, ...(branch ? { branch } : {}), is_dirty: deps.detectDirtySync(root).is_dirty };
  }
  return {};
}
