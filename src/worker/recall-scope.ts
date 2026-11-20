// src/worker/recall-scope.ts — keep the auto-injected <memory-context> to the project the prompt came from.
//
// The corpus is shared across every project on the machine, which is the point for explicit search. Auto-recall is
// different: it fires on every prompt, unasked, and 5 slots go a long way towards the wrong project's notes. A session
// in one repo was handed another repo's ad budgets, a third repo's business rules and a test password, because each
// was the nearest match by meaning. The hook already sends the session's project; the worker never looked at it.
//
// CAPTAIN_MEMO_RECALL_SCOPE=project drops a hit only when it is KNOWN to belong to another project:
//   - an observation whose project_id is set (not 'default') and is none of the session project's ids (its repository's
//     name, or a folder name an older observation of the same repository was tagged with: see project-key.ts);
//   - a Claude Code per-project memory file (<claude projects dir>/<slug>/memory/…) whose slug is not that of the
//     session's cwd, its repository, one of the repository's worktrees, or a parent folder of these;
//   - a repo-level instruction file found under ~/<code root>/<repo>/ (the auto-discovery roots) when none of those
//     folders is inside <repo>.
// Everything else (skills, capabilities, user-global memory, custom globs) has no owning project and stays. Unset, the
// recall is exactly what it was. Explicit search (search_all, /search) is not scoped by this setting.
import { homedir } from 'os';
import { claudeProjectsDir, projectSlugFromCwd } from '../shared/paths.ts';
import { REPO_ROOT_NAMES } from '../shared/ai-memory-sources.ts';

export type RecallScope = 'all' | 'project';

export const ENV_RECALL_SCOPE = 'CAPTAIN_MEMO_RECALL_SCOPE';

export function resolveRecallScope(env: Record<string, string | undefined> = process.env): RecallScope {
  return env[ENV_RECALL_SCOPE]?.trim().toLowerCase() === 'project' ? 'project' : 'all';
}

export interface ScopeContext {
  /** The session's working directory, as the hook received it. Empty → nothing is filtered. */
  cwd: string;
  /** Every id the session's observations may be tagged with (project-key.ts projectAliases().ids). Unset: the
   *  cwd's last folder name. */
  projectIds?: string[];
  /** Folders whose per-folder memory is the session's: its cwd, repository and worktrees. Unset: just the cwd. */
  roots?: string[];
  home?: string;
  claudeProjectsDir?: string;
  /** Windows paths compare case-insensitively. Defaults to the platform. */
  caseInsensitive?: boolean;
}

interface ScopableHit {
  channel: string;
  source_path: string;
  metadata?: Record<string, unknown>;
}

/** Forward slashes, no trailing slash, folded case where the filesystem folds it. */
function norm(p: string, fold: boolean): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return fold ? s.toLowerCase() : s;
}

/** The cwd and each of its parents, normalized: `/a/b/c` → [`/a/b/c`, `/a/b`, `/a`]. */
function selfAndParents(cwd: string): string[] {
  const out: string[] = [];
  let cur = cwd;
  while (cur) {
    out.push(cur);
    const cut = cur.lastIndexOf('/');
    if (cut <= 0) break;
    cur = cur.slice(0, cut);
  }
  return out;
}

const isInside = (dir: string, owner: string): boolean => dir === owner || dir.startsWith(owner + '/');

export function filterHitsToProject<T extends ScopableHit>(hits: T[], ctx: ScopeContext): T[] {
  if (!ctx.cwd) return hits;
  const fold = ctx.caseInsensitive ?? process.platform === 'win32';
  const cwd = norm(ctx.cwd, fold);
  const projectsDir = norm(ctx.claudeProjectsDir ?? claudeProjectsDir(), fold);
  const home = norm(ctx.home ?? homedir(), fold);
  const roots = (ctx.roots?.length ? ctx.roots : [ctx.cwd]).map(r => norm(r, fold));
  const ownSlugs = new Set(roots.flatMap(selfAndParents).map(projectSlugFromCwd));
  const codeRoots = REPO_ROOT_NAMES.map(name => `${home}/${fold ? name.toLowerCase() : name}/`);
  const ids = ctx.projectIds?.length ? ctx.projectIds : [cwd.slice(cwd.lastIndexOf('/') + 1)];
  const ownIds = new Set(ids.map(id => fold ? id.toLowerCase() : id));

  const belongsElsewhere = (hit: T): boolean => {
    if (hit.channel === 'observation') {
      const tag = hit.metadata?.project_id;
      if (typeof tag !== 'string' || tag === '' || tag === 'default') return false;
      return !ownIds.has(fold ? tag.toLowerCase() : tag);
    }
    if (hit.channel !== 'memory') return false;
    const path = norm(hit.source_path, fold);
    if (path.startsWith(projectsDir + '/')) {
      const [slug, sub] = path.slice(projectsDir.length + 1).split('/');
      if (sub !== 'memory' || !slug) return false;
      return !ownSlugs.has(slug);
    }
    for (const root of codeRoots) {
      if (!path.startsWith(root)) continue;
      const repo = path.slice(root.length).split('/')[0];
      if (!repo) return false;
      return !roots.some(r => isInside(r, root + repo));
    }
    return false;
  };

  return hits.filter(h => !belongsElsewhere(h));
}
