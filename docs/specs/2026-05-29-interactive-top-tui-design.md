# Interactive `captain-memo top` TUI + recall content foundation

- **Date:** 2026-05-29
- **Status:** Approved (design), implementation pending
- **Target version:** v0.1.16
- **Supersedes (partially):** the `watch`-based live stats wrapper (v0.1.14) — `watch` becomes a deprecated alias.

## Motivation

Two user-reported problems and one direction change:

1. **"Top surfaced" looks like duplicates.** The summarizer generates several
   near-identical observations for one fact (e.g., five phrasings of
   "update-status skill is available"), each surfaced the same number of times.
   The top list faithfully reports them, so all slots are eaten by one concept.
2. **No realtime sense of activity.** The user wants to see what Captain is
   doing *now* — what was most recently surfaced, via which path.
3. **`watch` is a blunt instrument.** It reprints a static frame every N
   seconds with zero interactivity: no sort, no filter, no drill-in. The user
   asked for a `top`/`htop`-style interactive view with hotkeys.

## Goals

- Collapse near-duplicate entries in the dashboard's top lists, summing counts
  and annotating the variant count, so the overview shows distinct concepts.
- Surface a live "last surfaced" pulse and a "recently surfaced" list.
- Physically de-duplicate the corpus on demand (reversible archival merge).
- Replace `watch` with an interactive `captain-memo top` TUI: dashboard
  overview, drill into a focused navigable table, drill into one full
  observation. Inspecting an observation counts as a `drill` retrieval.

## Non-goals

- Semantic clustering / the full Local Dreaming write-path (still deferred per
  `2026-05-27-local-dreaming-design.md`). The `dedup` command here is a narrow,
  title-similarity-only merge, not theme synthesis.
- Mouse support. Keyboard only.
- Persisting TUI preferences across runs (sort/filter reset each launch).

---

## Unit A — recall content foundation

Prerequisite for both `stats` and `top`'s dashboard.

### A1. Schema migration v7 — `last_surfaced_source`

```sql
ALTER TABLE observations ADD COLUMN last_surfaced_source TEXT;
```

- NULL for all historical rows (the source of the last pre-v7 bump is unknown).
- Going forward, `bumpRetrieval(ids, source)` stamps
  `last_surfaced_source = source` alongside the existing `last_surfaced_at`.
- One of `'auto'` | `'search'` | `'drill'` | NULL.

### A2. `title-similarity` module (`src/shared/title-similarity.ts`, pure)

Shared by the dashboard collapse (A4) and the `dedup` command (Unit C).

- `normalizeTitle(s)`: lowercase; strip a trailing `…` / `...`; collapse
  internal whitespace; trim.
- `significantTokens(s)`: split the normalized title on `/[^a-z0-9]+/`; drop
  tokens of length < 3 and a small curated stopword set
  (`the and for with that this into from was were are has have had its but not
  you your our out via per all any can did does`). Returns a `Set<string>`.
  - Tradeoff: length < 3 drops short identifiers (`db`, `ui`). Acceptable for
    descriptive observation titles; documented so it is a deliberate choice.
- `jaccard(a: Set, b: Set)`: `|a ∩ b| / |a ∪ b|`. Returns `0` when the union is
  empty (never merges title-less rows by similarity).
- `groupBySimilarity(items, getTitle, threshold)`: greedy grouping. Items are
  consumed in input order (caller pre-sorts by count desc so the representative
  is the highest-count phrasing). For each ungrouped item, open a new group with
  it as representative; add any later ungrouped item whose
  `jaccard(repTokens, itemTokens) >= threshold`. Returns `Array<item[]>` in
  representative order.
- `DEFAULT_SIMILARITY_THRESHOLD = 0.5`.

### A3. Store: `getRecentlySurfaced(n)`

```sql
SELECT id, type, title, last_surfaced_at, last_surfaced_source
  FROM observations
 WHERE last_surfaced_at IS NOT NULL AND archived = 0
 ORDER BY last_surfaced_at DESC, id DESC
 LIMIT ?;
```

Returns `RecentSurfacedEntry[]` (`source: RetrievalSource | null`).

### A4. Store: `getRecallStats` changes

