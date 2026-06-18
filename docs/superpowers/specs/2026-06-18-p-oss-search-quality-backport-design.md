# P-OSS — Search-Quality Backport to OSS — Design

- **Date:** 2026-06-18
- **Branch:** `feat/search-quality-oss` (off `master`, the OSS edition; worktree `/home/kalin/projects/captain-memo`)
- **Status:** Design — backports the *local* search-quality stack built on `federation` (P0+P1+P2) to the OSS `master` edition.
- **Source of truth:** the reviewed, live federation implementation (fresh@1 0.357→0.643 verified there). This sub-project ports the edition-agnostic subset; it does not re-derive the algorithms.

## 1. Goal

Bring the search-quality improvements to OSS users: weighted hybrid fusion, temporal-intent recency re-rank, proper-noun boost, rank profiles, and the eval harness — shipped as an OSS release with **`v2` as the default ranking profile**. Exclude the federation-only remote pieces (OSS `/search/all` is local-only; there is no peer fan-out).

## 2. What ports / what's excluded

**Ports (the local stack):**
- Weighted hybrid fusion + per-call `rrfK`/`perStrategyTopK` (`search.ts`).
- Rare-token proper-noun boost (`rerank.ts`).
- `rank_profile` field on recall-audit (`recall-audit.ts`).
- Temporal-intent detector + recency-primary re-rank (`temporal-intent.ts`).
- Rank-profile config + resolver (`search-config.ts`, OSS variant — see §4).
- Eval harness + `captain-memo eval` CLI (`src/eval/*`, `src/cli/commands/eval.ts`) — edition-agnostic.
- The `index.ts` local wiring: `rank_profile` schemas, config threading, temporal re-rank at the local return sites, recall-audit tagging.

**Excluded (federation-only):** `remote-merge.ts`, `mergeWithRemote`/best-effort fan-out, the `/search/all` remote merge, and the `remote*` knobs (`remoteRenormalize`/`remoteWeight`/`remoteHalfLifeDays`). `master` has no `federation/` dir; none of this applies.

## 3. Port mechanism (verified)

`master`'s `search.ts`, `rerank.ts`, `recall-audit.ts`, `meta.ts` are **byte-identical** to the federation P0 base (`2ffefa3`). Therefore the federation versions of `search.ts`/`rerank.ts`/`recall-audit.ts` equal *master + our additions* and **copy over cleanly**. `meta.ts` needs no change (already carries `{chunk_id, rank}`).

- **Clean copy** (federation → this branch): `search.ts`, `rerank.ts`, `recall-audit.ts`, `temporal-intent.ts`, `src/eval/*`, `src/cli/commands/eval.ts`, and the corresponding unit tests.
- **New, OSS-tailored**: `search-config.ts` (§4).
- **Hand-port**: `index.ts` — `master`'s handlers (`searchWithRecency` ~1018, `searchByChannel` ~1027, `localSearchAll` ~1156 "LOCAL channels only", `/search/all` ~1346, `/search/observations` ~1385, `/inject/context` ~1633, `new HybridSearcher` ~366) get the same edits we made to federation's `index.ts`, **minus** the remote-merge. `/search/all` here re-ranks `localSearchAll`'s result directly (no merge step). Also register `eval` in `cli/index.ts`.

## 4. OSS `search-config.ts` (the one real divergence)

A clean OSS variant of the rank-profile config:
- `RankConfig` **omits** `remoteRenormalize`, `remoteWeight`, `remoteHalfLifeDays` (no remote in OSS) **and** `recencyDominance` (vestigial after the recency-primary fix — OSS starts clean).
- Fields: `profile`, `fusionMode`, `rrfK`, `perStrategyTopK`, `vectorWeight`, `keywordWeight`, `temporalIntent`, `properNounBoost`, `temporalHalfLifeDays`, `temporalTopN`, `relevanceFloor`, `properNounBoostWeight`.
- `LEGACY` = today's ranking (rrf, 60/25, all v2 features off/inert). `v2` = `{fusionMode:'weighted', vectorWeight:0.7, keywordWeight:0.3, temporalIntent:true, properNounBoost:true, temporalHalfLifeDays:7, temporalTopN:10, relevanceFloor:0.6, properNounBoostWeight:1.15}`.
- **`defaultProfileName` falls back to `'v2'`** (not `'legacy'`) — so OSS ships v2 out of the box with no env var. `CAPTAIN_MEMO_RANK_PROFILE=legacy` is the opt-out.
- `resolveRankConfig` keeps the `num`/`bool` helpers + env overrides for the surviving knobs (no remote overrides).
- `temporal-intent.ts` already only reads surviving fields (`temporalIntent`, `temporalHalfLifeDays`, `temporalTopN`, `relevanceFloor`) — copies unchanged. `search.ts`/`rerank.ts` reference only `fusionMode`/weights/`properNoun*` via opts — unchanged.

