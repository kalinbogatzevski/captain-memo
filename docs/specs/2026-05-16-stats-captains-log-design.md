# Stats Efficiency Fix + Captain's Log Revamp — Design

**Date:** 2026-05-16
**Status:** Approved — ready for implementation plan
**Follows:** `docs/specs/2026-05-16-snapshot-efficiency-stats-design.md` (sub-project A)

## Context

Sub-project A shipped efficiency stats in `/stats` and `captain-memo stats`. Running it
against the real corpus exposed one correctness bug and one missing capability, and the
user asked for a visual revamp of the stats command. This spec covers all three as one
cohesive change.

1. **Mismatched-population ratio (bug).** `computeEfficiency` sums `work_tokens` and
   `stored_tokens` independently — each over whatever rows are non-null. On the live
   corpus those are different populations (7,472 observations have `work_tokens`, ~10
   have `stored_tokens`), so `ratio = workSum / storedSum` divides sums describing
   different rows and produces a meaningless number (`6298×`, `100% saved`).

2. **No cheap `stored_tokens` backfill.** `stored_tokens` is captured at index time, so
   ~10.6K historical observations have it `NULL`. Plain `reindex` skips already-correctly-
   chunked observations (`index.ts:1016-1027`), so it cannot backfill. `reindex --force`
   would, but wastefully re-embeds the whole corpus — embedding is not needed to *count*
   tokens.

3. **Stats display is plain and not TTY-aware.** `captain-memo stats` emits raw `\x1b[…m`
   escapes unconditionally (broken under `| cat`) and has no table structure. The user
   wants an ANSI, coloured, table-formatted "impressive" layout.

## Goals

- The compression ratio is mathematically valid — both sums describe the same observations.
- Historical observations get `stored_tokens` populated cheaply (no embedding), with no
  command for the user to remember.
- `captain-memo stats` renders as a framed, coloured, nautical-themed panel, and degrades
  cleanly to plain text when not a TTY or when `NO_COLOR` is set.

## Non-goals

- Sub-project B (recall savings tracking) — separate effort.
- Changing the `/stats` JSON shape beyond the `efficiency.corpus` fields.
- Reworking any CLI command other than `stats`.

## Design

### Component 1 — Ratio-correctness fix

**`src/worker/observations-store.ts`** — replace `sumWorkTokens()` and `sumStoredTokens()`
with a single paired query:

```ts
sumPairedTokens(): { work: number; stored: number; paired: number } {
  const r = this.db.query(
    `SELECT COALESCE(SUM(work_tokens), 0)   AS work,
            COALESCE(SUM(stored_tokens), 0) AS stored,
            COUNT(*)                        AS paired
     FROM observations
     WHERE work_tokens IS NOT NULL AND stored_tokens IS NOT NULL`
  ).get() as { work: number; stored: number; paired: number };
  return r;
}
```

`sumWorkTokens` / `sumStoredTokens` are removed (no other callers).

**`src/worker/efficiency.ts`** — `EfficiencyInput` collapses to:

```ts
export interface EfficiencyInput {
  workSum: number;          // SUM(work_tokens)   over paired observations
  storedSum: number;        // SUM(stored_tokens) over the SAME observations
  pairedCount: number;      // observations carrying BOTH values
  totalObservations: number;
  metrics: WorkerMetrics;
}
```

`computeEfficiency`: `hasCorpus = pairedCount > 0 && workSum > 0 && storedSum > 0`.
`coverage` becomes `{ with_data: pairedCount, total: totalObservations }` — `with_data` now
honestly means "observations with complete (paired) data". `ratio` and `saved_pct` logic is
otherwise unchanged. `EfficiencyReport` shape is unchanged.

**`src/worker/index.ts`** `/stats` handler — replace the two independent sum calls with:

