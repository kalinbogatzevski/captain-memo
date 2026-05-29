# Changelog

All notable changes to captain-memo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
semantic-ish versioning while pre-1.0. Full notes for each release live on the
[GitHub releases page](https://github.com/kalinbogatzevski/captain-memo/releases).

## [0.1.16] — 2026-05-29

### Added
- **`captain-memo top`** — an interactive, htop-style live stats TUI. Four modes
  (dashboard ⇄ table ⇄ detail ⇄ help) with sort, type-filter, free-text find,
  near-duplicate collapse, and drill-in. Opening an observation counts as a
  drill, so the tool is self-measuring. Press `?` in-app for the full key map
  and a glossary. A live date/time clock sits top-right and ticks each refresh.
- **`captain-memo dedup`** — fold near-duplicate observations together. Dry-run
  by default; `--apply` archives members into the survivor (counts summed,
  `observations.db` backed up first); `--undo` reverses it; `--threshold N`
  tunes aggressiveness. Fully reversible (archival, not deletion).
- **"Last surfaced" pulse + "Recently surfaced" list** in `stats`, with per-source
  provenance (auto/search/drill).
- **Near-duplicate collapse** in the Top lists (`(+N similar)`), summing counts —
  one token-set-Jaccard similarity primitive shared by `stats`, `top`, and `dedup`.
- HTTP endpoints `/recall/list` (server-side sort/filter/page/collapse) and
  `/observation/full` (drill-in that bumps `from_drill`).

### Changed
- **`captain-memo watch` is deprecated** — it now forwards to `top` (and the
  external `procps`/`watch` dependency is gone).
- Schema **migration v7** adds `last_surfaced_source`, recording which path drove
  each observation's most recent surfacing.
- Archived observations are now excluded from `stats` **and** the live search
  path (reversible post-filter — no vector mutation).

### Fixed
- Hardened via a multi-agent review pass: collapse `total` reports the
  pre-collapse match count (not the group count); deterministic id tie-break in
  collapse ordering; `mergeDuplicateGroup` preserves a NULL `last_surfaced_at`
  instead of coercing it to epoch 0; `dedup --undo` tolerates corrupted
  `theme_member_ids`; `top` sanitizes worker error text against ANSI injection
  and discards stale concurrent fetches via a state-snapshot guard.

## [0.1.15] — 2026-05-28
- Stats panel redesign — locked color discipline, dropped the box header.

## [0.1.14] — 2026-05-28
- Wide responsive stats, DREAM diagnostics panel, and the (now-deprecated)
  `watch` wrapper.

## [0.1.13] — 2026-05-28
- Local Dreaming foundation — `dream --dry-run` cluster preview (read-only).

## [0.1.12] — 2026-05-28
- Retrieval tracking with provenance — split the single counter into
  `from_auto` / `from_search` / `from_drill`.

## [0.1.11] — 2026-05-27
- Retrieval tracking + the RECALL stats section.

## [0.1.10] — 2026-05-16
- Efficiency-ratio fix + Captain's Log.

## [0.1.9] — 2026-05-16
- Snapshot efficiency stats.

[0.1.16]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.16
[0.1.15]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.15
[0.1.14]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.14
[0.1.13]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.13
[0.1.12]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.12
[0.1.11]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.11
[0.1.10]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.10
[0.1.9]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.9
