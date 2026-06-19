# P-OSS-Supersede — Supersede Backport to OSS — Design

- **Date:** 2026-06-18
- **Branch:** `feat/supersede-oss` (off `master`, the OSS edition; worktree `/home/kalin/projects/captain-memo`)
- **Status:** Design — backports the P3 "supersede stale facts (conservative first slice)" stack built on `federation` to the OSS `master` edition.
- **Source of truth:** the reviewed, merge-ready federation P3 implementation (commits `7ee6972`,`1d8a03c`,`d7ac237`,`acef2b3`,`07d6017`; final opus review READY-TO-MERGE, 0 Critical/Important, 7 invariants verified). This sub-project ports it; it does not re-derive the algorithm.

## 1. Goal

Bring the P3 supersede mechanism to OSS users: detect high-confidence same-entity version supersessions among observations and **demote (not hide)** the superseded rows at search time, fully reversibly, with **detection OFF by default** — shipped as an OSS release. P3 has no federation-only pieces, so the *entire* slice ports.

## 2. What ports / what's excluded

**Ports (everything — P3 is edition-agnostic):**
- `version-parse.ts` (pure parser), `supersede.ts` (pure slice + `applySupersedeDemotion`).
- `superseded_by` column (v12 migration) + `supersede_events` ledger + `linkSupersede`/`unlinkSupersede`/`supersededAmong`/`supersedeLinkCount`/`listSupersedeEvents` + `supersedeCandidateWindow` + the shared `surfacedWindowRows` extraction (`observations-store.ts`).
- `supersedeEnabled` QM config + `CAPTAIN_MEMO_QM_SUPERSEDE` gate (`qm.ts`).
- `superseded_by` field on the `Observation` type (`shared/types.ts`).
- `demoteSuperseded` wiring at the 3 observation-bearing search sites + `supersedePenalty` (`index.ts` + `search-config.ts`).
- The supersede sweep timer in `index.ts` (sibling of the QM dedup timer; reuses the hoisted `repVec`).
- `/stats` supersede link count + `captain-memo supersede list/undo` CLI (`index.ts`, `cli/commands/supersede.ts`, `cli/index.ts`).
- All P3 unit tests.

**Excluded:** nothing functional. P3 has zero remote/federation code. The only edition differences are the *shapes* of `search-config.ts` (OSS omits remote knobs) and `index.ts` (OSS `/search/all` is local-only, no remote-merge) — handled by hand-applying the P3 deltas to the OSS variants, not by dropping any P3 feature.

## 3. Port mechanism (verified)

Confirmed empirically (`git diff master c377928 -- <file>`, where `c377928` is the federation P3 base):
- **Byte-identical between `master` and federation-pre-P3** (diff = 0): `observations-store.ts`, `qm.ts`, `shared/types.ts`, `shared/title-similarity.ts`, `shared/merge-guard.ts`. Therefore the federation **HEAD** versions of `observations-store.ts`, `qm.ts`, `shared/types.ts` equal *master + the P3 additions* and **copy over cleanly**. (`title-similarity.ts`/`merge-guard.ts` were untouched by P3 — already identical, no copy needed.)
- **Diverged** (carry the OSS-vs-federation no-remote differences): `search-config.ts` (118 diff-lines) and `index.ts` (693 diff-lines) → **hand-apply** the P3 deltas.
- **CLI:** `master` already has `cli/commands/dedup.ts` (the exact pattern `supersede.ts` mirrors) and the same `cli/index.ts` registration structure.

**Mechanism:**
- **Clean-copy** (federation HEAD → this branch): `src/worker/version-parse.ts` (+`tests/unit/version-parse.test.ts`), `src/worker/supersede.ts` (+`tests/unit/supersede.test.ts`), `src/worker/observations-store.ts`, `src/worker/qm.ts`, `src/shared/types.ts`, `src/cli/commands/supersede.ts` (+`tests/unit/supersede-command.test.ts`), and the P3 additions to `tests/unit/observations-store.test.ts` and `tests/unit/qm.test.ts`.
- **Hand-apply:** `search-config.ts` (§4), `index.ts` (§5), `cli/index.ts` (register the `supersede` command — one import + one dispatch case + help line, mirroring `dedup`).
- **Fix test literals:** the new required `Observation.superseded_by` breaks any `Observation` object literal in master's tests (federation fixed `promotion-judge.test.ts` and `temporal-intent.test.ts`). Driven by `bun run typecheck` — fix each broken literal with `superseded_by: null`.

## 4. `search-config.ts` hand-apply (the OSS variant)

OSS `search-config.ts` lacks the federation remote knobs, so `supersedePenalty` is added by hand (NOT clean-copied):
- Add `supersedePenalty: number;` to the `RankConfig` interface (after `properNounBoostWeight`).
- `LEGACY.supersedePenalty = 1` (inert).
- `v2.supersedePenalty = 0.5` (matches federation — so enabling the sweep later activates demotion without a second knob; inert until links exist).
- `resolveRankConfig`: add `supersedePenalty: num(env.CAPTAIN_MEMO_SUPERSEDE_PENALTY, base.supersedePenalty)`.
- Append the config test (legacy=1, v2=0.5, env override).

## 5. `index.ts` hand-port (local-only)