```ts
const paired = obsStore
  ? obsStore.sumPairedTokens()
  : { work: 0, stored: 0, paired: 0 };
const efficiency = computeEfficiency({
  workSum: paired.work, storedSum: paired.stored, pairedCount: paired.paired,
  totalObservations: obsTotal, metrics,
});
```

### Component 2 — `stored_tokens` backfill on worker startup

**`src/worker/observations-store.ts`** — add two helpers:

```ts
countMissingStoredTokens(): number {
  return (this.db.query(
    'SELECT COUNT(*) AS n FROM observations WHERE stored_tokens IS NULL'
  ).get() as { n: number }).n;
}

listMissingStoredTokens(limit: number): Observation[] {
  const rows = this.db.query(
    'SELECT * FROM observations WHERE stored_tokens IS NULL ORDER BY id ASC LIMIT ?'
  ).all(limit) as Array<Record<string, unknown>>;
  return rows.map(r => this.hydrate(r));
}
```

**`src/worker/index.ts`** — a background backfill pass in `startWorker()`, kicked off
alongside the existing initial-indexing pass (non-blocking; the HTTP server is already up):

```ts
// One-time stored_tokens backfill. The column is captured at index time, so
// observations indexed before v0.1.9 have it NULL. Pure CPU — chunk + count
// tokens, NO embedder calls. Resumable + idempotent: a later boot with nothing
// missing is a no-op. Runs in batches so a setStoredTokens write never races a
// live SELECT cursor.
if (obsStore) {
  const missing = obsStore.countMissingStoredTokens();
  if (missing > 0) {
    console.error(`[worker] stored_tokens backfill: ${missing} observations`);
    void (async () => {
      const BACKFILL_BATCH = 200;
      let done = 0;
      for (;;) {
        const batch = obsStore.listMissingStoredTokens(BACKFILL_BATCH);
        if (batch.length === 0) break;
        for (const obs of batch) {
          const rawChunks = chunkObservation(obs);
          const chunks = rawChunks.length > 0
            ? splitForEmbed(rawChunks, effectiveMaxInputTokens)
            : [];
          const tokens = chunks.reduce((n, c) => n + countTokens(c.text), 0);
          obsStore.setStoredTokens(obs.id, tokens);
          done++;
        }
      }
      console.error(`[worker] stored_tokens backfill complete: ${done} observations`);
    })();
  }
}
```

An observation whose chunker yields nothing is set to `stored_tokens = 0` (it occupies no
corpus space) — this also removes it from the `IS NULL` set so the loop terminates.

Result: restart the worker once → every observation has `stored_tokens`, the paired ratio
becomes real. No `reindex`, no embedder cost.

### Component 3 — Framed Captain's Log display

**`src/shared/ansi.ts`** — honour the `NO_COLOR` convention: `isTTY()` returns false when
`process.env.NO_COLOR` is set (any value), so all `wrap()`-based helpers drop colour.

**`src/cli/stats-render.ts`** *(new)* — a pure renderer plus a bar helper:

```ts
export function bar(fraction: number, width: number): string;   // '▕████░░▏'
export function renderStats(stats: StatsResponse): string[];
```

- `bar(fraction, width)` — clamps `fraction` to `[0,1]`, fills `round(fraction*width)`
  cells with `█`, the rest with `░`, wraps the result in `▕`…`▏`.
- `renderStats` returns the full output as `string[]` (testable without capturing stdout).
  `StatsResponse`, `indexingLine`, and the old `formatEfficiencyLines` logic all move into
  this module; `formatEfficiencyLines` ceases to be a separate export.
- Colour comes exclusively from `src/shared/ansi.ts` helpers — no raw `\x1b` escapes — so
  output is automatically TTY-aware and `NO_COLOR`-aware.

**Layout** (fixed inner width `PANEL_WIDTH = 57`):

