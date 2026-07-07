# Work-board shared-repo contention

**Date:** 2026-07-07
**Repo:** captain-memo (OSS `master`; mirrors to `captain-memo-fed`/federation)
**Status:** design approved; ready for implementation plan

## 1. Motivation — a real coordination gap

The `work_set` / `work_active` board lets a session claim the **files** it is working on and
computes `overlaps_with_mine`. But each session's claimed paths live in its own isolated
scratchpad (`…/claude-1000/<session_id>/scratchpad/…`), so claims between sessions can **never
overlap** — the string prefix-compare in `underOrEq` (`glob-overlap.ts:27,32`) can't match across
two distinct per-session absolute paths. Meanwhile the resource multiple sessions on one host
actually contend for — the **single shared git working tree** (e.g. `/home/kalin/projects/erp-platform`)
— is invisible to the board.

**Live incident (3 concurrent sessions):** session A was committing on its branch in the shared
checkout; session B `git switch`ed that same working tree to another branch, then to `master`, and
left uncommitted files in it. A's branch was checked out from under it mid-task; `git status`
showed a peer's dirty files; `git add -A` would have swept a teammate's WIP into the wrong commit.
`work_active` showed all three sessions but `overlaps_with_mine: []`, because the contended
resource (the checkout + its HEAD/branch/dirty state) is not a claimable file.

**Root cause:** the board models "files in a private scratchpad," not "shared mutable host
resources." A shared git checkout is (a) shared by all sessions, (b) mutated by non-file ops
(checkout/switch, commit, reset, stash), and (c) has global state (branch, staged set, dirty tree)
one session silently changes for everyone.

## 2. Scope (approved)

**Detect + warn + suggest a worktree.** Make shared-repo contention a first-class surfaced
resource and warn before a mutating git op — the warning's recommended action is worktree
isolation. **Not** auto-provisioning worktrees: the harness owns each session's cwd and the board
cannot relocate a live session, so "auto-route to a worktree" collapses in practice to "warn +
suggest." (Full auto-provisioning is out of scope — §9.)

**Why `git rev-parse --show-toplevel` is the right key:** it returns the *physical working-tree
root*, which is **distinct per worktree**. Two sessions in the same shared checkout → same root →
contended; two sessions in separate worktrees → different roots → not contended. The key rewards
isolation automatically.

## 3. Where it builds

The board core is **OSS `master`** and byte-identical-mirrored to federation (`work-notes.ts`,
`glob-overlap.ts` diff clean). All core changes (git helpers, repo detection + stamping,
`repo_contention` in `work_active`, the Bash hook) land on **master** and propagate to federation by
mirror. Only the **fleet-wide broadcast** (the repo fields riding the roster poll) is
federation-only wiring.

## 4. Design

### 4.1 Git helpers (`src/worker/branch.ts` neighbourhood)

Next to the existing `detectBranchSync` (`branch.ts:16`) / `detectBranchSyncCached` (`:58`):

- `detectRepoRootSync(pathOrDir: string): string | null` — `git -C <dir> rev-parse --show-toplevel`
  (reuse the exact spawn pattern already used by `self-updater.ts:35`). Returns the working-tree
  root, or `null` if not in a git repo. Cached with a short TTL (mirror `detectBranchSyncCached`).
- `detectDirtySync(repoRoot: string): { is_dirty: boolean; staged: boolean }` —
  `git -C <root> status --porcelain`; `is_dirty` = any output, `staged` = any line whose first
  column is not a space/`?`. Short-TTL cache (dirty state is time-sensitive; ~2s TTL).

Both fail-safe: on spawn error return `null` / `{is_dirty:false, staged:false}` (never throw).

### 4.2 Detect + stamp (server-side, `/worknote/set` route, `index.ts:~1647`)

After `setWorkNote`, for the claim's files (absolute paths the hook feeds, or globs from MCP),
resolve the repo root of the first path that resolves to one:

