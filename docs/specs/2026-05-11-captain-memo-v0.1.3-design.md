# captain-memo v0.1.3 — Design Spec

**Status:** Approved for implementation
**Date:** 2026-05-11
**Author:** Kalin Bogatzevski (drafted with Claude during brainstorming session)

## TL;DR

Three additive features plus a tiny cosmetic, shipped together as v0.1.3:

1. **PreCompact summarized-recap hook** — capture a session summary at the moment Claude Code's context is about to compact, so the highest-value information doesn't vanish.
2. **Identifier-match boost** — in hybrid search, re-rank chunks that literally contain a code-shaped query token (`foo.bar`, `useEffect`, `contract_bills.fee`).
3. **Branch metadata + soft same-branch boost** — every observation records its git branch at capture; observations from the current branch get a small ranking nudge at retrieval.
4. **Version line in `stats`** — surface `captain-memo`'s version in the human stats output (it's already in `--json`).

Constraints honored:
- No new daemons or external services.
- No breaking schema changes — one nullable column added.
- All three boosts share a single post-RRF reranker module (`src/worker/rerank.ts`), so the boost machinery is in one place.
- Total surface: ~150 LOC, 4 commits + 1 release commit.

## Features

### 1. PreCompact summarized-recap hook

**Goal.** Capture a high-signal observation at the boundary where context is about to be lost. Solves the structural amnesia gap that SessionStart/Stop don't cover.

**Plugin registration.** Add to `plugin/hooks/hooks.json`:

```json
"PreCompact": [{
  "hooks": [{
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/bin/captain-memo-hook PreCompact",
    "timeout": 30
  }]
}]
```

**Handler flow.** In `bin/captain-memo-hook` and the underlying TS handler:

1. Read Claude Code's PreCompact envelope from stdin (session id, recent activity hint).
2. Call the existing summarizer module (whichever is configured: `summarizer-claude-code.ts`, `-oauth`, or `-openai`). Existing infrastructure — no new summarizer code.
3. Submit the summary via the existing `submitObservation` queue API:
   - `channel: "observation"`
   - `source: "pre-compact"` (new value for the source field; queryable later)
   - `body: <summary text>`
4. Return within the 30 s timeout. Summarizer is sync but typically <2 s.

**Failure mode.** If summarizer errors, timeouts, or the worker is unreachable: log to stderr and `exit 0`. **Never block compaction.** Compaction is the user's emergency lifeline when context fills up; Captain Memo must not stand in its way.

**Observability.** The new `source: "pre-compact"` tag makes these summaries identifiable later — either through `captain-memo observation list` output (exact filter mechanism TBD during implementation; see "Verify during implementation" below) or via MCP search filters.

### 2. Identifier-match boost

**Goal.** When a user searches for a literal code token (`contract_bills.fee`, `useEffect`), the chunk that contains it verbatim should beat a chunk that's vaguely "about billing".

**Detector** — new module function:

```typescript
// src/worker/rerank.ts
export function extractIdentifierTokens(query: string): string[]
```

Match rule: a query token qualifies if it
- contains `_`, `.`, or `/` (snake_case, dotted paths, file paths), OR
- matches camelCase via `/[a-z][a-zA-Z]*[A-Z]/`.

Whitespace-tokenize first; punctuation that *defines* an identifier (`_`, `.`, `/`) is preserved inside tokens.

Catches: `contract_bills.fee`, `foo.bar`, `src/main.py`, `useEffect`, `MyClass`.
Skips: `billing`, `payment`, `user`, `total` — these are exactly where pure semantic should win.

**Boost mechanism.** In `HybridSearcher.search`, after RRF fusion and before `slice(0, topK)`:

1. Extract identifier tokens from the query.
2. For each of the fused top candidates (small set, ~25), fetch chunk content via existing chunk-store accessor.
3. For each fused item, count how many identifier tokens appear verbatim in the chunk text.
4. Apply boost: `score *= 1 + 0.3 * matched_token_count`, capped at `2.0×`.

The cap prevents a query like `foo.bar.baz.qux.quux` from amplifying a single chunk into runaway dominance.

**Disable knob.** Env var `CAPTAIN_MEMO_IDENTIFIER_BOOST=0` disables. Default: enabled.

### 3. Branch metadata + soft same-branch boost

**Goal.** Stop debugging notes from PR-A polluting recall on PR-B. Capture cheap; retrieval bias is soft (never hides cross-branch results).

**Capture side.** In `src/worker/observation-queue.ts`, at the moment an observation is enqueued:

```typescript
const branch = await detectBranch(observation.cwd);
// detectBranch shells out: git -C <cwd> rev-parse --abbrev-ref HEAD 2>/dev/null
// Returns string or null. Null if cwd is not in a git repo, git missing, or any error.
```

Store in new column `observations.branch TEXT NULL`.

**Schema migration.** At worker startup in `src/worker/meta.ts`:

```sql
ALTER TABLE observations ADD COLUMN branch TEXT;
```

Guard with a column-exists check (idempotent). No data backfill — existing rows get NULL, which is fine. SQLite handles `ALTER TABLE ADD COLUMN` cleanly.

**Retrieval side.** At search time:

