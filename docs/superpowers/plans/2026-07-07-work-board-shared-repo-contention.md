# Work-board Shared-Repo Contention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a shared git working tree a first-class resource on the work board — surface repo-level contention (who/branch/dirty) in `work_active` and warn before a mutating git op — so concurrent sessions in one checkout stop clobbering each other.

**Architecture:** Additive. New git helpers (`detectRepoRootSync`/`detectDirtySync`) + a `resolveRepoClaim` classifier stamp optional `repo_root`/`branch`/`is_dirty` onto each `WorkNote` at the `/worknote/set` route (only for real checkouts, never scratchpad paths). `work_active` groups live claims by `repo_root` into `repo_contention[]` and folds same-repo-root hits into `overlaps_with_mine`. A new advisory `Bash` PreToolUse hook warns before `git checkout|commit|reset|…` on a peer-held repo. Everything keys on `repo_root+branch`, never `session_id`.

**Tech Stack:** Bun + TypeScript. `spawnSync('git', …)` for detection (mirrors existing `branch.ts`). Vitest/bun test. The board core is OSS `master`; a final task mirrors to `captain-memo-fed` + wires fleet propagation.

## Repos & branches

- **CM** = `/home/kalin/projects/captain-memo`, branch `feat/work-board-shared-repo-contention` (OSS master line) — the board core. Test: `bun test`.
- **FED** = `/home/kalin/projects/captain-memo-fed`, branch `federation` — mirror target (Task 6). `work-notes.ts`/`glob-overlap.ts`/`branch.ts` are byte-identical to CM; `index.ts` differs (routes at other line numbers); `src/hooks/*` + `plugin/` are shared.

## Global Constraints

- **Advisory, never block.** The git-op hook only emits `additionalContext`; it never denies. Any error → silent no-op (fail-open, like `pre-tool-use.ts`).
- **Scratchpad claims unchanged.** A claim is stamped with repo fields ONLY when its path resolves to a real checkout whose root does not contain a `/claude-1000/` segment. No repo stamp → today's plain file-claim behaviour → no false overlaps.
- **Key repo contention on `repo_root` (+`branch`), never `session_id`** — MCP (`mcp-<…>`) and hook (Claude `session_id`) use different id spaces.
- **`repo_root` = `git rev-parse --show-toplevel`** (physical working-tree root; distinct per worktree).
- **Git detection never throws** — spawn error → `null`/`{is_dirty:false,staged:false}`.
- **Additive fields are optional** — absent on scratchpad/no-repo claims; back-compatible with stored notes.

## Interface Contract (shared across tasks)

```ts
// branch.ts
export function detectRepoRootSync(cwd: string): string | null;
export function detectDirtySync(repoRoot: string): { is_dirty: boolean; staged: boolean };

// work-notes.ts — WorkNote & SetWorkNoteInput gain:
repo_root?: string; branch?: string; is_dirty?: boolean;
// OverlapHit.kind gains the 'repo' variant.
export interface RepoContention {
  repo_root: string;
  holders: Array<{ session_id: string; agent?: string; branch?: string; is_dirty?: boolean; ts: number }>;
  branches: string[];
}
export function repoOverlapsAgainst(myRepoRoot: string | undefined, others: WorkNote[], excludeSession: string): OverlapHit[];
export function groupRepoContention(notes: WorkNote[]): RepoContention[];

// repo-claim.ts (new)
export function resolveRepoClaim(files: string[], deps?: RepoClaimDeps): { repo_root?: string; branch?: string; is_dirty?: boolean };

// routes: POST /worknote/set stamps; GET /worknote/active += repo_contention; GET /worknote/repo-active?repo_root=… → { holders }
```

---

## Task 1: Git helpers — `detectRepoRootSync` + `detectDirtySync`

**Files:**
- Modify: `CM/src/worker/branch.ts` (append after `detectBranchSyncCached`, `:65`)
- Test: `CM/tests/unit/branch.test.ts` (or the existing branch test file — check with `ls CM/tests/unit | grep branch`; create if absent)

