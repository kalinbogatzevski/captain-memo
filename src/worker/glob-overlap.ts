// src/worker/glob-overlap.ts — PURE file-claim overlap for the work-coordination board.
//
// Two sessions "overlap" when the file areas they claim intersect. The MVP is deliberately CONSERVATIVE
// (over-warn, never under-warn): a few false "you might collide" beats one silent clobber that breaks the
// codebase. A claim glob is normalised to either an EXACT path or a directory PREFIX:
//   "billing/**" / "billing/*" / "src/*.ts"  → prefix ("billing", "billing", "src")
//   "billing/invoice.ts"                      → exact
//   "**" / "*" / ""                           → whole-tree prefix (overlaps everything)
// Two normals overlap when their paths are equal or one is a directory-ancestor of the other. No real fs,
// no globbing engine — plain string logic, fully unit-tested. See the work-coordination-notes design spec.

type Norm = { kind: 'exact' | 'prefix'; path: string };

const BACKSLASH = /\\/g;
const MSYS_DRIVE = /^\/([a-zA-Z])\//;
const WIN_DRIVE = /^([a-zA-Z]):\//;

/** Canonical spelling, so the SAME file claimed from different shells compares equal.
 *
 *  On Windows one file has three spellings: `C:\src\a.ts` (what Claude Code's Edit tool sends — verified
 *  live on the board), `/c/src/a.ts` (MSYS bash, which is how a Bash-driven edit resolves) and
 *  `C:/src/a.ts` (PowerShell). norm() compared the raw text, so NONE of them overlapped: two sessions
 *  editing one file through different shells were never warned about each other. That is a silent
 *  clobber — precisely the failure this board exists to prevent.
 *
 *  Separator and DRIVE LETTER only. The rest of the path keeps its case, so a Linux captain stays
 *  case-sensitive. Applied to both sides of every comparison, so identical paths always still match; the
 *  only cost is that a genuine Linux `/c/...` folds to `C:/...` too, which is harmless — it folds
 *  identically on both sides, and cross-host file overlap is meaningless anyway (repo contention is
 *  local-only by design, see worker/index.ts). */
function canon(g: string): string {
  return g
    .replace(BACKSLASH, '/')
    .replace(MSYS_DRIVE, '$1:/')
    .replace(WIN_DRIVE, (_m, d: string) => `${d.toUpperCase()}:/`);
}

function norm(glob: string): Norm {
  let g = canon(String(glob ?? '').trim()).replace(/^\.\//, '');
  if (g === '' || g === '**' || g === '*') return { kind: 'prefix', path: '' };   // whole tree
  const dirIntent = g.endsWith('/');   // a trailing slash means a DIRECTORY → prefix
  g = g.replace(/\/+$/, '');
  if (dirIntent) return { kind: 'prefix', path: g };
  const star = g.indexOf('*');
  if (star < 0) return { kind: 'exact', path: g };
  // Anything with a wildcard collapses to the directory BEFORE the first wildcard (conservative).
  return { kind: 'prefix', path: g.slice(0, star).replace(/\/+$/, '') };
}

/** Is `child` equal to OR under `base` (a directory prefix)? An empty base is the whole tree. */
function underOrEq(child: string, base: string): boolean {
  if (base === '') return true;
  return child === base || child.startsWith(base + '/');
}

function oneOverlap(a: Norm, b: Norm): boolean {
  if (a.kind === 'exact' && b.kind === 'exact') return a.path === b.path;
  if (a.kind === 'prefix' && b.kind === 'exact') return underOrEq(b.path, a.path);
  if (a.kind === 'exact' && b.kind === 'prefix') return underOrEq(a.path, b.path);
  return underOrEq(a.path, b.path) || underOrEq(b.path, a.path);   // both prefix
}

/** The subset of `aGlobs` that overlaps SOME glob in `bGlobs`. Empty ⇒ no overlap. */
export function globsOverlap(aGlobs: string[], bGlobs: string[]): string[] {
  const bN = (bGlobs ?? []).map(norm);
  if (bN.length === 0) return [];
  const hits: string[] = [];
  for (const ag of aGlobs ?? []) {
    const an = norm(ag);
    if (bN.some((bn) => oneOverlap(an, bn))) hits.push(ag);
  }
  return hits;
}
