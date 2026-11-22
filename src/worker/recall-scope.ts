// src/worker/recall-scope.ts — keep the auto-injected <memory-context> to the project the prompt came from.
//
// The corpus is shared across every project on the machine, which is the point for explicit search. Auto-recall is
// different: it fires on every prompt, unasked, and 5 slots go a long way towards the wrong project's notes. A session
// in one repo was handed another repo's ad budgets, a third repo's business rules and a test password, because each
// was the nearest match by meaning. The hook already sends the session's project; the worker never looked at it.
//
// CAPTAIN_MEMO_RECALL_SCOPE=project drops a hit only when it is KNOWN to belong to another project:
//   - an observation whose project_id is set (not 'default' or the worker's own corpus id) and is none of the session
//     project's ids (its repository, cwd or worktree folder names: see project-key.ts), unless a
//     file it read or modified lies inside the project (how an older observation, tagged with a subfolder or a since
//     deleted worktree, is still recognised);
//   - a Claude Code per-project memory file (<claude projects dir>/<slug>/memory/…) whose slug is not that of the
//     session's cwd, its repository, one of the repository's worktrees, or a parent folder of these;
//   - a repo-level instruction file under ~/<code root>/<repo>/ (the roots auto-discovery probes: ~/projects, ~/code, …)
//     when none of those folders is inside <repo>.
// Everything else (skills, capabilities, user-global memory, any file from a custom glob, observations with no project)
// has no known owner and stays. Unset, the
// recall is exactly what it was. Explicit search (search_all, /search) is not scoped by this setting.
import { homedir } from 'os';
import { claudeProjectsDir, projectSlugFromCwd } from '../shared/paths.ts';
import { REPO_ROOT_NAMES } from '../shared/ai-memory-sources.ts';
import { projectAliases } from '../shared/project-key.ts';

export type RecallScope = 'all' | 'project';

export const ENV_RECALL_SCOPE = 'CAPTAIN_MEMO_RECALL_SCOPE';

export function resolveRecallScope(env: Record<string, string | undefined> = process.env): RecallScope {
  return env[ENV_RECALL_SCOPE]?.trim().toLowerCase() === 'project' ? 'project' : 'all';
}

export function createProjectAliasesCache() {
  const entries = new Map<string, { aliases: ReturnType<typeof projectAliases>; expiresAt: number }>();
  return (cwd: string, now = performance.now()): ReturnType<typeof projectAliases> => {
    const cached = entries.get(cwd);
    if (cached && now < cached.expiresAt) return cached.aliases;

    // Refresh Git worktree metadata every 30 seconds and bound the number of remembered cwd values.
    const aliases = projectAliases(cwd);
    entries.delete(cwd);
    entries.set(cwd, { aliases, expiresAt: now + 30_000 });
    if (entries.size > 128) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    return aliases;
  };
}

export interface ScopeContext {
  /** The session's working directory, as the hook received it. Empty → nothing is filtered. */
  cwd: string;
  /** Every id the session's observations may be tagged with (project-key.ts projectAliases().ids). Unset: the
   *  cwd's last folder name. */
  projectIds?: string[];
  /** The folders that are the project: its cwd, repository and worktrees. Unset: just the cwd. */
  roots?: string[];
  /** Observation tags that mean "no project": 'default' plus the worker's own corpus id, which transcript-only capture
   *  stamps. Default ['default']. */
  untaggedIds?: string[];
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
  const untagged = new Set((ctx.untaggedIds ?? ['default']).map(id => fold ? id.toLowerCase() : id));
  const insideProject = (p: unknown): boolean =>
    typeof p === 'string' && p !== '' && roots.some(r => isInside(norm(p, fold), r));
  const touchedProject = (m: Record<string, unknown> | undefined): boolean =>
    [m?.files_modified, m?.files_read].some(list => Array.isArray(list) && list.some(insideProject));

  const belongsElsewhere = (hit: T): boolean => {
    if (hit.channel === 'observation') {
      const tag = hit.metadata?.project_id;
      if (typeof tag !== 'string' || tag === '') return false;
      const t = fold ? tag.toLowerCase() : tag;
      if (untagged.has(t) || ownIds.has(t)) return false;
      return !touchedProject(hit.metadata);
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