**Interfaces:**
- Produces: `detectRepoRootSync(cwd)`, `detectDirtySync(repoRoot)` (contract above).

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectRepoRootSync, detectDirtySync } from '../../src/worker/branch.ts';

function tmpRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'wb-repo-'));
  execFileSync('git', ['-C', d, 'init', '-q']);
  execFileSync('git', ['-C', d, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', d, 'config', 'user.name', 't']);
  writeFileSync(join(d, 'a.txt'), 'x');
  execFileSync('git', ['-C', d, 'add', 'a.txt']);
  execFileSync('git', ['-C', d, 'commit', '-qm', 'init']);
  return d;
}

test('detectRepoRootSync returns the working-tree root, null outside a repo', () => {
  const d = tmpRepo();
  mkdirSync(join(d, 'sub'));
  expect(detectRepoRootSync(join(d, 'sub'))).toBe(d);          // resolves from a subdir
  expect(detectRepoRootSync(tmpdir())).toBeNull();             // tmpdir itself is not a repo
});

test('detectDirtySync reports clean, dirty, and staged', () => {
  const d = tmpRepo();
  expect(detectDirtySync(d)).toEqual({ is_dirty: false, staged: false });
  writeFileSync(join(d, 'b.txt'), 'y');                        // untracked → dirty, not staged
  expect(detectDirtySync(d)).toEqual({ is_dirty: true, staged: false });
  execFileSync('git', ['-C', d, 'add', 'b.txt']);             // staged
  expect(detectDirtySync(d)).toEqual({ is_dirty: true, staged: true });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd /home/kalin/projects/captain-memo && bun test tests/unit/branch.test.ts`
Expected: FAIL — `detectRepoRootSync`/`detectDirtySync` not exported.

- [ ] **Step 3: Implement (append to `branch.ts`)**

```ts
/** Resolve the physical working-tree root for a path (git rev-parse --show-toplevel).
 *  null when the path is missing, not in a git repo, git absent, or any error. Never throws. */
export function detectRepoRootSync(cwd: string): string | null {
  if (!existsSync(cwd)) return null;
  try {
    const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8', timeout: 2000 });
    if (result.status !== 0) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch { return null; }
}

/** Working-tree dirtiness via `git status --porcelain`. is_dirty = any output; staged = any entry
 *  whose first (index) column is not space or '?'. Never throws → {false,false} on any error. */
export function detectDirtySync(repoRoot: string): { is_dirty: boolean; staged: boolean } {
  if (!existsSync(repoRoot)) return { is_dirty: false, staged: false };
  try {
    const result = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf-8', timeout: 2000 });
    if (result.status !== 0) return { is_dirty: false, staged: false };
    const lines = result.stdout.split('\n').filter((l) => l.length > 0);
    const is_dirty = lines.length > 0;
    const staged = lines.some((l) => l[0] !== ' ' && l[0] !== '?');
    return { is_dirty, staged };
  } catch { return { is_dirty: false, staged: false }; }
}
```

- [ ] **Step 4: Run tests, verify pass** — `bun test tests/unit/branch.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/branch.ts tests/unit/branch.test.ts
git commit -m "feat(work-board): git helpers — detectRepoRootSync + detectDirtySync"
```

---

## Task 2: WorkNote repo fields + `resolveRepoClaim` classifier + stamp at `/worknote/set`

**Files:**
- Modify: `CM/src/worker/work-notes.ts` (`WorkNote` `:19-30`, `SetWorkNoteInput` `:63-70`, `setWorkNote` `:73-89`, `sanitizeFleetNotes` `:203-214`)
- Create: `CM/src/worker/repo-claim.ts`
- Modify: `CM/src/worker/index.ts` (`/worknote/set` route, insert before `:1341`)
- Test: `CM/tests/unit/repo-claim.test.ts`, `CM/tests/unit/work-notes.test.ts` (add cases)

**Interfaces:**
- Consumes: `detectRepoRootSync`/`detectBranchSync`/`detectDirtySync` (Task 1 + existing `branch.ts:16`).
- Produces: `WorkNote.repo_root/branch/is_dirty`, `resolveRepoClaim(files, deps?)`.

- [ ] **Step 1: Write the failing test** (`repo-claim.test.ts`)

```ts
import { test, expect } from 'bun:test';
import { resolveRepoClaim } from '../../src/worker/repo-claim.ts';

const deps = {
  detectRepoRootSync: (p: string) => p.includes('/claude-1000/') ? '/home/u/tmp/claude-1000/x/scratchpad'
    : p.startsWith('/proj/erp') ? '/proj/erp' : null,
  detectBranchSync: () => 'master',
  detectDirtySync: () => ({ is_dirty: true, staged: false }),
};

test('stamps a real shared checkout', () => {
  expect(resolveRepoClaim(['/proj/erp/hr/functions.php'], deps)).toEqual({ repo_root: '/proj/erp', branch: 'master', is_dirty: true });
});
test('skips scratchpad paths (root contains /claude-1000/)', () => {
  expect(resolveRepoClaim(['/home/u/tmp/claude-1000/x/scratchpad/a.ts'], deps)).toEqual({});
});
test('no repo → empty', () => {
  expect(resolveRepoClaim(['/tmp/loose.txt'], deps)).toEqual({});
});
test('ignores relative globs (no absolute path to resolve)', () => {
  expect(resolveRepoClaim(['src/**', 'billing/*.ts'], deps)).toEqual({});
});
```

- [ ] **Step 2: Run it, verify it fails** — `bun test tests/unit/repo-claim.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `repo-claim.ts`**

```ts
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
    return { repo_root: root, branch: deps.detectBranchSync(root) ?? undefined, is_dirty: deps.detectDirtySync(root).is_dirty };
  }
  return {};
}
```

- [ ] **Step 4: Add the fields to `work-notes.ts`**

In `WorkNote` (after `:29 meaningful?`): `repo_root?: string; branch?: string; is_dirty?: boolean;`
In `SetWorkNoteInput` (after `:65 meaningful?`): `repo_root?: string; branch?: string; is_dirty?: boolean;`
In `setWorkNote`, after `:82` (`if (input.meaningful === true) …`), copy them through:

```ts
  if (typeof input.repo_root === 'string' && input.repo_root) note.repo_root = input.repo_root.slice(0, 512);
  if (typeof input.branch === 'string' && input.branch) note.branch = input.branch.slice(0, 256);
  if (typeof input.is_dirty === 'boolean') note.is_dirty = input.is_dirty;
```

In `sanitizeFleetNotes`, in the `note` object literal (after the `meaningful` spread, `:213`), preserve them for fleet propagation:

```ts
      ...(typeof r.repo_root === 'string' && r.repo_root ? { repo_root: r.repo_root.slice(0, 512) } : {}),
      ...(typeof r.branch === 'string' && r.branch ? { branch: r.branch.slice(0, 256) } : {}),
      ...(r.is_dirty === true ? { is_dirty: true } : {}),
```

- [ ] **Step 5: Wire stamping into `/worknote/set`** (`index.ts`, insert immediately before `:1341 const note = setWorkNote(...)`)

```ts
        // Shared-repo stamp: if the claimed files resolve into a real checkout (not a scratchpad), record
        // repo_root/branch/is_dirty so the board can surface cross-session contention on that working tree.
        const repoClaim = resolveRepoClaim(setBody.files ?? []);
        if (repoClaim.repo_root) { setBody.repo_root = repoClaim.repo_root; setBody.branch = repoClaim.branch; setBody.is_dirty = repoClaim.is_dirty; }
```

Add the import at `index.ts` top (next to the work-notes import `:30`): `import { resolveRepoClaim } from './repo-claim.ts';`

- [ ] **Step 6: Add work-notes stamping test** (`work-notes.test.ts`)

```ts
test('setWorkNote stores optional repo fields when provided', () => {
  const kv = makeMemKv();   // existing test helper in this file
  const n = setWorkNote(kv, { session_id: 's1', files: ['/proj/erp/a.php'], repo_root: '/proj/erp', branch: 'master', is_dirty: true }, 1000);
  expect(n.repo_root).toBe('/proj/erp'); expect(n.branch).toBe('master'); expect(n.is_dirty).toBe(true);
});
test('setWorkNote omits repo fields when absent (scratchpad claim)', () => {
  const kv = makeMemKv();
  const n = setWorkNote(kv, { session_id: 's2', files: ['/tmp/x/scratchpad/a.ts'] }, 1000);
  expect(n.repo_root).toBeUndefined();
});
```

(If `makeMemKv` isn't the helper name, use the file's existing in-memory kv builder.)

- [ ] **Step 7: Run tests, verify pass** — `bun test tests/unit/repo-claim.test.ts tests/unit/work-notes.test.ts` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/worker/repo-claim.ts src/worker/work-notes.ts src/worker/index.ts tests/unit/repo-claim.test.ts tests/unit/work-notes.test.ts
git commit -m "feat(work-board): stamp repo_root/branch/is_dirty on claims in a shared checkout"
```

---

## Task 3: Repo overlap + `repo_contention` grouping in `work_active`

**Files:**
- Modify: `CM/src/worker/work-notes.ts` (`OverlapHit.kind` `:34`, add `repoOverlapsAgainst` + `groupRepoContention` + `RepoContention`)
- Modify: `CM/src/worker/index.ts` (`/worknote/active` route `:1355-1363`)
- Test: `CM/tests/unit/work-notes.test.ts`

**Interfaces:**
- Consumes: `WorkNote.repo_root` (Task 2).
- Produces: `repoOverlapsAgainst`, `groupRepoContention`, `RepoContention`; `/worknote/active` now returns `repo_contention`.

- [ ] **Step 1: Write the failing test**

```ts
import { repoOverlapsAgainst, groupRepoContention } from '../../src/worker/work-notes.ts';
const n = (session_id: string, repo_root?: string, branch?: string) => ({ agent: 'claude', session_id, what: 'w', files: [], ts: 1, ttl_s: 60, ...(repo_root ? { repo_root } : {}), ...(branch ? { branch } : {}) });

test('repoOverlapsAgainst fires on same repo_root, excludes self + no-repo', () => {
  const others = [n('a', '/proj/erp', 'master'), n('b', '/proj/other'), n('c')];
  const hits = repoOverlapsAgainst('/proj/erp', others, 'me');
  expect(hits.map((h) => h.session_id)).toEqual(['a']);
  expect(hits[0]!.kind).toBe('repo');
});
test('groupRepoContention returns only roots with >=2 distinct sessions', () => {
  const notes = [n('a', '/proj/erp', 'master'), n('b', '/proj/erp', 'feat'), n('c', '/proj/solo', 'master')];
  const g = groupRepoContention(notes);
  expect(g.length).toBe(1);
  expect(g[0]!.repo_root).toBe('/proj/erp');
  expect(g[0]!.holders.map((h) => h.session_id).sort()).toEqual(['a', 'b']);
  expect(g[0]!.branches.sort()).toEqual(['feat', 'master']);
});
```

- [ ] **Step 2: Run it, verify it fails** — FAIL (exports missing).

- [ ] **Step 3: Implement in `work-notes.ts`**

Extend `OverlapHit.kind` (`:34`): `kind?: 'files' | 'semantic' | 'repo';`

Append:

```ts
export interface RepoContention {
  repo_root: string;
  holders: Array<{ session_id: string; agent?: string; branch?: string; is_dirty?: boolean; ts: number }>;
  branches: string[];
}

/** Live claims (excluding my session) that share my working-tree root — the shared-checkout collision the
 *  file-glob pass misses (peers claim different files but mutate the same HEAD/branch/dirty tree). */
export function repoOverlapsAgainst(myRepoRoot: string | undefined, others: WorkNote[], excludeSession: string): OverlapHit[] {
  if (!myRepoRoot) return [];
  const hits: OverlapHit[] = [];
  for (const o of others) {
    if (o.session_id === excludeSession || o.repo_root !== myRepoRoot) continue;
    hits.push({ agent: o.agent, session_id: o.session_id, ...(o.captain ? { captain: o.captain } : {}), what: o.what, files: o.files, overlapping: [myRepoRoot], kind: 'repo' });
  }
  return hits;
}

/** Group live repo-stamped claims by working-tree root; return only roots held by >=2 DISTINCT sessions. */
export function groupRepoContention(notes: WorkNote[]): RepoContention[] {
  const byRoot = new Map<string, WorkNote[]>();
  for (const n of notes) { if (!n.repo_root) continue; (byRoot.get(n.repo_root) ?? byRoot.set(n.repo_root, []).get(n.repo_root)!).push(n); }
  const out: RepoContention[] = [];
  for (const [repo_root, ns] of byRoot) {
    const sessions = new Set(ns.map((n) => n.session_id));
    if (sessions.size < 2) continue;
    out.push({
      repo_root,
      holders: ns.map((n) => ({ session_id: n.session_id, agent: n.agent, branch: n.branch, is_dirty: n.is_dirty, ts: n.ts })),
      branches: [...new Set(ns.map((n) => n.branch).filter((b): b is string => !!b))],
    });
  }
  return out;
}
```

- [ ] **Step 4: Wire into `/worknote/active`** (`index.ts`, replace `:1355-1363`)

```ts
      if (req.method === 'GET' && url.pathname === '/worknote/active') {
        const now = Date.now();
        const claims = listLocalActive(meta, now);
        const mine = url.searchParams.get('session_id') ?? '';
        const mineNote = mine ? claims.find((c) => c.session_id === mine) : undefined;
        const overlaps_with_mine = mineNote
          ? [...overlapsAgainst(mineNote.files, claims, mine), ...repoOverlapsAgainst(mineNote.repo_root, claims, mine)]
          : [];
        const repo_contention = groupRepoContention(claims);
        return Response.json({ claims, overlaps_with_mine, repo_contention });
      }
```

Add `repoOverlapsAgainst, groupRepoContention` to the work-notes import (`index.ts:30`).

- [ ] **Step 5: Run tests, verify pass** — `bun test tests/unit/work-notes.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker/work-notes.ts src/worker/index.ts tests/unit/work-notes.test.ts
git commit -m "feat(work-board): repo_contention + same-repo-root overlaps in work_active"
```

---

## Task 4: `/worknote/repo-active` route (holders for one working-tree root)

**Files:**
- Modify: `CM/src/worker/index.ts` (add after the `/worknote/active` route, `:~1364`)
- Test: `CM/tests/unit/worknote-routes.test.ts` (or extend an existing route/integration test that boots the worker fetch handler; if none, a focused test that calls the handler with a fake `meta`)

**Interfaces:**
- Consumes: `listLocalActive`, `groupRepoContention` (Tasks 2-3).
- Produces: `GET /worknote/repo-active?repo_root=… → { holders: [...] }`.

- [ ] **Step 1: Write the failing test** — assert the route returns holders for a contended root and `[]` for an unknown/solo root. (Mirror the existing worknote route test harness in this repo — find it with `grep -rl "/worknote/active" tests/`. If the repo tests routes via a booted worker, add a case there; otherwise unit-test a small extracted `repoActiveHolders(claims, repo_root)` helper.)

To keep it unit-testable, extract the logic into `work-notes.ts`:

```ts
/** Holders (session/agent/branch/dirty/ts) of a specific working-tree root among live claims. */
export function repoActiveHolders(notes: WorkNote[], repoRoot: string): RepoContention['holders'] {
  return notes.filter((n) => n.repo_root === repoRoot).map((n) => ({ session_id: n.session_id, agent: n.agent, branch: n.branch, is_dirty: n.is_dirty, ts: n.ts }));
}
```

Test:

```ts
import { repoActiveHolders } from '../../src/worker/work-notes.ts';
test('repoActiveHolders returns holders of the given root only', () => {
  const notes = [n('a', '/proj/erp', 'master'), n('b', '/proj/erp', 'feat'), n('c', '/proj/other')];
  expect(repoActiveHolders(notes, '/proj/erp').map((h) => h.session_id).sort()).toEqual(['a', 'b']);
  expect(repoActiveHolders(notes, '/nope')).toEqual([]);
});
```

- [ ] **Step 2: Run it, verify it fails** — FAIL.

- [ ] **Step 3: Implement `repoActiveHolders` in `work-notes.ts`** (code above).

- [ ] **Step 4: Add the route** (`index.ts`, after `/worknote/active`)

```ts
      if (req.method === 'GET' && url.pathname === '/worknote/repo-active') {
        const now = Date.now();
        const repoRoot = url.searchParams.get('repo_root') ?? '';
        if (!repoRoot) return Response.json({ holders: [] });
        const holders = repoActiveHolders(listLocalActive(meta, now), repoRoot);
        return Response.json({ holders });
      }
```

Add `repoActiveHolders` to the work-notes import.

- [ ] **Step 5: Run tests, verify pass** — PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker/work-notes.ts src/worker/index.ts tests/unit/*.ts
git commit -m "feat(work-board): /worknote/repo-active — holders of a working-tree root"
```

---

## Task 5: Advisory `Bash` git-op hook

**Files:**
- Create: `CM/src/hooks/pre-git.ts`
- Modify: `CM/src/hooks/pre-tool-use.ts` (branch to `pre-git` when `tool_name === 'Bash'`)
- Modify: `CM/plugin/hooks/hooks.json` (add a `Bash` PreToolUse matcher)
- Build: rebuild `CM/plugin/dist/captain-memo-hook.js` (`bun run build:plugin`)
- Test: `CM/tests/unit/pre-git.test.ts`

**Interfaces:**
- Consumes: `GET /worknote/repo-active` (Task 4), `shared.ts` (`workerFetch`, `writeStdout`, `logHookError`).
- Produces: `parseGitOp(command)`, `runPreGit(payload)`.

- [ ] **Step 1: Write the failing test** (parser is the risky bit)

```ts
import { test, expect } from 'bun:test';
import { parseGitOp } from '../../src/hooks/pre-git.ts';

test('parseGitOp detects mutating subcommands, ignores read-only + non-git', () => {
  expect(parseGitOp('git checkout master')).toBe('checkout');
  expect(parseGitOp('git switch -c feat')).toBe('switch');
  expect(parseGitOp('cd /proj && git commit -m x')).toBe('commit');
  expect(parseGitOp('GIT_PAGER=cat git reset --hard')).toBe('reset');
  expect(parseGitOp('git status')).toBeNull();
  expect(parseGitOp('git log --oneline')).toBeNull();
  expect(parseGitOp('ls -la')).toBeNull();
  expect(parseGitOp('echo git commit')).toBeNull();   // not an invoked git
});
```

- [ ] **Step 2: Run it, verify it fails** — FAIL.

- [ ] **Step 3: Implement `pre-git.ts`**

```ts
// PreToolUse (Bash) — warn before a mutating git op on a working tree another session is using.
// Advisory only (fail-open): parse the command, resolve the cwd's repo root, ask the board who holds it,
// and if a PEER session does, emit additionalContext suggesting a worktree. Any error → silent no-op.
import { workerFetch, writeStdout, logHookError } from './shared.ts';
import { detectRepoRootSync } from '../worker/branch.ts';

const MUTATING = /^(checkout|switch|commit|reset|stash|rebase|merge|cherry-pick|clean|restore)$/;

interface Payload { session_id?: string; cwd?: string; tool_name?: string; tool_input?: { command?: unknown } & Record<string, unknown>; }
interface Holder { session_id: string; agent?: string; branch?: string; is_dirty?: boolean }
interface RepoActiveResp { holders?: Holder[] }
const HOOK_TIMEOUT_MS = Number(process.env.CAPTAIN_MEMO_PRE_TOOL_USE_TIMEOUT_MS ?? 1500);

/** Return the mutating git subcommand invoked by a shell command, or null. Finds a `git` token
 *  (not preceded by a quote/word char), then the next non-flag token as the subcommand. Tolerates
 *  leading env assignments and `cd … &&`. Deliberately conservative — a miss just skips the warning. */
export function parseGitOp(command: string): string | null {
  if (typeof command !== 'string') return null;
  // split on shell separators so `echo git commit` (git not invoked) doesn't match a later segment's rules
  for (const seg of command.split(/&&|\|\||;|\|/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]!)) i++;   // skip env assignments
    if (toks[i] !== 'git') continue;
    let j = i + 1;
    while (j < toks.length && toks[j]!.startsWith('-')) j++;                     // skip global flags (-C, -c …)
    // skip the argument of a value-taking global flag like `-C <dir>`
    const sub = toks[j];
    if (sub && MUTATING.test(sub)) return sub;
  }
  return null;
}

export async function runPreGit(payload: Payload): Promise<void> {
  const op = parseGitOp(typeof payload.tool_input?.command === 'string' ? payload.tool_input.command : '');
  if (!op || !payload.cwd) return;
  const root = detectRepoRootSync(payload.cwd);
  if (!root || root.includes('/claude-1000/')) return;            // no repo / scratchpad → nothing shared
  const res = await workerFetch<RepoActiveResp>(`/worknote/repo-active?repo_root=${encodeURIComponent(root)}`, { method: 'GET', timeoutMs: HOOK_TIMEOUT_MS });
  if (!res.ok || !res.body?.holders) return;
  const peers = res.body.holders.filter((h) => h.session_id !== payload.session_id);
  if (peers.length === 0) return;
  const who = peers.map((h) => `${(h.session_id ?? '').slice(0, 12)} (${h.agent ?? '?'})${h.branch ? ` on ${h.branch}` : ''}${h.is_dirty ? ', dirty' : ''}`).join(' ; ');
  const warning = `WORK-BOARD SHARED CHECKOUT: peer session(s) are using ${root} — ${who}. Running \`git ${op}\` here changes that shared working tree for them. Isolate instead: \`git worktree add ../<name> <branch>\` and work there. (advisory)`;
  writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warning } }));
}
```

- [ ] **Step 4: Branch to it from `pre-tool-use.ts`** — at the top of `main()`, after reading the payload (`:29`), before the file-path early-return (`:36`):

```ts
  if (payload.tool_name === 'Bash') { try { await (await import('./pre-git.ts')).runPreGit(payload as any); } catch (err) { logHookError('PreToolUse', err); } return; }
