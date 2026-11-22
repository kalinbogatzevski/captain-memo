// src/shared/project-key.ts — which project a session's cwd belongs to.
//
// By default observations are tagged with the cwd's last folder name. One repository can show up under many names: each
// worktree (Claude Code's .claude/worktrees/<name>, a Codex run's sibling checkout) and each subfolder a session was
// started in (`src`, `specs`, …) was a project of its own, and no two tools agreed. Measured on one machine
// (2026-11-20): a single repo under 14 names for Claude Code sessions and 3 more for Codex.
//
// The opt-in repo key is the name of the repository the cwd is in: for a linked worktree, the repository it was made from (a
// bare `api.git` keys as `api`). It is read from the `.git` entries on disk without launching git, because it runs on every
// hook. Outside a repository it is the folder name, as before. A repository AT the home folder (a dotfiles checkout) is
// not a project: the walk stops below home.
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve } from 'path';

export interface RepoLocation {
  /** The repository: the working tree holding the real .git directory, or a bare repository's own folder. */
  mainRoot: string;
  /** The working tree the cwd is in: mainRoot, or a linked worktree's folder. */
  worktreeRoot: string;
  /** The repository's git directory (where `worktrees/` lives). */
  commonDir: string;
}

const FOLD = process.platform === 'win32';
const same = (a: string, b: string): boolean => (FOLD ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The default project ID, accepting both Windows and POSIX path separators. */
export function folderProjectKey(cwd: string | undefined): string {
  return cwd?.split(/[\\/]/).filter(Boolean).pop() ?? 'default';
}

function readTrimmed(path: string): string | null {
  try { return readFileSync(path, 'utf-8').trim() || null; } catch { return null; }
}

/** A path read from a git file, relative ones taken from the folder the file is in. */
const fromGitFile = (value: string, baseDir: string): string => (isAbsolute(value) ? resolve(value) : resolve(baseDir, value));

/** Where a `.git` FILE leads. A linked worktree's admin dir has a `commondir`; a submodule's git dir does not. */
function resolveDotGitFile(dir: string, dotGit: string): RepoLocation | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readTrimmed(dotGit) ?? '');
  if (!m?.[1]) return null;
  const admin = fromGitFile(m[1], dir);
  const common = readTrimmed(join(admin, 'commondir'));
  if (!common) return { mainRoot: dir, worktreeRoot: dir, commonDir: admin };   // submodule: its own project
  const commonDir = fromGitFile(common, admin);
  const mainRoot = same(basename(commonDir), '.git') ? dirname(commonDir) : commonDir;   // else bare
  return { mainRoot, worktreeRoot: dir, commonDir };
}

/** Never throws: an unreadable or odd .git entry reads as "not a repository here". */
export function findRepo(cwd: string, home: string = homedir()): RepoLocation | null {
  if (!cwd) return null;
  const stop = resolve(home);
  let dir = resolve(cwd);
  for (;;) {
    if (same(dir, stop)) return null;
    const dotGit = join(dir, '.git');
    try {
      if (existsSync(dotGit)) {
        if (statSync(dotGit).isDirectory()) return { mainRoot: dir, worktreeRoot: dir, commonDir: dotGit };
        const found = resolveDotGitFile(dir, dotGit);
        if (found) return found;
      }
    } catch { /* unreadable: keep walking */ }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const repoName = (mainRoot: string): string => basename(mainRoot).replace(/\.git$/i, '') || basename(mainRoot);

/** The project a cwd belongs to: its repository's name, else its folder name, else 'default'. */
export function projectKey(cwd: string | undefined, home: string = homedir()): string {
  if (!cwd) return 'default';
  const repo = findRepo(cwd, home);
  return (repo ? repoName(repo.mainRoot) : folderProjectKey(cwd)) || 'default';
}

/** The repository's linked worktrees, from <commonDir>/worktrees/<name>/gitdir (each names its worktree's .git). */
function linkedWorktrees(commonDir: string): string[] {
  const admin = join(commonDir, 'worktrees');
  try {
    return readdirSync(admin).flatMap((name) => {
      const target = readTrimmed(join(admin, name, 'gitdir'));
      return target ? [dirname(fromGitFile(target, join(admin, name)))] : [];
    });
  } catch { return []; }
}

/**
 * Everything that identifies the cwd's project, for scoping recall:
 *  - ids:   the repo name, the cwd's folder name, and every linked worktree's folder name, so recall can match
 *           observations tagged under either project key setting;
 *  - roots: the folders that are the project (the cwd, the main tree, every worktree): their per-folder memory is the
 *           project's, and so is an older observation whose files lie inside them.
 */
export function projectAliases(cwd: string, home: string = homedir()): { ids: string[]; roots: string[] } {
  const folder = folderProjectKey(cwd);
  const repo = findRepo(cwd, home);
  if (!repo) return { ids: [folder], roots: [resolve(cwd)] };
  const worktrees = linkedWorktrees(repo.commonDir);
  const ids = new Set<string>([repoName(repo.mainRoot), folder, ...worktrees.map(wt => basename(wt))]);
  const roots = new Set<string>([resolve(cwd), repo.worktreeRoot, repo.mainRoot, ...worktrees]);
  return { ids: [...ids], roots: [...roots] };
}
