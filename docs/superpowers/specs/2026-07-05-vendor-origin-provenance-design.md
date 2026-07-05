# Vendor origin provenance (`origin_agent`) — Design

**Date:** 2026-07-05
**Status:** Design approved, ready for implementation plan.
**Target:** `captain-memo` (OSS master) first; mirror the same patch to `captain-memo-fed` (federation) afterward so both branches stay in sync at schema `v13`.
**Reference:** a complete, tested implementation already exists on the stale `grandplan/track-ac` branch (federation-only, commit `e4de845`, 2026-06-10, roadmap item **C1**). This design reuses that implementation almost verbatim, adapted for two things that changed since: the current 8-tool vendor matrix (was 4), and a migration-version collision (both branches have since claimed `v11`/`v12` for unrelated features).

## 1. Goal

Tag every captured `Observation` with which AI coding tool produced it (`origin_agent`), mirroring how federation already tags remote search hits with `origin_peer` — but at the local agent layer instead of the network layer. Foundational, forward-looking work: today only Claude Code has a hook-driven capture path, so in practice this will tag existing captures `'claude-code'` and leave the schema/plumbing ready for when another vendor's capture path (roadmap **C4**) lands.

## 2. Scope

**In scope:** the `observations` table and its capture pipeline (`post-tool-use.ts` / `pre-compact.ts` hooks → worker `/observation/enqueue` → `ObservationsStore` → `chunkObservation` → search/`get_full` result metadata), plus the one-time claude-mem import (`migration/transform.ts`).

**Out of scope:** the curated `memory` channel (`remember` MCP tool / `memory-writer.ts`). It's a separate corpus with no `origin_agent` field and was never part of the original design — adding provenance there would be new, undesigned scope. Also out of scope: inventing env-var detection heuristics for the 7 non-Claude-Code tools (`codex`/`cursor`/`gemini`/`opencode`/`vibe`/`vscode`/`jetbrains`) — none of them have a real hook path today, so there's nothing verified to detect against.

## 3. Architecture

New file `src/shared/origin-agent.ts` (ported near-verbatim from track-ac):

- `ORIGIN_AGENTS = ['claude-code', 'codex', 'cursor', 'gemini', 'opencode', 'vibe', 'vscode', 'jetbrains', 'unknown'] as const` — extended from the reference's 4 real vendors to the current 8-tool matrix (`src/cli/cross-ai.ts`'s `ADAPTERS` + `claude-code`), plus `'unknown'`.
- `type OriginAgent = (typeof ORIGIN_AGENTS)[number]`
- `UNKNOWN_ORIGIN_AGENT: OriginAgent = 'unknown'`
- `asOriginAgent(v: unknown): OriginAgent | null` — narrows an arbitrary stored/wire value to a valid enum member or `null`.
- `detectOriginAgent(env = process.env): OriginAgent` — **unchanged logic from the reference**: an explicit, recognized `AI_AGENT` env value wins; else `CLAUDECODE` or `CLAUDE_CODE_ENTRYPOINT` non-empty → `'claude-code'`; else `'unknown'`. Never throws (mirrors the existing `detectBranchSync` pattern). The 7 non-Claude-Code vendors are reachable today only via the explicit `AI_AGENT` override (useful for testing).

## 4. Data flow

1. **Capture** — `post-tool-use.ts` and `pre-compact.ts` each call `detectOriginAgent()` and attach `origin_agent` to the `RawObservationEvent` POSTed to `/observation/enqueue`.
2. **Ingest validation** — the worker's `ObservationEnqueueSchema` (Zod) gains `origin_agent: z.enum([...ORIGIN_AGENTS]).optional()`; an absent or non-conforming value is simply omitted, never a 400.
3. **Windowing** — when a queued window of raw events is summarized into one `Observation`, `origin_agent` is taken from the window's `head` event (`head.origin_agent ?? null`) — no majority-vote logic needed, since every event in one window comes from the same hook-driven session and therefore the same tool.
4. **Storage** — `ObservationsStore` migration **`v13: add_origin_agent`** (renumbered from the reference's now-colliding `v11`; both branches are independently at `v12` today via unrelated features, so `v13` is free and consistent on both): `ALTER TABLE observations ADD COLUMN origin_agent TEXT`, nullable, no default. `insertObservation` writes `obs.origin_agent ?? null`; `findById`/row-mapping reads back via `asOriginAgent(row.origin_agent)` (pre-v13 rows and unrecognized values both narrow to `null`).
5. **Chunking/surfacing** — `chunkObservation` stamps chunk metadata with `obs.origin_agent ?? UNKNOWN_ORIGIN_AGENT`, so a `null` at the store layer always renders as the concrete string `'unknown'` to any consumer (search hits, `get_full`) — never a missing/undefined field.
6. **Legacy import** — `migration/transform.ts` (one-time claude-mem importer) sets `origin_agent: null` for imported rows (claude-mem predates vendor provenance entirely; they read back as `'unknown'`).

## 5. Error handling

- `detectOriginAgent()` never throws — always resolves to a valid `OriginAgent`, defaulting `'unknown'` on any absent/unrecognized signal. Capture is never blocked by this feature.
- The new migration follows the existing additive-migration convention in `migrations.ts` — nullable column addition, already covered by `applyMigrations`'s existing idempotent-recovery-on-"duplicate column" handling. No new error-handling code required.
- Zod validation at the `/observation/enqueue` boundary rejects nothing new; an invalid `origin_agent` value is simply dropped (`.optional()`), not a request failure.

## 6. Testing

Port and adapt the reference's 4 test files to the current codebase shape:

- **Unit — `origin-agent.test.ts`**: `detectOriginAgent()` behavior (explicit `AI_AGENT` override incl. case/whitespace insensitivity, unrecognized `AI_AGENT` falls through, `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` detection, default `'unknown'`); `asOriginAgent()` narrowing (valid/invalid/non-string input).
- **Unit — `chunkers/observation.test.ts`**: `chunkObservation` stamps chunk metadata with the observation's `origin_agent`, defaulting to `'unknown'` when `null`.
- **Unit — `observations-store.test.ts`**: migration `v13` applies cleanly on a fresh DB and on a pre-v13 DB; insert/read roundtrip preserves `origin_agent`; a pre-migration row (column absent) and a row with an unrecognized stored value both read back as `null` (never throw).
- **Integration — `worker-observation.test.ts`**: end-to-end — a raw event carrying `origin_agent` reaches a persisted `Observation` and is surfaced in search/`get_full` result metadata.

## 7. Rollout

Build and verify on `captain-memo` (OSS master) first (`typecheck` + full unit/integration suite, matching the verification bar used for the `e2e.ts` relocation). Once green, apply the identical patch to `captain-memo-fed` (federation) — same migration number (`v13`), same files — keeping both branches' schemas in lockstep. No feature-flag or staged rollout needed: purely additive, nullable column, zero behavior change for existing consumers who don't reference the new field.