- `repoRoot = detectRepoRootSync(dirname(firstConcretePath))`.
- **Stamp** `repo_root`, `branch` (`detectBranchSync(repoRoot)`), `is_dirty`
  (`detectDirtySync(repoRoot).is_dirty`) onto the note **iff** `repoRoot` is a *real project
  checkout* — i.e. `repoRoot` is non-null AND does **not** contain a `/claude-1000/` scratchpad
  segment (the current per-session scratchpad convention). Scratchpad paths are typically not git
  repos at all (→ `null` → no stamp); the segment check is the explicit belt-and-suspenders guard so
  scratchpad claims stay plain file-claims and never gain a repo stamp (**acceptance #3**).
- No repo → note is unchanged (plain file-claim, today's behaviour).

Detection reads only the claimed **absolute** paths — it does not depend on the worker's cwd. The
PreToolUse Edit hook always feeds absolute `file_path` values, so every edit in a shared checkout
stamps the repo — this is the incident's driving path and the primary case. An MCP `work_set` that
passes **relative** globs (e.g. `src/**`) cannot resolve a repo root server-side (no caller cwd) and
so won't be stamped; that is acceptable (MCP claims are advisory intent, and the hook covers the real
mutations). Only the first path that resolves to a repo is probed (one `git` spawn per set, cached).

### 4.3 Data model (additive)

`WorkNote` (`work-notes.ts:19-30`) gains three **optional** fields:

```ts
repo_root?: string;   // physical working-tree root (git rev-parse --show-toplevel)
branch?: string;      // current branch of that checkout at set time
is_dirty?: boolean;   // working tree had uncommitted changes at set time
```

Stamped in `setWorkNote` (`work-notes.ts:73`) from the values §4.2 resolves. Absent on
scratchpad/no-repo claims. Because the federation roster-poll pipeline is "additive optional, pure
relay, store-latest," these fields propagate **fleet-wide for free** via `FleetWorkNote`
(`types.ts:205`) → `FleetStatusParams.work_notes` (`:243`) → `FleetMember.work_notes` (`:299`); the
federation change is just adding the three fields to the fed `FleetWorkNote` type.

Freshness: re-`set` is the heartbeat (the Edit hook re-sets on every edit), so `branch`/`is_dirty`
refresh on each set. The pre-op warning (§4.5) additionally re-resolves *live* state at git-op time.

### 4.4 `work_active` → `repo_contention[]` (`/worknote/active` route, `index.ts:1661-1671`)

Group the already-computed live `claims` that carry `repo_root` by `repo_root`:

```ts
repo_contention: Array<{
  repo_root: string;
  holders: Array<{ session_id: string; agent?: string; branch?: string; is_dirty?: boolean; ts: number }>;
  branches: string[];              // distinct branches seen across holders
}>
```

Returned only for repo_roots with **≥2 distinct holders** (single-holder = no contention). Also:
`overlaps_with_mine` fires when the caller's live claim shares a `repo_root` with another session's
claim (**same-repo-root**, not just identical file path) — the caller sees the contention as an
overlap, not an empty list (**acceptance #1**). Keying is on `repo_root` (+`branch`), never
`session_id` (MCP and hook session-id spaces differ — §5).

### 4.5 Bash warning hook (new `Bash` matcher)

New PreToolUse entry in `plugin/hooks/hooks.json` (matcher `Bash`) dispatched to a new handler
(`src/hooks/pre-git.ts`, compiled into `plugin/dist/`), reusing `shared.ts` helpers (`workerFetch`,
`writeStdout`):

1. Parse `tool_input.command`; detect a mutating git subcommand:
   `git (checkout|switch|commit|reset|stash|rebase|merge|cherry-pick|clean|restore)`. (A parser that
   finds the `git` token and its first subcommand, tolerant of leading env/`cd &&` and flags.)
2. Resolve the session cwd (hook payload `cwd`) → `detectRepoRootSync(cwd)`. Skip if null or if the
   root carries a `/claude-1000/` scratchpad segment.
3. `GET /worknote/repo-active?repo_root=<root>` (new lightweight route mirroring `/worknote/active`,
   returning the holders for that root).
4. If a holder exists whose `session_id` ≠ the caller's Claude `session_id`, emit a **fail-open
   advisory** `additionalContext` (same shape as `pre-tool-use.ts:80-83`), e.g.:

   > ⚠ Peer `<agent>` holds `<repo_root>` on branch `<branch>`{, dirty} — running `git <op>` here
   > changes the shared checkout for them. Isolate instead: `git worktree add ../<name> <branch>` and
   > work there.

**Never blocks** (advisory only, consistent with the existing fail-open Edit hook). Any error
(unparseable command, worker unreachable, no repo) → silent no-op.

## 5. Decisions & known limitation

- **Advisory, never block.** The git-op hook only warns. A hook that denies git commands would be
  dangerous and annoying; the operator decides.
- **Session-id-space caveat (accepted for v1).** MCP `work_set` uses `PROCESS_SESSION_ID =
  mcp-<…>` (`mcp-server.ts:36`); the hook uses Claude's `payload.session_id`. So a claim registered
  via MCP from the same Claude session won't be recognised as "mine" by the hook's exclusion check,
  and could produce a **rare false self-warning**. Because the warning is advisory, v1 accepts and
  documents this; a future correlation of the two id spaces can remove it.

## 6. Acceptance criteria → coverage

| Criterion | Covered by |
|---|---|
| Two sessions in one shared checkout → `work_active` reports the contention (who/branch/dirty), not empty overlaps | §4.4 `repo_contention[]` + same-repo-root `overlaps_with_mine` |
| A session about to `git checkout`/`commit` on a repo another session uses gets a warning | §4.5 Bash advisory hook |
| Private-scratchpad claims keep working unchanged (no false overlaps) | §4.2 stamp only real checkouts; scratchpad claims stay plain file-claims |

## 7. Testing

- **Unit:** `detectRepoRootSync`/`detectDirtySync` against temp git repos (clean, dirty, staged,
  non-repo, nested worktree gives a distinct root); shared-vs-scratchpad classification (a
  `/claude-1000/…` root is skipped); `repo_contention` grouping (≥2 holders only); same-repo-root
  `overlaps_with_mine`; git-command parser (each mutating subcommand triggers; `git log`/`git status`
  do not; tolerates `cd x &&`, env prefixes, flags).
- **Acceptance/integration:** two claims stamped with the same `repo_root` → `work_active`
  `repo_contention` non-empty + `overlaps_with_mine` fires; a scratchpad-only claim → no `repo_root`
  stamp, no false overlap; the Bash hook emits the advisory for `git checkout` on a peer-held root
  and stays silent for a solo-held root.

## 8. Files touched

**captain-memo (master):** `src/worker/branch.ts` (git helpers), `src/worker/work-notes.ts`
(WorkNote fields + stamping), `src/worker/index.ts` (`/worknote/set` stamping, `/worknote/active`
grouping, new `/worknote/repo-active`), `src/hooks/pre-git.ts` (new Bash hook) + `plugin/hooks/hooks.json`
+ `plugin/dist/` build, plus unit tests. **captain-memo-fed (federation):** mirror the above +
add the three fields to the fed `FleetWorkNote` type (`types.ts:205`) for fleet propagation.

## 9. Out of scope

- **Auto-worktree provisioning** (the board running `git worktree add` and relocating a session) —
  the harness owns cwd; can't relocate a live session. The warning *suggests* a worktree; the
  operator runs it.
- **Blocking** git ops.
- **Generalising to other shared resources** (DB migration lock, deploy-in-flight) — the same
  "claim a shared mutable resource, warn before a mutating op" shape extends there later; this spec
  is git-checkouts only.
- Correlating MCP and hook session-id spaces (see §5).