`master`'s `index.ts` is the P-OSS local-only structure; it already carries the dedup timer block, `repVec` (inside that block), `dropArchived`/`dropByLookup`, `localSearchAll`, the 3 search sites, and the P2 `applyTemporalRerank` wiring. Apply the same P3 edits made on federation, **minus nothing** (P3 added no remote code):
- Hoist `repVec` above the dedup `if` block; delete the inner declaration (both timers reference the outer closure). Dedup behavior must stay byte-identical.
- Add the supersede sweep timer block (sibling of the dedup timer), gated `qmConfig.supersedeEnabled`, recording a `job: 'supersede'` qm_run; clear `qmSupersedeTimer` on shutdown alongside `qmDedupTimer`.
- Add the `demoteSuperseded` helper next to `dropArchived`; wire it as `demoteSuperseded(dropArchived(...), penalty)` at the 3 observation-bearing sites — `localSearchAll` return, `/search/observations`, `/inject/context` — **before** `applyTemporalRerank`. (On OSS `/search/all` is `localSearchAll` directly — no remote-merge — so the demote sits inside `localSearchAll`, identical to federation.) Do NOT wire `/search/memory` or `/search/skill`.
- Add the `/stats` `supersede: { links: obsStore ? obsStore.supersedeLinkCount() : 0 }` field next to the `qm` block.
- Imports: `runQmSupersedeSlice`, `applySupersedeDemotion` from `./supersede.ts`.

## 6. Decomposition (5 tasks; each independently testable)

1. **Core local stack** — clean-copy `version-parse.ts`, `supersede.ts`, `observations-store.ts`, `qm.ts`, `shared/types.ts` + their tests (`version-parse.test.ts`, `supersede.test.ts`, the P3 additions to `observations-store.test.ts` and `qm.test.ts`); fix any `Observation` test literals the new required field breaks. `bun test` (the copied + affected suites) + `bun run typecheck` green (modulo the known pre-existing `restart.test.ts:46` TS2769).
2. **OSS `search-config.ts`** — hand-apply `supersedePenalty` (interface + LEGACY + v2 + env) + the config test. `bun test tests/unit/search-config.test.ts` + typecheck.
3. **`index.ts` hand-port** — repVec hoist + supersede timer + `demoteSuperseded` + 3 sites + `/stats` + imports (local-only). Full worker-affecting suites + typecheck. Dedup path byte-identical; legacy/v2-no-links search byte-identical.
4. **CLI** — clean-copy `cli/commands/supersede.ts` + register in `cli/index.ts` (import + dispatch case + help, mirroring `dedup`) + clean-copy `supersede-command.test.ts`. `bun test tests/unit/supersede-command.test.ts` + typecheck.
5. **Release `0.13.0`** — bump the 6 release files (`package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `CHANGELOG.md`, and the two compiled `plugin/dist/*` bundles) per the repo's release ritual; rebuild the bundles (`bun run build:plugin`) so the committed-bundle freshness + manifest-parity tests (`plugin-manifest.test.ts`) pass. CHANGELOG entry: "supersede stale facts — version-aware supersede detection (off by default) + demote-not-hide at search; `captain-memo supersede` CLI". Full `bun test` + typecheck.

## 7. Testing & verification

- **Unit + typecheck** is the gate: the ported modules carry the same tests that passed on federation (122 P3-related tests there); `bun run typecheck` clean except the known pre-existing `restart.test.ts:46`.
- **Zero-change-when-off:** with `CAPTAIN_MEMO_QM_SUPERSEDE` unset (default), no links are created → search unchanged. With `legacy` (penalty 1) or `v2`-with-no-links, `demoteSuperseded`/`applySupersedeDemotion` return the input array unchanged → byte-identical. So the `0.13.0` release changes nothing out of the box (covered by the version bump + CHANGELOG).
- **No dedup regression:** the `repVec` hoist + `surfacedWindowRows` extraction must leave the existing OSS dedup path byte-identical (Task 3 review focus).
- **Behavioral parity:** the algorithm is identical to the federation stack already verified, so a separate OSS metric run is optional. Live measurement (enabling the sweep on a real corpus) is the human's post-merge action, per the federation plan's Task 5 Step 10.

## 8. Risks & out of scope

- **`index.ts` hand-port drift** (Task 3): `master`'s `index.ts` is the pre-existing local-only structure; the port must match its handler shapes. Mitigated — master already carries the dedup block / `repVec` / `dropArchived` / `localSearchAll` / 3 sites / temporal wiring from P-OSS, so the P3 edits map directly; the `/search/all`-has-no-remote difference is exactly why the demote sits in `localSearchAll` (as on federation).
- **Test-literal breakage** (Task 1): the new required `superseded_by` field breaks `Observation` object literals — `bun run typecheck` catches each; fix with `superseded_by: null`.
- **Release-ritual completeness** (Task 5): the repo gates on manifest-version parity + committed-bundle freshness (`plugin-manifest.test.ts`); Task 5 must bump all manifests + rebuild the bundle so those tests pass — do not ship drift.
- **Out of scope:** the federation P3 follow-ons (slice 2 hide-by-default + history-intent; slice 3 fuzzy/LLM extraction; slice 4 undated-memory). Enabling detection on a live corpus + the marketplace publish are the human's actions after this branch is reviewed.
