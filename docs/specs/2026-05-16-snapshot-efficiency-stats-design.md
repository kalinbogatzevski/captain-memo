# Snapshot Efficiency Stats — Design

**Date:** 2026-05-16
**Status:** Approved — ready for implementation plan
**Scope:** Sub-project A of the "Captain Memo efficiency stats" effort

## Context

Captain Memo already computes a per-recall efficiency number. `renderSavingsBadge`
in `src/worker/envelope.ts` compares each observation's stored `work_tokens` (the
size of the original session work it distilled) against the `readTokens` it costs
to inject the recalled snippet — that is the "saved 86%" badge users see in the
recall envelope.

What is missing is an **aggregate, corpus-wide** view of efficiency. Users want to
see, at a glance, how much session work the corpus represents versus what it costs
to store, plus how the indexing/embedding pipeline is performing.

The broader effort was decomposed into two independent sub-projects:

- **Sub-project A (this spec) — Snapshot efficiency.** Stats computable from the
  current corpus + worker state. No per-event tracking, no opt-in, no recall
  hot-path changes.
- **Sub-project B (separate spec) — Recall savings tracking.** Lifetime + per-session
  recall savings. Requires extending the recall pipeline to record token figures
  per recall event and persisting an accumulator. **Out of scope here.**

This spec covers Sub-project A only.

## Goals

Surface three snapshot efficiency figures in the `/stats` worker endpoint and the
`/captain-memo:stats` skill:

1. **Corpus compression** — total `work_tokens` distilled vs total `stored_tokens`
   paid to store it, expressed as a ratio and a "% saved", with honest coverage
   disclosure.
2. **Embedder efficiency** — embed call count, average latency, tokens/sec
   (since worker start).
3. **Dedup efficiency** — share of documents that skipped re-embedding because
   their content sha was unchanged (since worker start).

## Non-goals

- Per-recall, lifetime, or per-session recall savings (Sub-project B).
- The recall-audit log (`recall-audit.jsonl`) — untouched.
- Persisting embedder/dedup counters across worker restarts.
- Any change to the SessionStart banner or statusline cache producer (they keep
  consuming plain `/stats`; the new field is additive).

## Key constraint

`/stats` is **not** a cold path: the SessionStart hook and the statusline cache
producer both fetch it. The compression figure must therefore not add O(corpus)
tokenization to `/stats`. The chosen approach (materialized column, see below)
keeps `/stats` to O(1) aggregate queries.

## Design

### 1. Data model — observations-store migration v3

Append one migration to `OBSERVATIONS_STORE_MIGRATIONS` in
`src/worker/observations-store.ts`, mirroring the existing `add_work_tokens`
migration:

```ts
{
  version: 3,
  name: 'add_stored_tokens',
  up: (db) => db.exec('ALTER TABLE observations ADD COLUMN stored_tokens INTEGER'),
}
```

`stored_tokens` is nullable (like `work_tokens`). It holds the token count of the
observation's rendered chunk text — the actual cost paid in the corpus to store
that observation.

`work_tokens` (already exists, migration v2) = raw session work distilled.
`stored_tokens` = cost to store it. The ratio of the two is the compression number.

The `Observation` type in `src/shared/types.ts` and the `ObservationsStore.hydrate`
/ `insert` methods gain `stored_tokens` handling, consistent with how `work_tokens`
is already threaded.

### 2. Capture point — at ingest

In `ingestObservation()` in `src/worker/index.ts` (~line 374), after `chunksWithIds`
is built, the chunk text is already in hand:

```ts
const storedTokens = chunksWithIds.reduce((n, c) => n + countTokens(c.text), 0);
obsStore.setStoredTokens(obs.id, storedTokens);
```

`setStoredTokens(id, tokens)` is a new `ObservationsStore` method
(`UPDATE observations SET stored_tokens = ? WHERE id = ?`).

The same capture is applied at the second `chunkObservation` call site in
`index.ts` (~line 914, the reindex path). Because the reindex path also writes
`stored_tokens`, **backfill is automatic**: `captain-memo reindex` and
`captain-memo upgrade` (which already rechunks for v0.1.8) repopulate the column
for every existing observation. No separate backfill script.

Cost: one `countTokens()` call per observation at index time — off the `/stats`
hot path entirely.

### 3. Worker counters — embedder & dedup (in-memory, since-startup)

A small `WorkerMetrics` object owned by the worker process:

```ts
interface WorkerMetrics {
  embedCalls: number;
  embedTokens: number;       // sum of tokens submitted to embedder.embed()
  embedMs: number;           // sum of wall-clock ms across embed calls
  docsSeen: number;          // documents the indexer considered
  docsSkippedUnchanged: number; // skipped because documents.sha was unchanged
}
```

- `embed*` counters wrap `embedder.embed()` timing in the worker.
- `docs*` counters increment where the worker compares `documents.sha` and
  short-circuits an unchanged document.

