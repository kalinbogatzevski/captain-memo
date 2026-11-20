// src/shared/project-key.ts — which project a session's cwd belongs to.
//
// Observations used to be tagged with the cwd's last folder name. One repository then showed up under many names: each
// worktree (Claude Code's .claude/worktrees/<name>, a Codex run's sibling checkout) and each subfolder a session was
// started in (`src`, `specs`, …) was a project of its own, and no two tools agreed. Measured on one machine
// (2026-11-20): a single repo under 14 names for Claude Code sessions and 3 more for Codex.
//
// The key is now the name of the repository the cwd is in: for a worktree, the repository it was made from. It is read
// from the `.git` entries on disk, no git process, because it runs on every hook. Outside a repository it is the folder
// name, as before. A repository AT the home folder (a dotfiles checkout) is not a project: the walk stops below home.
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve } from 'path';

export interface RepoLocation {
  /** The repository's own working tree (the one holding the real .git directory). */
  mainRoot: string;
  /** The working tree the cwd is in: mainRoot, or a linked worktree's folder. */
  worktreeRoot: string;
}

const WORKTREE_ADMIN = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/;

function lastSegment(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/** Never throws: an unreadable or odd .git entry reads as "not a repository here". */
export function findRepo(cwd: string, home: string = homedir()): RepoLocation | null {
  if (!cwd) return null;
  const stop = resolve(home);
  let dir = resolve(cwd);
  for (;;) {
    if (dir === stop) return null;
    const dotGit = join(dir, '.git');
    try {
      if (existsSync(dotGit)) {
        if (statSync(dotGit).isDirectory()) return { mainRoot: dir, worktreeRoot: dir };
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf-8'));
        if (m?.[1]) {
          const admin = isAbsolute(m[1]) ? m[1] : resolve(dir, m[1]);
          const wt = WORKTREE_ADMIN.exec(admin);
          // A linked worktree points into <main>/.git/worktrees/<name>; anything else (a submodule) is its own project.
          return { mainRoot: wt?.[1] ? resolve(wt[1]) : dir, worktreeRoot: dir };
        }
      }
    } catch { /* unreadable: keep walking */ }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The project a cwd belongs to: its repository's name, else its folder name, else 'default'. */
export function projectKey(cwd: string | undefined, home: string = homedir()): string {
  if (!cwd) return 'default';
  const repo = findRepo(cwd, home);
  return (repo ? basename(repo.mainRoot) : lastSegment(cwd)) || 'default';
}

/** The repository's linked worktrees, from <main>/.git/worktrees/<name>/gitdir (each names its worktree's .git). */
function linkedWorktrees(mainRoot: string): string[] {
  const admin = join(mainRoot, '.git', 'worktrees');
  try {
    return readdirSync(admin).flatMap((name) => {
      try {
        const target = readFileSync(join(admin, name, 'gitdir'), 'utf-8').trim();
        return target ? [dirname(target)] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

/**
 * Everything that identifies the cwd's project, for scoping recall:
 *  - ids:   the project key, plus the folder names older observations were tagged with (the cwd and its parents up to
 *           its working-tree root, and every linked worktree's folder name);
 *  - roots: the folders whose per-folder memory belongs to the project (the cwd, the main tree, every worktree).
 */
export function projectAliases(cwd: string, home: string = homedir()): { ids: string[]; roots: string[] } {
  const repo = findRepo(cwd, home);
  if (!repo) return { ids: [lastSegment(cwd) || 'default'], roots: [cwd] };
  const ids = new Set<string>([basename(repo.mainRoot)]);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    ids.add(basename(dir));
    if (dir === repo.worktreeRoot || dirname(dir) === dir) break;
  }
  const worktrees = linkedWorktrees(repo.mainRoot);
  for (const wt of worktrees) ids.add(basename(wt));
  const roots = [...new Set([cwd, repo.worktreeRoot, repo.mainRoot, ...worktrees])];
  return { ids: [...ids], roots };
}