```

- [ ] **Step 5: Register the Bash matcher** — in `plugin/hooks/hooks.json`, add a second entry to the `PreToolUse` array:

```json
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "bun \"${CLAUDE_PLUGIN_ROOT}/dist/captain-memo-hook.js\" PreToolUse" } ] }
```

- [ ] **Step 6: Build the plugin bundle** — `bun run build:plugin` (regenerates `plugin/dist/captain-memo-hook.js`). Confirm the file's mtime updated.

- [ ] **Step 7: Run tests, verify pass** — `bun test tests/unit/pre-git.test.ts` → PASS. Also `bunx tsc --noEmit` clean for the new files.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/pre-git.ts src/hooks/pre-tool-use.ts plugin/hooks/hooks.json plugin/dist/captain-memo-hook.js tests/unit/pre-git.test.ts
git commit -m "feat(work-board): advisory Bash hook — warn before a git op on a peer-held checkout"
```

---

## Task 6: Mirror to `captain-memo-fed` + fleet propagation of repo fields

**Files (FED = `/home/kalin/projects/captain-memo-fed`):**
- Overwrite (byte-identical from CM): `FED/src/worker/branch.ts`, `FED/src/worker/work-notes.ts`, `FED/src/worker/repo-claim.ts` (new), `FED/src/hooks/pre-git.ts` (new), `FED/src/hooks/pre-tool-use.ts`, `FED/plugin/hooks/hooks.json`, `FED/plugin/dist/captain-memo-hook.js`
- Re-apply route edits by hand (fed `index.ts` has different line numbers): the `/worknote/set` stamp, `/worknote/active` `repo_contention`+repo-overlap, and the new `/worknote/repo-active` route — find them with `grep -n "/worknote/" FED/src/worker/index.ts` and `grep -n "resolveRepoClaim\|overlapsAgainst" FED/src/mcp/tools.ts FED/src/worker/index.ts`.
- Modify: `FED/src/worker/federation/protocol/types.ts` — the fleet worknote type (`FleetWorkNote`, ~`:205`): add `repo_root?: string; branch?: string; is_dirty?: boolean;` so the roster-poll relay carries them.
- Test: mirror the CM tests; run `FED bun test` for the touched files.

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: fleet-wide propagation of repo fields (siblings' shared-repo claims appear in local `work_active`).

- [ ] **Step 1: Copy the byte-identical core files** — `cp` each file listed above from CM to FED. Verify no drift on the shared ones: `diff CM/src/worker/work-notes.ts FED/src/worker/work-notes.ts` → empty.

- [ ] **Step 2: Re-apply the three route edits** to `FED/src/worker/index.ts` at the fed line numbers (same code as Tasks 2 Step 5, 3 Step 4, 4 Step 4). Add the `resolveRepoClaim`/`repoOverlapsAgainst`/`groupRepoContention`/`repoActiveHolders` imports.

- [ ] **Step 3: Write the failing fleet test** — assert `sanitizeFleetNotes` preserves `repo_root`/`branch`/`is_dirty` (already coded in Task 2 Step 4; the fed copy inherits it) and that the `FleetWorkNote` type carries the fields.

```ts
import { sanitizeFleetNotes } from '../../src/worker/work-notes.ts';
test('fleet notes preserve repo fields', () => {
  const out = sanitizeFleetNotes([{ session_id: 's', ts: 1, ttl_s: 60, repo_root: '/proj/erp', branch: 'master', is_dirty: true }], 1000);
  expect(out[0]!.repo_root).toBe('/proj/erp'); expect(out[0]!.is_dirty).toBe(true);
});
```

- [ ] **Step 4: Add the fields to `FleetWorkNote`** (`FED/src/worker/federation/protocol/types.ts:~205`): `repo_root?: string; branch?: string; is_dirty?: boolean;`.

- [ ] **Step 5: Run tests + type-check** — `cd FED && bun test tests/unit/work-notes.test.ts tests/unit/repo-claim.test.ts tests/unit/pre-git.test.ts && bunx tsc --noEmit` → green vs. fed baseline.

- [ ] **Step 6: Commit (FED)**

```bash
cd /home/kalin/projects/captain-memo-fed
git add -A   # (only the mirrored files — verify with git status --short first)
git commit -m "feat(work-board): mirror shared-repo contention + fleet-propagate repo fields"
```

---

## Self-Review

**Spec coverage:** §4.1 git helpers → Task 1; §4.2 detect+stamp → Task 2; §4.3 data model → Task 2 (fields) + Task 6 (FleetWorkNote); §4.4 repo_contention + repo overlap → Task 3; §4.5 Bash hook → Task 5 (+ `/worknote/repo-active` in Task 4); fleet propagation → Task 6. Acceptance #1 → Tasks 3/4; #2 → Task 5; #3 → Task 2 (scratchpad skip). **No gaps.**

**Placeholder scan:** the only "find it with grep" directions (Task 4 test harness location, Task 6 fed line numbers) point at concrete grep commands, not vague TODOs — fed line numbers genuinely differ and must be located at implementation time. All code is spelled out.

**Type consistency:** `repo_root`/`branch`/`is_dirty` names identical across `WorkNote`, `SetWorkNoteInput`, `RepoClaim`, `RepoContention.holders`, the routes, and the hook. `OverlapHit.kind` gains `'repo'` once (Task 3) and is used by `repoOverlapsAgainst`. `groupRepoContention`/`repoActiveHolders`/`repoOverlapsAgainst`/`resolveRepoClaim` signatures match the Interface Contract and their call sites.