```
╭─────────────────────────────────────────────────────────╮
│  ⚓  CAPTAIN MEMO        corpus statistics   ·   v0.1.9   │
╰─────────────────────────────────────────────────────────╯
  Project    default
  Indexing   ● ready · 279/279 in 0s
  Embedder   voyage-4-lite · api.voyageai.com
  Disk       491.3 MB

  CORPUS ──────────────────────────────────────────────────
   Channel          Chunks
   memory               279   ▕░░░░░░░░░░░░░░░░░░░░▏
   observation       24 272   ▕████████████████████▏
   ─────────────────────────
   Total             24 551     10 593 observations

  EFFICIENCY ──────────────────────────────────────────────
   Compression     13.1×     ▕██████████████████░░▏  92%
   Embedder        47 calls · ~690 ms · 4 100 tok/s
   Dedup           100%      10 870 / 10 870 unchanged
```

- Only the header is a full box (`╭╮╰╯`); `CORPUS` / `EFFICIENCY` are section rules drawn
  to `PANEL_WIDTH`. Content rows are unbordered (no per-line right-pad needed).
- The header line pads accounting for the anchor glyph `⚓` rendering 2 columns wide
  (same assumption `banner.ts` already documents).
- Palette (from `banner.ts`): `cyanBold` panel border + section titles, `goldBold` the
  `⚓ CAPTAIN MEMO` wordmark, `dim` labels, `green`/`yellow`/`red` `●` status dot keyed to
  `indexing.status` (`ready`→green, `indexing`→yellow, `error`→red, `idle`→dim).
- Channel bars are scaled to the largest channel count. The compression bar fraction is
  `saved_pct / 100`.
- Counts render with thousands grouping via `toLocaleString('en-US')` then spaces
  (`24 272`), through a `fmtCount` helper.
- When `efficiency.corpus.ratio` is null, the Compression row shows a `dim` hint
  `— populating… (restart worker)` instead of a bar.
- `statsCommand` keeps the `--json` early return verbatim; otherwise it becomes
  `for (const line of renderStats(stats)) console.log(line)`.

## Testing

- **Unit — `observations-store`:** `sumPairedTokens` ignores rows missing either column
  and sums only fully-paired rows; `countMissingStoredTokens` / `listMissingStoredTokens`
  return the right rows and respect `limit`.
- **Unit — `computeEfficiency`:** new `EfficiencyInput` shape — normal paired corpus,
  `pairedCount === 0` → null ratio, `storedSum > workSum` → `saved_pct` clamped to 0.
- **Unit — `bar`:** 0%, 100%, mid fraction, fraction <0 / >1 clamped, exact cell counts.
- **Unit — `stats-render`:** feed a fixed `StatsResponse`; assert (after ANSI-stripping)
  the header wordmark, every section, the channel bars, the Compression row; assert the
  header panel's three border lines are equal width; assert the null-ratio hint path.
- **Integration:** boot a worker on an observations DB pre-seeded with rows lacking
  `stored_tokens`; after startup, assert the backfill populated them and `/stats`
  `efficiency.corpus.ratio` is a real number with `coverage.with_data` equal to the paired
  count.

## Files touched

- `src/worker/observations-store.ts` — `sumPairedTokens` (replaces the two sum methods);
  `countMissingStoredTokens`, `listMissingStoredTokens`.
- `src/worker/efficiency.ts` — `EfficiencyInput` reshaped; `computeEfficiency` uses
  `pairedCount`.
- `src/worker/index.ts` — `/stats` uses `sumPairedTokens`; background backfill pass.
- `src/shared/ansi.ts` — `NO_COLOR` support.
- `src/cli/stats-render.ts` — *new* — `bar`, `renderStats`, `fmtCount`, the moved
  `StatsResponse` + `indexingLine`.
- `src/cli/commands/stats.ts` — slimmed to fetch + `--json` + `renderStats`.
- Tests: `tests/unit/observations-store.test.ts`, `tests/unit/efficiency.test.ts`,
  `tests/unit/cli/stats-render.test.ts` (*new*, replaces `stats-efficiency.test.ts`),
  `tests/integration/worker-efficiency.test.ts`.