These are plain in-process counters, reset on worker restart — honest
"since worker start" semantics for a snapshot stat. Lifetime accumulation is
deliberately Sub-project B's concern.

### 4. `/stats` payload — new `efficiency` field

The `/stats` handler in `src/worker/index.ts` adds an `efficiency` object built
from two cheap aggregate queries on the observations DB plus the in-memory
counters. No tokenization happens in the handler.

```json
"efficiency": {
  "corpus": {
    "work_tokens": 184320,
    "stored_tokens": 11240,
    "ratio": 16.4,
    "saved_pct": 94,
    "coverage": { "with_data": 312, "total": 340 }
  },
  "embedder": {
    "calls": 47,
    "avg_latency_ms": 690,
    "tokens_per_s": 4100
  },
  "dedup": {
    "docs_seen": 512,
    "skipped_unchanged": 488,
    "skip_pct": 95
  }
}
```

Two new `ObservationsStore` methods power `corpus`:

- `sumWorkTokens(): { sum: number; count: number }` —
  `SELECT SUM(work_tokens), COUNT(work_tokens) FROM observations`
- `sumStoredTokens(): { sum: number; count: number }` — same for `stored_tokens`

`coverage.with_data` is the count of observations that actually have `work_tokens`;
`coverage.total` is `countAll()`. The remainder predate migration v2 or have not
been reindexed.

### 5. Pure efficiency formatter

The ratio / percent / coverage math is extracted into a **pure function**
`computeEfficiency()` — mirroring how `renderSavingsBadge` in `envelope.ts` is
already a pure, independently testable unit. The `/stats` handler calls it with
the raw sums; the function owns all the edge-case logic.

Edge cases handled by `computeEfficiency()`:

- `work_tokens` sum is 0, or `coverage.with_data` is 0 → `ratio: null`,
  `saved_pct: null`. The skill renders a "run reindex" hint instead of a
  misleading number.
- Division by zero guarded throughout.
- `ratio` = `work / stored`, rounded to 1 decimal.
- `saved_pct` = `round(100 * (work - stored) / work)`, clamped to `[0, 100]`.

`embedder` / `dedup` with zero activity still emit (zeroed); the skill renders
"—". `avg_latency_ms` and `tokens_per_s` guard against zero `calls` / zero `ms`.

### 6. `stats` skill / CLI output

`statsCommand` in `src/cli/commands/stats.ts` gains an "Efficiency" block, and
`plugin/skills/stats/SKILL.md` is updated to document it.

Human output:

```
Efficiency
──────────
  Compression:    16.4× — distilled 184,320 tokens of work into 11,240 stored
                  (94% saved · based on 312/340 observations)
  Embedder:       47 calls · ~690 ms avg · 4.1k tok/s   (since worker start)
  Dedup:          95% of docs skipped re-embed (488/512 unchanged)
```

When `corpus.coverage.with_data === 0` (or `ratio` is null):

```
  Compression:    — (run 'captain-memo reindex' to populate)
```

shown in yellow (`\x1b[33m`), consistent with the existing indexing-status colour
convention in `stats.ts`.

`--json` already dumps the whole `/stats` response, so it picks up `efficiency`
with no extra code.

The `StatsResponse` interface in `stats.ts` gains the `efficiency` field as
optional (`efficiency?: {...}`), so the CLI degrades gracefully against an older
worker that does not emit it.

## Testing

- **Unit — `ObservationsStore`:** migration v3 applies cleanly; `sumWorkTokens` /
  `sumStoredTokens` ignore NULL rows; `setStoredTokens` round-trips; `insert` /
  `hydrate` thread `stored_tokens`.
- **Unit — `computeEfficiency()`:** zero-coverage, zero-work, and normal cases;
  ratio rounding; `saved_pct` clamping; division-by-zero guards.
- **Unit — `WorkerMetrics`:** counters accumulate; averages with zero calls do
  not divide by zero.
- **Integration:** ingest an observation with a known `work_tokens` value, assert
  `stored_tokens` populates and the `/stats` `efficiency` payload shape + computed
  `ratio` / `saved_pct` are correct.

## Files touched

- `src/worker/observations-store.ts` — migration v3, `setStoredTokens`,
  `sumWorkTokens`, `sumStoredTokens`.
- `src/shared/types.ts` — `Observation.stored_tokens`.
- `src/worker/index.ts` — capture `stored_tokens` at both `chunkObservation`
  sites; `WorkerMetrics` object + counter increments; embed-timing counters
  wrapping the `embedder.embed()` call sites in the worker (not `embedder.ts`
  internals, keeping metrics a worker-process concern); `efficiency` in `/stats`.
- New: pure `computeEfficiency()` formatter (own module, e.g.
  `src/worker/efficiency.ts`).
- `src/cli/commands/stats.ts` — `StatsResponse.efficiency`, "Efficiency" block.
- `plugin/skills/stats/SKILL.md` — document the new section.
- Tests under `tests/unit/` and `tests/integration/`.
