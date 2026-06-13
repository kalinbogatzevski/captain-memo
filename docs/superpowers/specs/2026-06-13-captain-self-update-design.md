# Captain self-update — visible auto-upgrade

- **Status:** Draft (design approved in conversation)
- **Date:** 2026-06-13
- **Scope:** OSS captain core (must keep `ci(moat)` green) + port to federation

## 1. Goal

Make the Captain visibly self-upgrade inside Claude Code, the way other well-behaved Claude
Code plugins do — without requiring git on the user's machine.

## 2. Mechanism (lean on Claude Code, no git)

Claude Code **natively auto-fetches new versions of a GitHub-marketplace plugin** into
versioned cache dirs. That is the update engine — no git pull, no tarball download, no
release-API polling. A plugin only has to (a) make sure the freshly-fetched version's runtime
is ready and (b) reconcile/announce the change.

## 3. What the Captain already has (so the delta is small)

- **GitHub-marketplace install is already supported** (`claude plugin marketplace add
  kalinbogatzevski/captain-memo`) — that IS the auto-fetch engine.
- **The worker already self-heals on a version change.** `session-start.ts` probes the
  worker's `/stats` version against the plugin `VERSION` and, when stale, gracefully restarts
  it (opt-out `CAPTAIN_MEMO_DISABLE_SELF_HEAL=1`). So the worker reconcile is done.
- **The plugin is bundled** (`build:plugin` → single-file `dist/*.js`), so there is no
  runtime dependency-install step to manage on a fresh fetch.

**Therefore the only missing piece for a *visible* self-upgrade is a version marker + an
upgrade banner.** Plus documenting the marketplace-install path.

## 4. Design

### 4.1 New module — `src/shared/self-update.ts` (pure logic + tiny marker I/O)
- `compareSemver(a, b): -1 | 0 | 1` — numeric major.minor.patch, `v` prefix tolerated,
  pre-release/build ignored. `'0.10.0' > '0.9.0'` (numeric, not lexical).
- `type UpdateAction = 'first-run' | 'upgraded' | 'same-or-older'`.
- `decideUpdateAction(running, marker | null)`: `null` → `'first-run'`; `running > marker`
  → `'upgraded'`; else `'same-or-older'`.
- `formatUpgradeBanner(from, to): string` — `⚓ Captain Memo self-upgraded vX → vY …`.
- `readMarker(dataDir): string | null` — reads `DATA_DIR/.install-version`; missing/blank/
  unreadable → `null`.
- `writeMarker(dataDir, version): void` — atomic temp+rename, `mkdir -p`, best-effort
  (never throws).
- `consumeUpgradeNotice(dataDir, runningVersion): string` — read marker → decide → on
  `'same-or-older'` return `''`; else persist the running version and return the banner
  (`'upgraded'`) or `''` (`'first-run'` — silent on a clean install). Never throws.

### 4.2 Integration — `src/hooks/session-start.ts`
Right before emitting the banner, call `consumeUpgradeNotice(DATA_DIR, VERSION)` and prepend
its (possibly empty) line to the `systemMessage` in BOTH the healthy and degraded branches —
so an upgrade is announced even if the worker is briefly down. No other change: the existing
self-heal already restarts the now-stale worker on the same run.

### 4.3 Marker semantics
`DATA_DIR/.install-version` records the version session-start last announced. It is the
Captain's own state (not a user setting). **Settings invariant (hard requirement):** the
self-update path touches only this marker + the worker process (via the existing self-heal)
— **never** `worker.env`, config, or corpus/data, and it never re-runs the install wizard.

## 5. Distribution / docs
Document the **GitHub-marketplace install** as the auto-updating path (Claude Code re-fetches
it; the worker self-heals; the banner announces it). The directory-source full install (local
clone) is a snapshot Claude Code does not auto-refetch — there, upgrades are done by re-running
`captain-memo install` (unchanged); the banner still fires once the new `VERSION` is live.

## 6. Error handling
`consumeUpgradeNotice` and the marker I/O are fully best-effort (never throw); a failed marker
read/write degrades to "no banner" and never affects the session or worker. The hook stays
fail-open (exit 0), per the existing contract.

## 7. Testing
- **Unit `self-update.test.ts`:** `compareSemver` ordering incl. numeric `0.10.0 > 0.9.0`
  and `v` prefix; `decideUpdateAction` for null/upgraded/same/older; banner contains both
  versions; `consumeUpgradeNotice` against a temp dir — first-run writes marker + returns
  `''`; same version returns `''`; a bumped version returns the banner + updates the marker;
  a downgrade returns `''`; a missing/corrupt marker is treated as first-run; I/O failure
  degrades to `''` without throwing.

## 8. OSS-cleanliness
New code lives in `src/shared` + a 3-line `src/hooks/session-start.ts` edit. No federation
imports; `ci(moat)` unaffected.

## 9. Out of scope (YAGNI)
- Git pull / tarball download / release-API polling — Claude Code is the fetcher.
- A separate setup hook + dependency-install step — the Captain's plugin is bundled and the
  worker deps are installed at `captain-memo install` time, so it adds nothing here.
- Re-architecting the worker to launch from the marketplace cache.
- Auto-running the full `install` wizard (would risk settings).