- **Exclude archived** from every query (`AND archived = 0`).
- **Collapse near-dupes** in `top_surfaced` and `top_recalled`:
  1. Fetch up to `CANDIDATE_CAP = 200` rows ordered by the relevant metric
     (total bumps for surfaced; `from_drill` for recalled).
  2. `groupBySimilarity(candidates, r => r.title, DEFAULT_SIMILARITY_THRESHOLD)`.
  3. For each group, build a representative entry: title/type/id of the first
     (highest-count) member; `from_*` = **sum** across the group;
     `last_surfaced_at` = max; `variants` = group length.
  4. Re-sort representatives by summed metric desc (tie: `last_surfaced_at`
     desc); take `topN`.
- Add `recent_surfaced: RecentSurfacedEntry[]` (via `getRecentlySurfaced`).

### A5. Search post-filter (archived suppression)

The live search path (`vec_chunks`, `chunks_fts`, `/inject/context`) does not
currently consult `archived`. Add a post-filter that drops any result hit whose
backing observation is `archived = 1`. Reversible (un-archive restores) with no
vector mutation. Applied centrally so all of `/search/*` and `/inject/context`
benefit.

### A6. Renderer additions (`stats-render.ts`)

- **Pulse line** under the Recall subheader, from `recent_surfaced[0]`:
  `Last surfaced  <age> · [type] <title…> · <source>`. Age in `cyanBold` (live
  value); the source token uses the provenance triad color
  (auto=gold, search=cyan, drill=green, null=dim) — consistent with the locked
  color discipline.
- **Recently surfaced block**: heading + N rows (`<age>  [type] <title…>
  <source>`), two-up across columns in wide mode (rows are 1 line each).
- **`(+N similar)`** suffix on collapsed top entries when `variants > 1`
  (title trimmed to leave room).

### Types touched

- `RecallTopEntry` (types.ts + stats-render): add optional `variants?: number`.
- New `RecentSurfacedEntry { id; type; title; last_surfaced_at; source }`.
- `RecallStats` / `StatsResponse.recall`: add `recent_surfaced`.

---

## Unit B — `captain-memo top` interactive TUI

### B1. Modes (state machine)

```
 dashboard  --s/r/n-->  table  --⏎-->  detail
     ^                    |  ^           |
     +-------- Esc -------+  +--- Esc ---+
 q / Ctrl+C quits from any mode.
```

- **dashboard** — the enhanced stats panel (reuses `renderStats`), auto-refresh.
- **table** — one list (`surfaced` | `recalled` | `recent`) full-screen,
  navigable.
- **detail** — one full observation (narrative, facts, concepts, files,
  provenance, timestamps), scrollable.

### B2. Keymap

Dashboard: `s`/`r`/`n` → table (surfaced/recalled/recent); `+`/`-` refresh
interval; `q`/Ctrl+C quit.

Table: `↑↓` / `jk` select; `PgUp`/`PgDn` page; `g`/`G` top/bottom; `o` cycle
sort (`total→auto→search→drill→recency`); `t` cycle type filter; `/` free-text
title filter (Enter apply, Esc cancel); `c` toggle near-dup collapse;
`Tab` cycle view; `⏎` drill → detail (bumps `from_drill`); `Esc` → dashboard;
`q` quit.

Detail: `↑↓` scroll; `Esc` → table; `q` quit.

### B3. Refresh discipline

- dashboard + table auto-refresh every `refreshIntervalMs` (default 2000).
- table preserves selection **by observation id** (re-locate after refresh) and
  scroll offset.
- detail and an active filter-input **pause** refresh.

### B4. Terminal lifecycle

- Enter: alt screen (`ESC[?1049h`), hide cursor (`ESC[?25l`), `setRawMode(true)`,
  `stdin.resume()`.
- Teardown (idempotent): show cursor, leave alt screen, `setRawMode(false)`.
  Registered on `SIGINT`, `SIGTERM`, `exit`, `uncaughtException`. The terminal is
  never left in raw mode.
- `process.stdout.on('resize')` recomputes layout and redraws.
- **Non-TTY** (piped stdout): render the dashboard once via `renderStats` and
  exit 0 — graceful degradation, no escape-sequence corruption.

### B5. Pure-vs-shell split (for testability)

- `parseKey(buffer) → { key, rest }` — pure byte→key decoder (arrows, PgUp/Dn,
  Home/End, Enter, Esc, Ctrl+C, Backspace, printable).
- `reduce(state, event) → state` — pure TUI state reducer.
- `buildFrame(state, data, dims) → string[]` — pure frame builder.
- The raw-mode shell (`top.ts`) wires stdin → parseKey → reduce → fetch →
  buildFrame → write. The shell is the thin untested edge.