1. Detect `current_branch` from the worker's cwd (same `detectBranch` helper).
2. Apply branch boost in the rerank pass, *after* identifier boost:
   `score *= 1.1` if `chunk.branch === current_branch && current_branch !== null`.
3. If `current_branch` is null (worker not in a git repo) or chunk's branch is null: skip the branch boost entirely. Cross-branch ranking falls back to semantic + identifier only.

**Disable knob.** Env var `CAPTAIN_MEMO_BRANCH_BOOST=0` disables. Default: enabled.

### Bonus: `Version:` in stats text output

In `src/cli/commands/stats.ts`, between the `Project:` and `Indexing:` lines:

```typescript
console.log(`Version:        ${stats.version ?? 'unknown'}`);
```

`stats.version` is already returned by the worker — nothing else changes. The `--json` output is unaffected (already contains `.version`).

## Shared rerank module

All three boosts share `src/worker/rerank.ts`:

```typescript
export interface RerankContext {
  query: string;
  currentBranch: string | null;
  getChunk: (id: string) => Promise<ChunkRow | null>;
}

export interface ChunkRow {
  id: string;
  content: string;
  branch: string | null;
}

export async function applyBoosts(
  fused: FusedItem[],
  ctx: RerankContext,
): Promise<FusedItem[]>
```

Keeping all three boosts in one module means future tuning, telemetry, or A/B comparison happens in one place — and adding a fourth signal later doesn't require re-touching the search core.

## Boost parameter table

| Boost | Coefficient | Cap | Disable env var | Rationale |
|---|---|---|---|---|
| Identifier match | `1 + 0.3 × N` per matched token | `2.0×` | `CAPTAIN_MEMO_IDENTIFIER_BOOST=0` | Multi-segment queries can match several tokens; cap prevents runaway dominance |
| Same-branch | `1.1×` (flat) | n/a | `CAPTAIN_MEMO_BRANCH_BOOST=0` | Soft preference, never hides results from other branches |

Numbers are starting defaults; tune with real-world telemetry post-release if needed.

## Schema migrations

| Column | Type | Nullable | Default | Backfill |
|---|---|---|---|---|
| `observations.branch` | TEXT | yes | NULL | none — old rows stay NULL |

Migration applied idempotently at worker startup. Downgrade-safe: SQLite ignores unknown columns; a v0.1.2 worker reading a v0.1.3 DB will simply not see the column.

## Test plan

| Layer | Coverage |
|---|---|
| Unit — `extractIdentifierTokens` | 12+ fixture inputs covering camelCase, dotted, snake_case, paths, mixed, plain English (negative cases) |
| Unit — `detectBranch` | cwd in git repo, detached HEAD, no git binary, non-existent path, plain non-git dir |
| Unit — `applyBoosts` | identifier-only boost, branch-only boost, both, neither; verify cap behaviour |
| Integration — hybrid search | fixture corpus with semantic-only and literal-match chunks; assert identifier query promotes literal match above pure-semantic |
| Integration — branch | two observations on different branches; query from one branch verifies same-branch ranks higher |
| Manual — PreCompact | trigger a real PreCompact in a CC session, verify an observation with `source: "pre-compact"` lands in the queue and survives reindex |

## Release plan

1. Bump `package.json` to `0.1.3`.
2. Commits — four small feature commits plus one release commit:
   - `feat(stats): show Version line in text output`
   - `feat(search): identifier-match boost for code-shaped query tokens`
   - `feat(observations): record git branch at capture + soft same-branch retrieval boost`
   - `feat(hook): PreCompact summarized-recap observation`
   - `chore: release v0.1.3`
3. Tag `v0.1.3` on the release commit, push to `origin` (fans out to GitHub + GitLab).
4. `gh release create v0.1.3` with hand-written notes covering the four features and how the boosts/hook are tuneable.
5. No README change unless integration semantics shift; `docs/statusline-integration.md` unchanged (the `version` field is already shown).

## Out of scope (explicit non-goals)

- Knowledge graph with typed edges. Heavy modeling burden, marginal recall lift.
- Web dashboard. `--json` + statusline cover inspection.
- Autonomous decay/consolidation. Silently drops information the user can't audit; `reindex` stays manual and honest.
- Per-query branch *filter* (hard restriction). We chose the soft boost; revisit only if real-world use surfaces a need.

## Verify during implementation

These are assumptions in this spec that should be confirmed in code as the first step of each task (not blocking design approval — these are normal "look at the code" checks):

1. **Observation envelope has a `source` field** (or we add one). #1 stores `source: "pre-compact"`; if no source field exists today, add it as a nullable string.
2. **Worker exposes a `getChunk(id)` accessor** that returns chunk text content. #2's reranker needs to read content for top-K fused candidates. If only embeddings/IDs are cached, add a thin SQL accessor.
3. **Schema bootstrap path** — confirm exact file (`meta.ts` is a likely candidate, but the migration belongs wherever existing `CREATE TABLE` statements live). Idempotency check: `PRAGMA table_info(observations)` and only run `ALTER TABLE` if `branch` column is absent.
4. **Observation `cwd` field** — confirm the observation envelope carries cwd at capture (needed for #3's branch detection). If not present, capture it from the originating hook's working directory.

## Open questions

None blocking implementation. Tuning numbers (boost coefficients) are deliberately starting points to be revised based on use, not pre-tuned via synthetic benchmarks.
