# Changelog

All notable changes to captain-memo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
semantic-ish versioning while pre-1.0. Full notes for each release live on the
[GitHub releases page](https://github.com/kalinbogatzevski/captain-memo/releases).

## [0.2.7] — 2026-05-30

### Added
- **`install` now allowlists captain-memo's own MCP tools.** A plugin can't
  self-grant permissions via `claude plugin install` (by design), so in
  restrictive modes like "don't ask" the agent's calls to the plugin's tools
  (`stats`, `search_*`, `get_full`, …) were auto-denied. `captain-memo install`
  now adds `mcp__plugin_captain-memo_captain-memo__*` to the user's
  `~/.claude/settings.json` `permissions.allow` — idempotent and non-destructive
  (existing entries and other settings are preserved) — so the plugin's tools
  work without a per-call prompt. Opt out with `--no-grant-permissions`.
  (Installer/CLI-side only — the plugin bundle is unchanged from v0.2.4.)

## [0.2.6] — 2026-05-30

### Internal / Docs
- `doctor`'s `plugin entry (cache)` check now reports the **active (highest-version)**
  cache dir instead of whichever the filesystem listed first — it could name a
  stale `0.1.0` dir while a newer version was installed. Cosmetic: the check
  already passed; it just named the wrong directory.
- README: documented updating (`claude plugin update captain-memo@captain-memo`,
  fully-qualified id) and that a **local-directory** marketplace needs a
  `marketplace remove` + `add` refresh after a version bump (a GitHub marketplace
  re-fetches automatically).

## [0.2.5] — 2026-05-30

### Fixed (Windows)
- **The no-admin worker install now actually completes.** v0.2.4 added the
  required `<UserId>` to the task XML (correct), but also flipped the XML to
  `encoding="UTF-8"` — and `schtasks /Create /XML` **requires UTF-16 LE + BOM**
  (UTF-8 is rejected: *"unable to switch the encoding"*). The task XML is again
  declared `UTF-16` and written UTF-16 LE + BOM (`toTaskXmlBuffer`), so a normal
  user's `captain-memo install` registers the worker task with no elevation.
  (The plugin bundle is unchanged from v0.2.4 — this is installer-side only.)

## [0.2.4] — 2026-05-30

### Fixed (Windows)
- **The worker Scheduled Task now installs without admin.** v0.2.3 switched to
  `schtasks /Create /XML`, but the generated task XML omitted `<UserId>`, so
  `schtasks` couldn't scope the task to the current user and demanded an elevated
  token (`Access is denied` for a normal user). The `<Principal>` **and**
  `<LogonTrigger>` now carry the current user's `<UserId>`, and the XML
  declaration is `UTF-8` to match the bytes written to disk.
- **Per-release plugin version.** `plugin/.claude-plugin/plugin.json` was pinned
  at `0.1.0`, so the plugin **cache key never changed between releases** and
  `claude plugin update` could reuse a stale (broken) cached copy. It now tracks
  the release version, so an update actually delivers the new bundle.

### Docs
- README marketplace example uses the unambiguous `owner/repo` form.

## [0.2.3] — 2026-05-30

### Fixed (Windows — from a native field-install report)
- **The plugin is now self-contained — no more git symlinks.** `plugin/src` and
  `plugin/bin` were committed as symlinks (`→ ../src`, `→ ../bin`); on a Windows
  checkout (`core.symlinks=false`) they materialized as 6-byte text files, got
  copied into the plugin cache, and the configured entry paths didn't resolve —
  so the **MCP server never started and all 5 hooks were silent no-ops** (and
  `doctor` stayed green). The HTTP-only entrypoints are now bundled into
  `plugin/dist/{mcp-server,captain-memo-hook}.js` (via `bun run build:plugin`),
  the manifests point there, and the symlinks are gone. Works on a fresh Windows
  install with no junction workarounds.
- **Worker Scheduled Task installs without admin.** Replaced the
  `Register-ScheduledTask` call (which needs elevation on Windows 11) with
  `schtasks /Create /XML` (per-user, `InteractiveToken` / `LeastPrivilege`,
  logon trigger, restart-on-failure) — no UAC, matching the installer's promise.

### Added
- **Non-interactive install.** `captain-memo install` accepts flags (`--embedder`,
  `--voyage-key`, `--summarizer`, `--watch`, `-y/--yes`, …) and `CAPTAIN_MEMO_*`
  env fallbacks, so it works over a non-TTY stdin (headless / remote / Windows).

### Internal
- `doctor` now validates the plugin **entry bundles** resolve (FAIL if the
  manifests point at missing/placeholder files) and WARNs on a stale cache copy.
- CI rebuilds `plugin/dist` and fails on drift, so the committed bundles can't
  go stale vs. their source.

## [0.2.2] — 2026-05-30

### Internal
- **Deterministic CI on ubuntu + windows.** No runtime change from v0.2.1 — this
  is test-infrastructure hardening so the green check is trustworthy:
  - All worker-starting tests now bind **OS-assigned ephemeral ports** (`port: 0`,
    reading the actual port back from the handle) instead of hardcoded ports,
    eliminating intermittent `EADDRINUSE` collisions under CI timing / TIME_WAIT.
  - The I/O-bound `VACUUM` tests get a Windows-safe 30 s timeout (SQLite `VACUUM`
    rewrites the whole file and the windows-latest disk is slow).
  - Hermetic git identity in the branch tests; `os.tmpdir()` instead of a
    hardcoded `/tmp` SQLite path; resolved a pre-existing `Observation`-type
    `tsc` error.

## [0.2.1] — 2026-05-30

### Fixed
- **Windows: memory/skill frontmatter is now parsed regardless of line endings.**
  The memory-file and skill chunkers used an LF-only frontmatter parser, so `.md`
  files with CRLF line endings (common on Windows, or an autocrlf git checkout)
  silently lost their frontmatter — its fields (`type`/`name`/`description`) were
  dropped from the index and the `---` delimiters leaked into chunk text. Content
  is now normalized CRLF→LF before parsing.

### Internal
- CI now runs the full suite on both `ubuntu-latest` and `windows-latest` (green
  on both). Fixed test portability the first real Windows run exposed: hermetic
  git identity in the branch tests, `os.tmpdir()` instead of a hardcoded `/tmp`
  SQLite path, deduplicated worker ports, and a pre-existing `Observation`-type
  typecheck error.

## [0.2.0] — 2026-05-30

### Added
- **Native Windows support (x64).** Captain Memo now installs and runs on
  Windows without WSL. The runtime was already portable (Bun, `bun:sqlite` +
  `sqlite-vec`, all CLI↔worker↔embedder IPC over localhost HTTP); this release
  ports the operational layer — install / supervise / uninstall / upgrade /
  doctor — off its systemd + POSIX-shell assumptions.
- **Per-user Scheduled Task supervision.** A new OS-agnostic `ServiceManager`
  interface backs daemon supervision: `systemd` (`systemctl --user`) on Linux,
  a per-user **Scheduled Task** (PowerShell `Register-ScheduledTask`, registered
  at logon with restart-on-failure, no admin/UAC) on Windows. The five lifecycle
  commands call only this interface, never the OS directly.
- **In-process `worker.env` loader (`loadWorkerEnv`).** Replaces the systemd
  `EnvironmentFile=` mechanism that has no Windows equivalent. Runs at the top of
  the worker / MCP / CLI bootstrap on every platform, parsing `KEY=VALUE` lines
  from `CONFIG_DIR/worker.env` (plus `/etc/captain-memo/worker.env` on Linux) and
  seeding `process.env` **without overwriting** vars already set — so a shell
  `export` or systemd `EnvironmentFile` still wins.
- **Optional local Python embedder on Windows.** The `local-sidecar` backend is
  now installable on Windows via a PowerShell port (`install-embedder.ps1`),
  behind a new `EmbedderInstaller` interface (bash on Linux, PowerShell on
  Windows). Hosted Voyage remains the default and needs no installer at all.
- **`CLAUDE_CODE_OAUTH_TOKEN` override** for the `claude-oauth` summarizer — a
  guaranteed escape hatch when the token lives in the OS keychain / Credential
  Manager rather than `~/.claude/.credentials.json`.
- **CI** (`.github/workflows/ci.yml`) on `ubuntu-latest` + `windows-latest`:
  `bun install`, `bun run typecheck`, `bun test`, plus a Windows-only smoke test
  that loads the native `sqlite-vec` `vec0.dll` (`Database` + `sqliteVec.load`).

### Changed
- **Hosted Voyage is the default embedder** on Windows — no Python to
  misconfigure for the recommended path.
- Hook commands in `plugin/hooks/hooks.json` are now interpreter-explicit
  (`bun "${CLAUDE_PLUGIN_ROOT}/bin/captain-memo-hook.ts" <Event>`), dropping the
  `"shell": "bash"` pin and the shebang/extension dependence — identical on
  Linux and Windows. `bin/captain-memo-hook` is renamed to
  `bin/captain-memo-hook.ts` (content unchanged).
- `project_id` resolution now splits the cwd on `[\\/]`, so a Windows
  `C:\Users\…` path keys to the folder name rather than the whole path.

### Fixed
- **Linux behavior is unchanged.** The `systemd` `ServiceManager` reproduces the
  prior `systemctl --user` behavior; `bun test` + `bun run typecheck` stay green
  and `install` / `doctor` / `uninstall` behave exactly as before.

### Notes
- `win32-arm64` is **unsupported**; run x64 Bun (under emulation on arm64).
  `bun install` must run on the Windows x64 target so `sqlite-vec`'s `vec0.dll`
  is present (a Linux-built `node_modules` lacks it).
- **WSL2 remains a fully supported fallback** — run the unchanged Linux installer
  inside the distro and run Claude Code inside WSL too.

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

[0.2.0]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.2.0
[0.1.16]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.16
[0.1.15]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.15
[0.1.14]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.14
[0.1.13]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.13
[0.1.12]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.12
[0.1.11]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.11
[0.1.10]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.10
[0.1.9]: https://github.com/kalinbogatzevski/captain-memo/releases/tag/v0.1.9