### B6. New worker endpoints

- `GET /recall/list?view&sort&type&q&limit&offset&collapse` — server-side
  sort/filter/page for the table. `view ∈ {surfaced,recalled,recent}`,
  `sort ∈ {total,auto,search,drill,recency}`, `type` optional exact, `q`
  optional case-insensitive title substring, `limit` default 50 cap 500,
  `offset` default 0, `collapse` default `0` (raw rows; the table shows reality
  so dupes are inspectable/actionable — the dashboard is the collapsed view).
  Returns `{ rows: TableRow[]; total: number }`. Archived excluded.
- `GET /observation/full?id=N` — returns the full hydrated observation and bumps
  `from_drill` for `N`. 404 when not found.

### B7. `watch` deprecation

`captain-memo watch [seconds]` prints a one-line deprecation notice to stderr,
then runs `top` with the given interval. The external `procps`/`watch` binary
dependency is dropped entirely.

---

## Unit C — `captain-memo dedup`

Independent data tool. Depends on A5 (otherwise archived dupes keep surfacing).

- **Dry-run by default.** Prints proposed merge groups (representative +
  members it would archive) and the corpus-size delta. Nothing mutates.
- `--apply`: backs up the DB file first, then archives members into the
  representative — sums `from_*` into the survivor, `last_surfaced_at` = max,
  sets members `archived=1` and `archived_into_theme_id=<survivorId>`, records
  `theme_member_ids` (the merged ids) on the survivor for reversal.
  - Note: `archived_into_theme_id` is reused to mean "folded into observation
    id" (the survivor need not be `type='theme'` for a plain dedup). Documented.
- `--threshold N`: similarity threshold (shares `title-similarity`); default
  `0.5`.
- `--undo`: reverses a prior merge for a given survivor id (un-archive members,
  subtract the restored counts back out of the survivor).
- `--json`: machine-readable dry-run / apply report.

---

## Testing strategy (TDD throughout)

- `title-similarity`: normalize, tokens, jaccard, grouping (incl. the
  five-phrasing example and a no-false-merge case).
- store: v7 migration adds the column; `bumpRetrieval` stamps source;
  `getRecentlySurfaced` ordering + archived exclusion; `getRecallStats` collapse
  + summed counts + variants + archived exclusion.
- worker integration: search post-filter drops archived hits;
  `/recall/list` sort/filter/page; `/observation/full` returns + bumps drill.
- renderer: pulse line, recently-surfaced block, `(+N similar)` annotation.
- TUI pure pieces: `parseKey`, `reduce`, `buildFrame`.
- dedup: dry-run finds groups without mutating; `--apply` archives + sums;
  `--undo` restores.

## Refinements added during implementation

- **Help mode** (4th mode): `?` opens a key map + glossary overlay from dashboard
  or table; `Esc`/`?` returns, `q` quits, `Ctrl+C` always quits.
- **Live date/time clock** top-right in every mode (`⟳ YYYY-MM-DD HH:MM:SS · every Ns`),
  re-rendered each refresh so liveness is visible; frozen in paused modes.
- **Per-view default sort**: entering Surfaced/Recalled/Recent adopts
  total/drill/recency respectively; `s`/`r`/`n` switch views in the table too.
- **Fixed table columns**: shared widths for header + rows; numerics right-aligned.
- **Review-driven hardening**: `queryRecall` collapse `total` = pre-collapse match
  count (not group count) with a window-covering candidate fetch; deterministic
  id tie-break; `mergeDuplicateGroup` preserves NULL `last_surfaced_at`;
  `--undo` tolerates corrupted `theme_member_ids`; `top` sanitizes worker error
  text against ANSI injection and discards stale concurrent fetches (snapshot guard).

## Rollout / versioning

- Single feature → **v0.1.16**.
- Build on a clean (uncommitted) tree; install locally on the Captain and verify
  live; only then commit + tag + GitHub release in one batch, on explicit go.

## Risks / open questions

- **Similarity threshold tuning.** 0.5 collapses ~4/5 of the example dupes; the
  fifth ("registered and callable") is a genuinely weaker match. Dry-run review
  + `--threshold` is the mitigation.
- **Raw-mode teardown on crash.** Mitigated by registering teardown on
  `uncaughtException`/signals and keeping it idempotent.
- **`/recall/list` raw vs collapsed.** Dashboard collapses; table shows raw by
  default with a `c` toggle. Intentional, documented to avoid "the numbers
  differ" confusion.