## 5. Decomposition (5 tasks; each independently testable)

1. **OSS `search-config.ts`** — the variant above + unit test (legacy inert; v2 active; `defaultProfileName`→v2; env overrides; NO remote/recencyDominance fields).
2. **Local ranking modules** — copy `search.ts`, `rerank.ts`, `recall-audit.ts`, `temporal-intent.ts` from federation + their unit tests (`search.test`, `weighted-fusion.test`, `rerank.test`, `recall-audit.test`, `temporal-intent.test`), adjusting the `V2` test fixture to the OSS `RankConfig` shape (no remote/recencyDominance). `bun test` + typecheck green.
3. **Eval harness** — copy `src/eval/*` (`metrics`, `oracle`, `judge`, `golden`, `run`, `retry`) + `src/cli/commands/eval.ts` + register `eval` in `cli/index.ts` + tests. `bun test` + typecheck green.
4. **Hand-port `index.ts`** — `rank_profile` on the search/inject schemas; import `resolveRankConfig`/`applyTemporalRerank`; thread config through `searchWithRecency` (+ forward `fusionMode`/`vectorWeight`/`keywordWeight`/`perStrategyTopK`/`rrfK`/`properNounBoost`/`properNounBoostWeight`), `localSearchAll`, `searchByChannel`; resolve `cfg` in each handler; apply `applyTemporalRerank` at the local return sites; add `rank_profile` to recall-audit writes + the `fireSearchAudit` helper. **No remote.** Legacy path byte-identical; v2 active. Full worker suite + typecheck green.
5. **Release** — version bump across the 6 release files (`package.json`, `plugin.json`, `marketplace.json`, `CHANGELOG.md`, and the two compiled `plugin/dist/*` bundles) per the repo's release ritual. Target a minor bump from `master`'s current `0.11.2` (confirm the exact number against the OSS version line at release time — likely `0.12.0`). CHANGELOG entry: "search quality — weighted fusion + temporal intent + proper-noun boost; v2 default". Rebuild the bundles (`bun run build:plugin`) so the committed-bundle freshness + manifest-parity tests (`plugin-manifest.test.ts`) pass. Full `bun test` + typecheck.

## 6. Testing & verification

- **Unit + typecheck** are the gate: the ported modules carry the same tests that passed on federation; `bun run typecheck` clean.
- **Behavioral parity:** the ranking logic is identical to the federation stack already verified at fresh@1 0.357→0.643, so a separate OSS metric run is **optional**. If desired, run an OSS worker against the shared corpus (`CAPTAIN_MEMO_DATA_DIR=~/.captain-memo`) on a spare port and `captain-memo eval run --profile=legacy,v2` — expect the same shape.
- **Zero-change for `legacy`** still holds (legacy profile reproduces old ranking); but note v2 is now the *default*, so the OSS release intentionally changes out-of-the-box ranking (covered by the version bump + CHANGELOG).

## 7. Risks & out of scope

- **Release-ritual completeness** (Task 5): the repo gates on manifest-version parity + committed-bundle freshness (the `plugin-manifest` tests). Task 5 must bump all manifests + rebuild the bundle so those tests pass — do not ship drift.
- **`index.ts` hand-port drift:** `master`'s `index.ts` is the pre-federation structure; the port must match its handler shapes (verified present in §3). Risk mitigated by the byte-identical base + the same edits we already made.
- **Out of scope:** remote/federation features; the P2.5 memory-timestamp protocol; supersede/dedup (P3); cross-encoder reranker (P4). Judge-based nDCG metrics need `ANTHROPIC_API_KEY` as on federation.
- **Merge/publish** to `master` + the marketplace is the human's action after this branch is reviewed.
