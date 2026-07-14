# Changelog

All notable changes to captain-memo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
semantic-ish versioning while pre-1.0. Full notes for each release live on the
[GitHub releases page](https://github.com/kalinbogatzevski/captain-memo/releases).

## [0.23.0] — 2026-07-14

### Added
- **`codex` summarizer provider — the zero-key option for users with no Claude subscription.** Until now every provider assumed either an Anthropic plan (`claude-oauth`, `claude-code`) or a paid API key (`anthropic`, `openai-compatible`); someone with only a ChatGPT Plus/Pro account had no way to get observations. `CAPTAIN_MEMO_SUMMARIZER_PROVIDER=codex` shells out to `codex exec --json` and authenticates off `codex login`. Defaults to `gpt-5.4-mini` (the Haiku-tier pick). Codex reports real token usage, so observations get accurate work-token costs — something the `claude-code` transport cannot provide.
  - **~6–7 s/call, and the model does not change that.** Measured across the whole ladder (`gpt-5.4-mini` → `gpt-5.6-sol`) the latency is flat, because the cost is `codex exec` booting an agent runtime, not inference. A smaller model saves quota, not wall-clock. This never reaches the user: summarization runs on the worker's 5 s background tick and collapses an entire prompt window into a single call.
  - **A ChatGPT account gates the model list server-side** — `gpt-5.4-nano` and every `gpt-5.1-*` slug are rejected with "not supported when using Codex with a ChatGPT account". The fallback chain therefore ends at the sentinel `default`, meaning "send no `-m` at all", which the account always accepts. Users never need to know which slugs their plan allows.
  - Runs with `--ignore-user-config --ephemeral --sandbox read-only`. The first is load-bearing: a user's `~/.codex/config.toml` may set a heavyweight reasoning effort *and register MCP servers* (including captain-memo itself), which would otherwise be booted as child processes on every single summarize call.
- **`CAPTAIN_MEMO_WATCH_MEMORY=auto` — auto-discover every installed assistant's memory.** Captain only ever indexed the one hand-written glob you gave it, which in practice meant Claude's memory and nothing else, even with Codex/Gemini/Cursor installed alongside. The sentinel `auto` probes the machine and expands to whichever memory locations actually exist: `~/.claude/CLAUDE.md`, per-project Claude memories, `~/.codex/`, `~/.gemini/`, `~/.cursor/rules/`, and repo-level `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md`. It composes with your own globs (`auto,/my/notes/*.md`), and is now the recommended install default.
  - Each indexed doc carries a `tool` metadata tag, so provenance survives — `filename_id` is no longer unique once three assistants can each own an `AGENTS.md`.
  - **Credentials and session logs are structurally unindexable, not blocklisted.** Every discovery glob must end in `.md`/`.mdc`, which is enforced by a test. That single rule is what keeps `~/.codex/auth.json`, `~/.gemini/oauth_creds.json`, `~/.codex/sessions/**.jsonl` (53 MB of transcripts on the dev box) and `*.sqlite` out of the corpus — a blocklist is something you forget to update when a vendor adds a file.

### Fixed
- **The file watcher was blind to hidden directories, so repo-level memory never indexed.** Both glob scans defaulted to `dot: false` (`index.ts` omitted it, `watcher.ts` set it explicitly), which meant `~/projects/*/.claude/CLAUDE.md` matched **zero** files despite existing — as would any `.github/` or `.cursor/` rule file. Both scans now pass `dot: true`.

### Notes
- Suite: 1087/1087. `master` remains free of federation code (moat-guard green).

## [0.22.2] — 2026-07-12

### Fixed
- **Integration tests silently inherited the developer's real `worker.env`.** A spawned test worker calls `loadWorkerEnv()`, which reads `CONFIG_DIR/worker.env` and injects every variable **not already in `process.env`**. On any machine that also runs a real captain, that meant `~/.config/captain-memo/worker.env` — the developer's own live config (`EMBEDDER_ENDPOINT`, `EMBEDDER_API_KEY`, `QM_DEDUP`, `TIDE_*`, `RECALL_AUDIT`, `FEDERATION_*`, …) — quietly became the fixture's config. Tests therefore behaved differently depending on **whose box they ran on**: green in CI, and able to fail (or falsely pass) locally. Every worker-spawning integration test now pins `CAPTAIN_MEMO_CONFIG_DIR` to its own temp dir (`paths.ts` honours it), so no `worker.env` is found and **nothing is inherited**. Suite: 1072/1072.

## [0.22.1] — 2026-07-12

### Fixed
- **Background jobs could write to the database *after* the worker shut it down.** `stopResources()` cleared all six interval timers and then immediately closed the stores — but `clearInterval` cancels the *schedule*, not work already **in flight**. Every background slice (ingest batch, Tide sweep, Quartermaster dedup/supersede, promotion) is async and yields to the loop, so a slice that started before `stop()` kept running and then wrote its result / audit row into a closed DB: `RangeError: Cannot use a closed database`, thrown from a timer callback — an **unhandled rejection with no caller to attribute it to**. `stop()` now drains every in-flight job (`Promise.allSettled`) before releasing the handles.
  - Symptom in the wild: a phantom test failure that attached itself to whichever test happened to be running when an orphaned tick fired, so the "failing test" *migrated between files run-to-run* and never reproduced in isolation. The full suite is green again (1072/1072).

## [0.22.0] — 2026-07-12

### Added
- **`captain-memo connect kimi` — share the corpus with Kimi CLI, and set it up on your own local Ollama.** Registers the captain-memo MCP server into kimi (`kimi mcp add captain-memo -- …` → `~/.kimi/mcp.json`) so Kimi reads the SAME local memory as Claude Code, Codex, Gemini, opencode and the rest. It also writes `~/.kimi/config.toml` for you: the local Ollama provider (`openai_legacy` at `http://127.0.0.1:11434/v1`) plus one `[models."<id>"]` alias per model from `ollama list` — so **Kimi runs entirely on your own machine, with no Moonshot key and no login**, and `kimi -m "<id>"` reaches every model you have pulled. Verified against kimi-cli 1.48.0.
  - Honest by construction: a box with **no** local Ollama models gets **nothing** written (a `base_url`-only config would claim a capability you don't have), and it tells you to pull a model.
  - The root `default_model` is only kept if it still **resolves** to a declared alias, so an `ollama rm` can never leave Kimi pointing at a model that's gone (it would die with "LLM not set" while the installer claimed success).
  - An **embedding** model is never chosen as the default — `ollama list` returns embedders (this project's own docs tell you to pull one) and an embedder cannot chat.

## [0.21.0] — 2026-07-12

### Changed
- **opencode is a first-class cross-AI tool in the `connect` docs.** De-staled the `connect`/install prose and the `KNOWN_TOOLS` comment that still enumerated only "Codex, Gemini, Cursor" — opencode (and the other adapters) are auto-detected and wired by `captain-memo connect`; the help text and comments now reflect that.

## [0.20.0] — 2026-07-11

### Changed
- **Recency-aware ranking — gentle temporal blend.** The `current/latest` temporal re-rank (`applyTemporalRerank`) is now a *gentle, bounded multiplicative blend* rather than a recency-dominant reorder: `final = score · (temporalFloor + (1 − temporalFloor)·exp(−ln2·age_days/halflife))`. Fresh observations win near-ties **without burying a more-relevant older fact**, curated `memory`/`skill` hits are exempt (factor 1 — never demoted below a fresh observation), and undated or future-dated hits stay neutral (×1). Observation half-life default is now **21d** (was 7d). New tunable **`temporalFloor`** (`CAPTAIN_MEMO_TEMPORAL_FLOOR`, default `0.5`) sets the gentleness — a maximally-stale observation keeps ≥ `temporalFloor` of its relevance; lower is sharper, `1.0` disables recency. The `legacy` profile is unchanged (byte-identical); `v2` (the OSS default) now ships the gentle blend.

## [0.19.0] — 2026-07-09

### Added
- **Google Antigravity CLI (`agy`) support.** `agy` is the successor to the Gemini CLI (Gemini CLI is retired for consumer tiers on 2026-06-18). `captain-memo install` / `connect` now detects `agy` and wires captain-memo into its own MCP config (`~/.gemini/config/mcp_config.json`), so an `agy` session gets the full captain-memo memory toolset. Verified live against agy 1.1.0: it discovers all of captain-memo's tools from the wired config. There is no `agy mcp add` subcommand, so the registration is an idempotent config-file merge (top-level `mcpServers`, same stdio shape as Cursor's mcp.json; foreign servers preserved).

### Fixed
- **Manifest version drift.** `.claude-plugin/marketplace.json` had lagged at 0.17.0 while the plugin was 0.18.0; all three manifests (`package.json`, `plugin.json`, `marketplace.json`) are re-synced and the committed `plugin/dist` bundle is rebuilt at the current version, so the version-consistency checks pass again.

## [0.18.0] — 2026-07-08

### Added
- **Shared git checkout coordination on the work board.** `work_set`/`work_active` now treat a shared git working tree as a first-class resource: editing a file in a real repo stamps `{repo_root, branch, is_dirty}` on the claim; `work_active` surfaces `repo_contention[]` (who holds a checkout, its branch, and dirty/clean — host-local) and fires `overlaps_with_mine` on a shared working-tree root, not just an identical file path; and a new advisory `Bash` PreToolUse hook warns before a mutating git op (`checkout`/`switch`/`commit`/`reset`/`stash`/…) on a checkout another session is using, suggesting `git worktree add` instead. Scratchpad claims are unchanged (no false cross-session overlaps). Git detection (`rev-parse --show-toplevel` + `status --porcelain`) is short-TTL cached and fail-open. Advisory only — never blocks.

## [0.17.0] — 2026-07-05

### Added
- **Local device pairing — pair a second device (phone, another machine) to this captain's memory, no hub required.** `captain-memo gateway pair|list|revoke` mints/lists/removes bearer tokens; the worker serves an authenticated HTTP-MCP listener (localhost-only, started only when a device is paired) that the operator reaches via their own reverse proxy + TLS. Full tool access per paired device in this release — no separate identity, no peer concept, no new process to manage.

## [0.16.0] — 2026-07-05

### Added
- **Vendor provenance — tag every captured observation with which AI tool wrote it.** A new closed
  9-member tag (`claude-code`, `codex`, `cursor`, `gemini`, `opencode`, `vibe`, `vscode`, `jetbrains`,
  `unknown`) is stamped on capture and surfaced as `metadata.origin_agent` on every search and
  `get_full` hit. Detection is environment-signal based (an explicit `AI_AGENT` override, or
  `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` for Claude Code) and never fails a capture — an absent or
  unrecognized signal always degrades to `unknown`.
  - Additive SQLite migration (nullable column, no default) — old rows read back as `unknown`, zero
    downtime, zero behavior change for anything that doesn't reference the new field.
  - Foundational: today only Claude Code's hooks actively write observations (the other 7 tools are
    read-only recall via MCP), so this mostly tags existing captures — it's the plumbing a future
    per-vendor capture path needs to already have somewhere to land.

### Fixed
- Cross-AI tool matrix documentation (README, `docs/cross-ai-tools.md`, two CLI help strings) was
  still listing only the original 3 tools (Codex, Gemini, Cursor) even though `opencode`, Mistral
  Vibe, VS Code, and JetBrains adapters already worked — now all 7 are documented consistently.

## [0.15.0] — 2026-07-04

### Added
- **Work-coordination board — file-overlap and semantic-overlap warnings between agents on the same machine.**
  A new `PreToolUse` hook publishes a transient claim ("agent X, session Y is touching these files") before
  every Edit/Write/MultiEdit/NotebookEdit; any other AI tool sharing this captain (Claude Code, Codex, Gemini
  CLI, Cursor) editing overlapping files is flagged at once.
  - Two independent overlap passes: **file** (glob/path intersection, conservative — over-warns rather than
    misses a collision) and **semantic** (embeds each claim's declared intent and flags two agents working on
    the same thing in *different* files, which the file pass can't see). The semantic pass never blocks on the
    embedder — it compares only already-cached vectors and warms the cache in the background, so a brand-new
    claim's semantic overlap surfaces a beat later, not on the very first edit.
  - Claims are advisory leases (default 30 min), not locks — reaped lazily on read, so a crashed session never
    leaves a phantom claim blocking an area.
  - New MCP tools: `work_set`, `work_active`, `work_clear` (see README).

## [0.14.0] — 2026-06-25

### Added
- **Memory backup & restore — move a captain's memories to a new install, or recover them.** New
  `captain-memo backup create|restore|info` produces one portable `.tar.gz` of the durable corpus
  (`meta.sqlite3`, `observations.db`, `vector-db/embeddings.db`), config, and the `worker.env` secrets,
  with a checksummed `manifest.json`.
  - `create` takes a **live hot snapshot** via SQLite `VACUUM INTO` — the worker keeps running, no
    downtime — then writes the archive atomically (`.partial` → rename) and `chmod 600`. The archive
    contains API keys, so a loud warning says so. `--no-vectors` makes a smaller, re-embed-on-restore
    archive; the embedder-identity probe is time-bounded so a wedged worker can't stall a backup.
  - `restore` is **validate-before-touch**: it verifies the manifest and every file checksum before
    stopping the worker or moving a byte. It moves the existing corpus **and** config/secrets aside to a
    recoverable `.pre-restore-*` dir, then replaces in place (refuses a non-empty target without
    `--force`). Vectors are reused when the target embedder matches the backup and otherwise rebuilt
    from source via reindex.
  - `info` prints a backup's manifest (counts, embedder, version, whether it carries secrets/vectors)
    without restoring; untrusted manifest fields are sanitized before display.
- File selection is an explicit allowlist — only the durable corpus, config, and secrets are captured;
  transient and host-specific files are excluded by construction.

## [0.13.1] — 2026-06-23

### Added
- **More tools share the one corpus via `connect`.** New installers register the captain-memo MCP server in:
  **opencode** (merge `~/.config/opencode/opencode.json` — MCP + OpenRouter/local providers + a permissive agent;
  the OpenRouter key is written by `{env:OPENROUTER_API_KEY}` reference, never a literal), **Mistral Vibe**
  (append a managed `[[mcp_servers]]` block to `~/.vibe/config.toml`), **VS Code** Copilot agent mode (merge
  `~/.config/Code/User/mcp.json`), and **JetBrains** AI Assistant (assisted-manual — MCP is UI-only, so it writes
  a paste-ready snippet and points at Settings | Tools | AI Assistant | MCP).
- `captain-memo connect opencode --local-provider <ollama|vllm|lmstudio>` selects the local runtime to configure.

## [0.13.0] — 2026-06-18

### Added
- **Supersede stale facts (conservative first slice).** Version-aware supersede detection — when a newer version of the same fact appears (e.g. "talq v0.51.12" vs "v0.6.0"), the older observation is linked as superseded and **demoted (not hidden)** at search time. Detection is **OFF by default** (`CAPTAIN_MEMO_QM_SUPERSEDE=1` to enable); fully reversible. New `captain-memo supersede list|undo` CLI to inspect and reverse links. No behavior change out of the box.

## [0.12.0] — 2026-06-18

### Added
- **Search quality — hybrid weighted fusion.** Hybrid search now blends real cosine + BM25
  (weighted fusion), with temporal-intent detection that surfaces the newest fact for
  "latest/current/last …" queries, plus a proper-noun boost for rare named entities. Enabled
  by default (the new `v2` rank profile). Set `CAPTAIN_MEMO_RANK_PROFILE=legacy` to restore
  the prior ranking.
- **`captain-memo eval` harness** (freshness oracle + optional LLM judge) for measuring
  ranking quality against a golden query set.

## [0.11.2] — 2026-06-17

### Added
- **`captain-memo restart [--force]`** — restart the local worker (reload config / recover) as a
  first-class command. Linux uses the supervisor restart (`systemctl --user restart`); Windows stops and
  restarts the Scheduled Task. Default drains gracefully via `/shutdown` first; `--force` hard-stops a
  wedged worker.

## [0.11.1] — 2026-06-15

### Added
- **Build edition in `/stats` + the SessionStart banner.** The worker now reports its build
  edition, so the banner reads e.g. `⚓ Captain Memo v0.11.1 (OSS)` —
  derived from the checkout (no per-branch constant), so it's accurate without manual upkeep.

## [0.11.0] — 2026-06-14

### Added
- **`captain-memo doctor` now detects version drift.** Two read-only checks catch the
  "running stale code after an update" traps:
  - **worker version** — flags when the running worker's version is behind the installed
    code (a reinstall that didn't actually restart the worker), with `captain-memo install`
    as the remedy.
  - **checkout** — flags when the local clone is parked on a stale branch (a rebuild would
    reproduce the old version) and recommends switching to the remote branch that *contains*
    your current history, so you're never steered onto a divergent line. Git-only, no network.

## [0.10.1] — 2026-06-14

### Fixed
- **Windows: re-running `install` to update now actually restarts the worker.** The worker
  Scheduled Task is `MultipleInstancesPolicy=IgnoreNew`, so the old `start()` no-op'd when a
  worker was already running — leaving the previous process serving stale code after every
  update. The Windows install path now `restart()`s (force-stop + port reclaim + start).
- **Windows: `install` no longer churns `worker.env` on a no-op reinstall.** The file is now
  rewritten (and re-ACL'd) only when its content actually changes, so an unchanged config
  leaves the file byte- and mtime-identical — settings are never needlessly rewritten.
- **`captain-memo config show` now reflects the real worker config.** It seeds `worker.env`
  (via `loadWorkerEnv()`) before printing, so it shows your actual embedder endpoint/model/key
  instead of the built-in `localhost`/`voyage-4-nano` defaults. Precedence stays
  shell env > worker.env > default.

## [0.10.0] — 2026-06-13

### Added
- **Visible self-upgrade (git-free).** Install the plugin from the GitHub
  marketplace and Claude Code auto-fetches new versions — no git needed. When a newer version
  goes live, the existing SessionStart self-heal restarts the now-stale worker and Captain Memo
  now shows a one-time **`⚓ Captain Memo self-upgraded: vX → vY`** banner, tracked via a
  `DATA_DIR/.install-version` marker. Fully best-effort and settings-safe: it touches only the
  marker + worker process — **never** `worker.env`, config, or corpus data. Opt out of the auto
  worker-restart with `CAPTAIN_MEMO_DISABLE_SELF_HEAL=1`.

## [0.9.0] — 2026-06-13

### Added
- **Captain Remember — a first-class curated-memory WRITE path (the Captain can now *be* the memory).**
  Captain Memo could already *read* the `memory` channel; it can now *persist* curated entries through one
  internal `writeMemory()` primitive fed by three thin callers — a new MCP `remember` tool (beside
  `search_memory`), a `captain-memo remember` CLI command, and an opt-in autonomous **promotion** job that
  distils durable, high-signal observations into curated memory. Caller supplies `body` + `type` (required);
  `name`/`description`/`slug` are optional — the summarizer fills anything missing, with a deterministic
  fallback so a write **never** blocks on the LLM. **Dedup is update-in-place:** an overlapping entry
  (filename/slug collision or semantic similarity) updates the existing file rather than spawning a
  near-duplicate, and the entry is indexed **in-process** (no watcher round-trip). Writes are atomic
  (temp-file + rename) and never silent — a failure returns a structured `{ ok: false, reason }`.
- **Promotion is opt-in and OFF by default** (`CAPTAIN_MEMO_PROMOTE_ENABLE=1`). When on, a heartbeat-safe
  periodic tick (sibling to the Quartermaster timer) judges recent durable observations "remember forever?",
  writes survivors via the same `writeMemory()` path with provenance, is idempotent (never re-promotes), and
  is bounded per run. Promotion targets `CAPTAIN_MEMO_REMEMBER_DIR` (default `~/.claude/memory/`).
- **New config (all optional; surfaced in `captain-memo config show` + `doctor`):**
  `CAPTAIN_MEMO_REMEMBER_DIR` (`~/.claude/memory/`), `CAPTAIN_MEMO_PROMOTE_ENABLE` (`0`),
  `CAPTAIN_MEMO_PROMOTE_INTERVAL_MS` (`21600000` / 6h), `CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN` (`5`),
  `CAPTAIN_MEMO_REMEMBER_DEDUP_THRESHOLD` (`0.85`).

## [0.6.0] — 2026-06-05

### Added
- **Quartermaster — automatic near-duplicate merging (opt-in, OFF by default).** A writer-only,
  heartbeat-safe background curator that folds near-identical observations together with **no human
  in the loop** — but only behind a deliberately strict triple lock: title-similarity **AND** cosine
  **≥0.98** (computed in-process over vectors already in the index — zero new embeddings) **AND** the
  negation/identifier guard. It **never auto-folds a memory you drilled into or pinned** (`is_anchored`),
  every fold is fully reversible via the `merge_events` ledger (`captain-memo dedup --undo`, `restore <id>`),
  and the worst outcome is a reversible archive — nothing is ever deleted. The sweep yields between groups
  (and within large ones) and aborts the instant ingest is queued, so the worker's heartbeat is never
  starved. Enable with `CAPTAIN_MEMO_QM_DEDUP=1`.
- **Quartermaster observability in `/stats`.** A `qm` block reports the switch state, the cosine gate,
  and the last run (`merges`, `rows_scanned`, `skipped_no_vector`, `aborted_for_ingest`, `errored`) from a
  new `qm_runs` audit ledger (migration v10) — so an enabled curator is fully legible: you can see exactly
  what it folded, what it skipped for lack of a vector, and whether a run errored.
- **Quartermaster config (all optional):** `CAPTAIN_MEMO_QM_ENABLED` (master switch),
  `CAPTAIN_MEMO_QM_DEDUP` (the auto-merge job, default off), `_QM_DEDUP_COSINE` (`0.98`),
  `_QM_DEDUP_TITLE` (`0.5`), `_QM_DEDUP_WINDOW` (`500`), `_QM_DEDUP_INTERVAL_MS` (`3600000`),
  `_QM_SLICE_MS` (`150`).

## [0.5.5] — 2026-06-05

### Fixed
- **Dedup safety hardening — `captain-memo dedup --apply` is now safe on a multi-project corpus.**
  Four substrate fixes to the merge engine:
  - **Project-scoped merges.** Dedup now groups and folds **only within the same project (and branch)**.
    It can no longer merge near-identical titles across different projects — which previously summed
    unrelated projects' recall counters into one row, corrupting both.
  - **Meaning-aware merge guard.** Opposite-meaning titles ("users table missing" vs "Inspected users
    table") and rows carrying different load-bearing identifiers ("timeout 30s tenant A" vs "5s tenant B")
    are no longer folded together. Negation is detected even in contractions ("isn't" vs "is").
  - **Append-only merge ledger.** Repeated merges into the same survivor can no longer clobber each
    other's member list, so **`captain-memo dedup --undo` now reliably reverses every merge** — counts
    and recency restored exactly, with no stranded, unrecoverable members.
  - **Crash-safe `reindex --force`.** Re-embeds and swaps vectors in atomically (embed-then-swap). A
    failed embed can no longer leave observations with **no** vector — previously the delete-then-rebuild
    order could drop a row out of dense search on any embed error.

### Added
- **`docs/tide-quartermaster.md`** — the canonical Tide & Quartermaster memory-lifecycle design note
  now ships in the repository.

## [0.5.4] — 2026-06-05

### Added
- **Tide tiering (opt-in).** Idle, low-buoyancy observations now auto-demote through a lifecycle —
  `active → dormant → archived` — via a bounded, heartbeat-safe background sweep. **Dormant and
  archived rows are never deleted and never de-indexed**: they're excluded from the default
  auto-injected context but stay fully reachable (down-ranked) in explicit `/search`, and a single
  recall re-floats them. Strong guardrails: any observation ever drilled into (`get_full`) is
  permanently protected from auto-ebb, plus age gates (default 90d to dormant, 180d to archived) and
  hysteresis. Archive is the worst automatic outcome — deletion stays manual. **Off by default**
  (`CAPTAIN_MEMO_TIDE_TIERING=1` to enable); the v0.5.3 read-time re-rank is unaffected and stays on.
- **`captain-memo restore <id>`** — re-surface a sunk observation (distinguishes a real restore from
  an already-active no-op from a non-existent id). **`captain-memo observation sunk [--archived|--ebbed]`**
  lists the dormant/archived tiers. The stats panel shows tiering on/off.
- **Tiering config (all optional):** `CAPTAIN_MEMO_TIDE_TIERING`, `_EBB_THRESHOLD` (`0.30`),
  `_SURFACE_THRESHOLD` (`0.70`), `_ARCHIVE_THRESHOLD` (`0.05`), `_AGE_FLOOR_DAYS` (`90`),
  `_ARCHIVE_AGE_DAYS` (`180`), `_SWEEP_BATCH` (`256`), `_SWEEP_MS` (`60000`).

### Changed
- **Friendlier CLI errors when the worker is down.** A dead-worker connection now prints an
  actionable "worker not reachable — start with `bun run worker:start`" hint with a non-zero exit,
  instead of a raw stack trace (applies to every command).

## [0.5.3] — 2026-06-05

### Added
- **Tide — memory-lifecycle re-ranking (on by default).** Observation search results are now
  re-ranked by *buoyancy* — how afloat a memory is in its own right, from recall recency and a
  slow-moving per-row *stability* that only grows when a memory is recalled. Buoyancy is applied as a
  **bounded** post-fusion multiplier `B0 + (1−B0)·buoyancy` (floor `B0 = 0.30`), so a stale-but-relevant
  hit is gently demoted but **never** buried under a fresh-but-irrelevant one — relevance always
  dominates. A single recall re-floats a long-dormant memory (its stability survived the dormancy).
  The MVP only re-ranks and strengthens; it never moves, hides, or deletes anything.
- **Tide panel in `/stats`, `captain-memo stats`, `top`, and the TUI.** Shows whether Tide is on,
  the relevance floor, how many observations have been strengthened (the live signal — it ticks up
  with use), the max stability reached, and the lifecycle-tier breakdown (active / dormant / archived).
- **Tide config (all optional, sensible defaults):** `CAPTAIN_MEMO_TIDE_ENABLED` (default on),
  `CAPTAIN_MEMO_TIDE_RELEVANCE_FLOOR` (`0.30`), `CAPTAIN_MEMO_TIDE_S0_OBSERVATION_DAYS`/`_MEMORY_DAYS`/`_SKILL_DAYS`,
  `CAPTAIN_MEMO_TIDE_W20`, `CAPTAIN_MEMO_TIDE_SRC_AUTO`/`_SEARCH`/`_DRILL`, `CAPTAIN_MEMO_TIDE_STAB_GAIN`,
  `CAPTAIN_MEMO_TIDE_STAB_CAP_DAYS`. Every threshold is config-driven — none are code constants.

### Changed
- **Observation search re-rank now uses Tide instead of the older flat recency decay.** The previous
  decay (`exp(−ln2·age/90d)`, floor 0) could fully zero a relevant-but-old hit; Tide's bounded
  multiplier (floor 0.30) is strictly gentler on relevance and carries **zero data movement**.
  Prefer the old behaviour? Set `CAPTAIN_MEMO_TIDE_ENABLED=0` and restart the worker.

### Database
- **Migration v8 (`add_tide_lifecycle`) — additive and safe.** Adds `stability_days`, `tide_state`,
  `tide_state_changed_at`, `is_anchored`, and a partial index on the non-default tier. Applies
  automatically on first start; no reindex, no re-embedding.

## [0.5.2] — 2026-06-05

### Fixed
- **Threaded Workers now load `worker.env`.** A Bun `Worker` does not inherit the main thread's
  runtime-mutated `process.env`. On Linux the systemd `EnvironmentFile=` masks this (the real env is
  inherited by every child), but on Windows (Scheduled Task, no env file) the threaded writer and
  reader engines fell back to defaults — `voyage-4-nano@localhost`, wrong dimension — so vector search
  silently degraded while the main thread looked correct. Each Worker now calls `loadWorkerEnv()` at
  the top of `boot()`, before building its options.
- **`reindex` no longer times out on large corpora.** The main→engine thread RPC used a fixed 10s
  deadline, so a full reindex (which re-embeds the whole corpus — minutes of work) returned a
  `503 thread_rpc_timeout` while the writer was still running, reporting failure on an eventual
  success. Known-long writes (`/reindex`) now get a 30-minute ceiling (override via
  `CAPTAIN_MEMO_REINDEX_MS`); all other ops keep the 10s default.

## [0.5.1] — 2026-06-04

### Added
- **Unified cross-AI install.** `captain-memo install` now auto-detects other MCP-speaking coding
  tools on the machine (Codex, Gemini CLI, Cursor) and wires each to the same local worker — registers
  the MCP server + installs the portable skill — so they share one corpus with zero manual setup. New
  `captain-memo connect` command (`connect`, `connect --list`, `connect <tool>`) does it on demand;
  `install --no-cross-ai` skips it. Best-effort: a wiring failure never fails the core install.

## [0.5.0] — 2026-06-04

### Added
- **Cross-AI memory — one corpus, many AI tools.** The worker is agent-agnostic and ships an MCP
  server, so any MCP-speaking coding agent can share the *same* local memory the way Claude Code does.
  This release adds a portable **skill** (`skills/captain-memo/SKILL.md` — one file that loads in Claude
  Code, Codex, and Gemini CLI alike) that tells the model when to recall, plus a setup guide
  (`docs/cross-ai-tools.md`) for wiring up **Codex** (`codex mcp add`), **Gemini CLI**
  (`gemini mcp add --trust`), and **Cursor**. Verified live: Codex *and* Gemini CLI both recalled an
  observation Claude Code had captured, from the same worker — no duplicated store. The MCP tools are
  recall-only (search + drill); capture stays automatic where the tool has lifecycle hooks.

## [0.4.0] — 2026-06-04

### Added
- **Reader pool — concurrent, restart-proof search.** The threaded worker now runs one **writer**
  engine (ingest, background ticks, and the `/health` heartbeat) plus a pool of **read-only reader**
  engines that serve searches on their own threads. Previously every search ran a synchronous
  sqlite-vec KNN scan (~290 ms over a large corpus) on the single engine thread, so a burst of
  recalls — one fires on every prompt — could stall the heartbeat past its 5 s freshness window and
  get the worker restarted. Reads now run off the heartbeat path entirely: the writer stays
  responsive under load, concurrent searches run in parallel, and the failure mode is graceful (a
  saturated read returns 503, it never blocks the writer). Configure with
  `CAPTAIN_MEMO_READER_POOL_SIZE` (default `2`, range `0`–`8`; `0` restores the single-engine
  behavior). Active only in threaded mode (`CAPTAIN_MEMO_WORKER_THREADED=1`).

## [0.3.2] — 2026-06-04

### Security
- **The worker now binds to `127.0.0.1` (loopback) only — never all interfaces.** The
  worker's HTTP API (search, stats, `/shutdown`) is unauthenticated and was binding
  `0.0.0.0` by default, so on any box with a public IP or an untrusted LAN the corpus was
  reachable off-box and anyone could `POST /shutdown` to kill the worker. It is now bound to
  loopback only, with no opt-out — the captain is a local memory layer and must never be
  exposed off-box. Local clients (CLI, hooks, MCP) are unaffected; they already connect via
  `localhost` → `127.0.0.1`.

### Fixed
- **The observation summarizer no longer discards a whole observation over one unknown
  `type`.** When the model returned a `type` outside the allowed set (e.g. `review`), schema
  validation threw and the entire observation — title, narrative, facts, concepts — was
  dropped. An unknown type is now coerced to the neutral default `change` (and logged); only
  a genuinely structural failure (missing title, etc.) still rejects.

## [0.3.1] — 2026-06-04

### Fixed
- **Threaded worker (`CAPTAIN_MEMO_WORKER_THREADED=1`) now starts on Windows.** Its
  integration test spawned the worker from a path built with `URL.pathname`, which on
  Windows is `/C:/…/index.ts` — a leading slash before the drive that `bun <path>` cannot
  resolve. The spawned worker exited with *"Module not found"* before it ever bound a port,
  so the test timed out as "never healthy" (Windows CI only; Linux was never affected
  because there `URL.pathname` is already a valid absolute path). The path is now built with
  `fileURLToPath`, and the engine thread is spawned from a `URL` object (the portable form)
  instead of a `file://` string.

### Added
- **The threaded flag is now always safe to enable.** If the engine thread cannot come up —
  the Worker constructor throws, it crash-loops past the supervisor cap, or it never posts a
  first heartbeat — the worker now **falls back to the single-threaded path inline** rather
  than leaving a dead, never-listening process. Engine spawn / `error` / `fatal` events are
  also logged now (they were previously swallowed), so a failed engine is visible in the
  worker log. Default-off; the single-threaded path is unchanged.

## [0.3.0] — 2026-06-03

### Added
- **Threaded worker (opt-in via `CAPTAIN_MEMO_WORKER_THREADED=1`).** The worker can now
  run a thin HTTP/health main thread plus a dedicated **engine thread** that owns all
  `bun:sqlite` work — search, ingest, the observation pipeline, the file watcher. Heavy
  *synchronous* work can therefore no longer starve `GET /health`: the main thread answers
  it **instantly from an engine heartbeat** (honest — a genuinely-stuck engine still
  surfaces as `degraded`, with the stalled op + duration logged). This removes the failure
  mode where a busy-but-alive worker was misjudged dead and force-restarted into a thrash
  that caused multi-minute outages. An engine crash is **respawned in-process** (sub-second),
  with a crash-loop cap. **Default-off**; cross-platform; the single-threaded path is
  unchanged and remains the default.

### Fixed
- **Atomic worker restart.** Recovery now issues a single atomic `systemctl restart`
  (one supervisor-owned job) instead of a separate stop-then-start, so a recovery
  interrupted mid-way can no longer leave the worker stopped with nothing to revive it.
  Added `TimeoutStopSec=10` so a stop completes promptly instead of waiting the 90 s default.

## [0.2.21] — 2026-06-02

### Fixed
- **The self-heal no longer thrashes the worker (root cause of the restart storm).**
  `UserPromptSubmit` reclaimed (force-killed + restarted) the worker on a **single**
  failed `/inject/context` — but that endpoint embeds the prompt to search, so a
  slow/flaky Voyage roundtrip makes it time out while the worker is perfectly alive.
  One blip could kill a busy worker mid-embed → it restarts → the next prompt lands
  during the ~10 s (VBS-launcher) startup → reclaim again → a self-sustaining cascade
  (dozens of restarts off one Voyage blip; only **one** genuine crash all day).
  `UserPromptSubmit` now **confirms** the outage with quick `/health` re-probes — the
  same confirm-then-reclaim the watchdog got in 0.2.16 — and only reclaims if `/health`
  stays unreachable. A live worker answers in ms, so the common case adds ~nothing.
  `SessionStart`'s `waitHealthy` budget also went 8 s → 15 s (override:
  `CAPTAIN_MEMO_SESSION_START_WAIT_HEALTHY_MS`) so the slower launcher startup isn't
  mistaken for a dead worker. (`probeHealthOnce`/`probeHealthyWithRetries` moved to
  `src/shared/worker-health-probe.ts`, shared by the hook and the watchdog.)

### Notes
- The rare genuine `0xC0000409` worker crash is a known Bun 1.3.14 Windows defect
  (oven-sh/bun #30031 / #29546 / #27692 — no fixed release yet). The 0.2.18/0.2.19
  backoffs reduce the trigger (Voyage flakiness); this fix stops one crash from
  cascading into a restart storm. Upgrade Bun once a Windows-stability release lands.

## [0.2.20] — 2026-06-02

### Fixed
- **The worker no longer shows a console window (Windows).** The Scheduled Task launches
  `bun` with an interactive token, so the worker popped a console window on every start.
  It now launches through a hidden `wscript` + `scripts/hidden-launch.vbs` wrapper — no
  console, no admin. The wrapper WAITS on the `bun` child, so the task stays "Running" for
  the worker's lifetime (the crash-recovery / `IgnoreNew` lifecycle and the port-based
  reclaim are unchanged) and propagates the child's exit code. S4U needs elevation and
  `conhost --headless` detaches (breaking the lifecycle) — both verified dead ends here;
  the VBScript host is the only no-admin option (validated live: worker runs hidden).
  Trade-off: a few seconds of extra startup latency (the `wscript`→`bun` hop).

## [0.2.19] — 2026-06-02

### Added
- **The embed-retry queue now backs off exponentially too.** Failed embeds (Voyage
  overloaded/down — timeouts, truncated responses) used to retry on a fixed 60 s tick;
  a chunk that keeps failing now waits progressively longer **per row** (~15-30 s on the
  first failure, then exponential with full jitter, capped at 10 min), so a Voyage outage
  stops being hammered while a transient blip still recovers fast. Mirrors the summarizer
  backoff from 0.2.18 (reuses `computeBackoffMs`; new `embedRetryDelayMs` helper, unit-tested).

### Fixed
- `/captain-memo:stats` now surfaces the `Worker  ● online · up …` liveness line (the CLI
  `captain-memo stats` / `top` already did since 0.2.17).

## [0.2.18] — 2026-06-02

### Added
- **The summarizer backs off when the Anthropic API is overloaded or down.** Bursts
  of `HTTP 529 overloaded_error` previously made the obs-batch loop retry every 5 s,
  hammering a struggling API — and after 3 fails it would dead-letter the
  observations. Now an overloaded/unreachable failure (408 / 429 / 5xx / network /
  timeout) puts the whole obs-batch loop into an **exponential-backoff cooldown**
  (full jitter, 15 s → 10 min cap, honoring a server `Retry-After`), and the affected
  observations are **requeued without counting a retry** — so a long outage *delays*
  summarization instead of losing observations. A clean summarize clears the cooldown.
  Permanent errors (auth / bad request / missing model) still dead-letter immediately;
  genuine per-item failures (e.g. a malformed model response) still dead-letter after a
  bounded retry. New pure, unit-tested helpers (`classifySummarizeFailure`,
  `computeBackoffMs`).

## [0.2.17] — 2026-06-02

### Changed
- **Dropped the standalone `captain-memo-watchdog` Scheduled Task.** It probed the
  worker every 5 minutes, but the Task Scheduler launches `bun` with an interactive
  token, so it flashed a console window each tick — and there's no clean no-admin way
  to hide a task's window (S4U needs elevation; `conhost --headless` breaks the task
  lifecycle the reclaim relies on). Autonomous recovery of a dead/zombie worker now
  rides on the `SessionStart` / `UserPromptSubmit` self-heal (reclaim-then-start at
  session boundaries). `install` removes the task if an earlier version registered it;
  `worker-watchdog` survives as a manual command for an explicit probe + reclaim.

### Added
- **Worker liveness on the stats page.** `/stats` now reports the worker's boot epoch
  and uptime, and `captain-memo top` / `captain-memo stats` show a
  `Worker  ● online · up 2h 13m` line — so a silently-restarting worker is visible at
  a glance (offline still shows the prominent "WORKER UNREACHABLE — STALE" banner).

### Fixed
- **No console-window flash from background service-management calls.** The
  `Bun.spawn` invocations of PowerShell / `schtasks` (status / start / stop / reclaim,
  run by the worker, the hooks, and `install`) now pass `windowsHide: true`.

## [0.2.16] — 2026-06-02

### Fixed
- **The watchdog no longer kills a *busy* worker.** `captain-memo-watchdog`
  reclaimed (hard-killed + restarted) the worker on a **single** missed `/health`
  probe. A healthy-but-busy worker — e.g. while the summarizer retried an overloaded
  API (HTTP 529) — could miss one 3-second probe and get killed and re-indexed every
  ~5 minutes, dropping in-flight work (and, on Windows, popping a console window each
  time). The watchdog now **confirms a real outage with spaced retries** (probes up
  to 3× / 2 s apart) and treats the worker as healthy if *any* attempt succeeds, so
  only a *persistent* outage — a true zombie — is reclaimed. Unit-tested
  (`probeHealthyWithRetries`: first-ok / recover-midway / all-fail / recover-on-last).

## [0.2.15] — 2026-06-01

### Fixed
- **Zombie-worker recovery — a worker whose HTTP server died (but the process is still
  alive) is now recovered automatically.** A worker can become a *zombie*: the process
  is up but `Bun.serve` no longer answers `/health`. On Windows this defeated every
  recovery path — a bare `Start-ScheduledTask` is a no-op under
  `MultipleInstancesPolicy=IgnoreNew` while the zombie holds the task "Running", and the
  5-minute watchdog trigger is blocked for the same reason. In the field this left the
  worker unreachable for ~2.7 h until a manual kill. The `SessionStart`/`UserPromptSubmit`
  self-heal now *reclaims* before starting: `stop` gained a `force` option that hard-kills
  whatever `bun` process still holds the worker port (best-effort, never fatal — a reclaim
  failure can't block the restart), so the next start binds a fresh worker. systemd is
  unaffected (`systemctl stop` already kills; `force` is a documented no-op there).

### Added
- **Autonomous watchdog task (`captain-memo-watchdog`, Windows).** A *separate* per-user
  Scheduled Task runs `captain-memo worker-watchdog` every 5 minutes: it probes `/health`
  and, if the worker is unreachable, reclaims the port and restarts it — recovering a
  zombie even with no Claude session open. It must be its own task because `IgnoreNew`
  blocks the worker task's own relaunch while the zombie holds it "Running". Registered by
  `install`, removed by `uninstall`.
- **`top` / `watch` stale-data banner.** When the worker stops answering, the live
  dashboard now shows a prominent "WORKER UNREACHABLE — data is STALE" banner (with the
  last-good timestamp) instead of rendering the last snapshot behind a ticking clock as if
  it were live.

### Tests
- New unit tests: `restartWorker` (reclaim-then-start ordering; `force` always set), the
  pure `runWorkerWatchdog` policy (healthy no-op / unreachable→reclaim / lock-held→skip /
  reclaim-failure / still-down), the `buildReclaimPortCommand` PowerShell builder (exact
  `bun` guard, no `$pid` self-kill footgun, bounded loop, invalid-port rejection), and the
  `top` unreachable banner. Validated end-to-end against a live zombie on real Windows
  Task Scheduler.

## [0.2.14] — 2026-05-31

### Added
- **Worker auto-recovery — a killed worker now returns on its own.** systemd units
  use `Restart=always` (+ `StartLimitIntervalSec=0`, so a flapping worker is never
  permanently abandoned by systemd's start-rate limiter); the Windows Scheduled Task
  gains a 5-minute watchdog repetition trigger (`MultipleInstancesPolicy=IgnoreNew`
  makes it a no-op when the worker is alive). This closes the gap where a clean-signal
  kill (`SIGINT`/`SIGTERM`; Windows `STATUS_CONTROL_C_EXIT` / `0xC000013A`) was NOT
  treated as a restartable failure, leaving the worker dead until a manual restart or
  logon. Applies to both the worker and the embedder.
- **`SessionStart` self-heal.** A dead worker is started, and a *stale* one — running
  code older than the installed `VERSION` — is graceful-restarted (bounded wait), so a
  new session always opens on a healthy, current worker. `UserPromptSubmit` nudges a
  dead worker back without blocking the prompt. The heal policy lives in a pure,
  unit-tested `ensureWorkerHealthy` orchestrator and is serialized across concurrent
  sessions by an advisory lock. Opt out with `CAPTAIN_MEMO_DISABLE_SELF_HEAL=1`.

### Tests
- New unit tests: the Windows watchdog trigger XML, the always-on systemd templates,
  the advisory heal-lock (acquire / TTL-reclaim / idempotent release), and the
  `ensureWorkerHealthy` policy (healthy / unreachable→start / stale→restart /
  lock-held→skip / start-failure→report). The SessionStart and UserPromptSubmit hook
  tests were updated to exercise the self-heal gate.
- `dispatcher-e2e` and the `hook` dev script now reference `bin/captain-memo-hook.ts`
  directly (not the extensionless `bin/captain-memo-hook` symlink), so the suite is
  green on a Windows checkout where `core.symlinks=false` materializes the symlink as
  plain text.

### Notes
- **Local Dreaming** accumulates co-retrieval data only while the recall audit is on.
  It is opt-in and default-off: set `CAPTAIN_MEMO_RECALL_AUDIT=1` in `worker.env` and
  restart the worker. Privacy trade-off — audit lines contain prompt text and stay
  strictly local (`<data-dir>/recall-audit.jsonl`, never transmitted).

## [0.2.13] — 2026-05-31

### Changed
- **Hook failures are now visible instead of silently swallowed.** The v0.2.12 fix
  restored hook *dispatch*, but the handlers still discarded their `workerFetch`
  results — so a worker outage would have reproduced the same silent freeze
  (frozen stats, no banner) with an **empty `hook.log`**, undebuggable. Now every
  worker call in `PostToolUse`, `Stop`, `PreCompact`, `UserPromptSubmit`, and
  `SessionStart` logs non-OK/timeout results via a new `logWorkerFailure` helper,
  and every previously-swallowed stdin-parse error is logged too. Fail-open is
  unchanged — no hook ever throws, exits non-zero, or blocks Claude Code.
- **`SessionStart` shows a degraded banner when the worker is unreachable** —
  `⚓ Captain Memo — worker unreachable / Memory is paused this session …` — instead
  of falling silent, so a missing banner can no longer be mistaken for a broken
  hook. Memory resumes automatically once the worker answers again.

### Tests
- New pure unit tests for `workerFailureMessage` (the OK→no-log path plus the
  timeout / HTTP-error / status-fallback branches), and a behavioral test that
  spawns the committed bundle against a closed worker port and asserts the
  degraded banner is emitted (not silence).

## [0.2.12] — 2026-05-31

### Fixed
- **Every Claude Code hook was a silent no-op (regression in v0.2.3–v0.2.11).** The
  committed plugin bundle (`plugin/dist/captain-memo-hook.js`) dispatched to its
  handlers via `await import(target)` with a **variable** specifier. `bun build`
  only inlines a dynamic import whose specifier is a string **literal** — a variable
  is left as a *runtime* import, which then resolved `../hooks/*.ts` next to the
  single-file bundle (where no such files ship) and threw `Cannot find module`. The
  dispatcher's fail-open `catch → exit(0)` swallowed it, so **the SessionStart stats
  banner never appeared and PostToolUse never captured observations** — yet every
  hook reported success. Fix: `src/hooks/dispatcher.ts` now **statically imports**
  all five handlers and dispatches by function reference, so `bun build` inlines
  every handler into a genuinely self-contained bundle (89 → 359 lines).
- This restores the startup banner, prompt-time memory injection, observation
  capture, the Stop drain, and the PreCompact recap — all of which had been dormant.

### Tests
- New guards so this cannot silently recur: a **behavioral** test spawns the
  committed bundle and asserts it dispatches end-to-end (the prompt echoes back), a
  **self-contained** test asserts every handler body is inlined and no `../hooks/`
  path reference survives, and a **source-rebuild** test builds the bundle fresh
  from source and re-checks the same invariants (catching committed-vs-source drift
  on every OS, not just Linux CI).

## [0.2.11] — 2026-05-31

### Fixed
- **`install` (re-run / upgrade) no longer silently drops the user's config.** A
  re-install — notably `install --yes` — now loads the existing `worker.env` as the
  fallback (precedence: flag → env → existing → default), via a new exported
  `loadExistingConfig()` that reverse-parses `worker.env` into a `WizardConfig`.
  Previously it passed `{}`, so a headless upgrade rewrote `worker.env` from
  defaults and **silently produced a keyless, non-embedding file** (the reported
  bug). Now preserved across an upgrade:
  - the embedder **API key**, model, endpoint, and a **non-default embedding
    dimension** (was reset to 1024 → model/dimension mismatch);
  - the **summarizer provider + model** (anthropic model was reset to
    `claude-haiku-4-5`), and `summarizer=skip` (was flipped to `claude-oauth`);
  - the **watch choice** including `skip` and custom globs (was reset to
    `all-projects`), and a tuned `CAPTAIN_MEMO_HOOK_TIMEOUT_MS`.
  `skip` choices are inferred from the absence of their line (the worker treats an
  unknown provider as "fall back to default", so writing a literal `=skip` would
  wrongly re-enable it — no worker change was made).
- **Embedder-provider inference no longer misclassifies a remote `:8124` endpoint**
  as the local sidecar (which dropped its endpoint/model/dim/key); only a loopback
  `127.0.0.1`/`localhost` `:8124` is treated as the sidecar.
- **`loadExistingConfig` is best-effort** — an unreadable `worker.env` warns and
  degrades to "no preserved values" instead of aborting the upgrade with a stack
  trace.

### Added
- Guard tests for every preservation case above
  (`tests/unit/install-preserve-config.test.ts`) and for the v0.2.10 doctor
  orphan-skip (`tests/unit/doctor-cache.test.ts`; `findCachedPluginRoot` is now
  exported + parameterized by cache root for testability).

### Known limitation
- A hand-edited `CAPTAIN_MEMO_DATA_DIR` is **not** preserved across re-install (it's
  a fixed/computed location, not a wizard field) — the wizard never produces a
  non-standard one, so this only affects manual edits.

## [0.2.10] — 2026-05-31

### Fixed
- **`doctor` now respects Claude Code's plugin-cache grace period.** After an
  upgrade, Claude Code keeps the previous version's cache dir for 7 days (marked
  with `.orphaned_at`) before garbage-collecting it itself. `findCachedPluginRoot`
  now skips orphaned dirs and evaluates only the active copy, so a normal
  grace-period leftover is never mistaken for the install or reported as "stale" —
  which would have wrongly suggested a manual cache cleanup. (Researched against
  the Claude Code plugins reference: there is no sanctioned command to prune stale
  versions and reaching into the cache is unsupported, so the correct behavior is
  to leave the cache to Claude Code and just read it correctly.)

## [0.2.9] — 2026-05-31

### Changed
- **One version, everywhere.** The version is now sourced from a single global
  (`src/shared/version.ts`, re-exporting `package.json`'s version) consumed by the
  CLI banner, the worker `/stats` response, and the MCP `serverInfo`. The MCP
  server had a stray hardcoded `'0.1.0-alpha'`; the CLI and worker each imported
  `package.json` independently. Now there is exactly one place to read from — and
  exactly one place to bump.
- **`package.json`, `plugin.json`, and `marketplace.json` versions are unified**
  (all → 0.2.9) and a guard test asserts they stay identical. Because the
  plugin-cache key is the manifest version, bumping all three every release makes
  the cache key advance each time — so the frozen-cache class of bug (v0.2.8)
  cannot recur, with the `marketplace remove`→`add` refresh as belt-and-suspenders.

### Fixed (review hardening)
- **`install` no longer risks destroying a corrupt `settings.json`.** `readSettings`
  treated a present-but-unparseable file as empty and then wrote a near-empty file
  back over it — a stray trailing comma mid-edit could have wiped a user's hooks /
  model / statusLine on upgrade. It now refuses to modify a file it can't parse and
  surfaces a fix-it message.
- **The plugin-cache refresh `marketplace remove` is now `--scope user`,** so it
  can't silently migrate a deliberately project/local-scoped marketplace to user
  scope. The remove→add order is extracted into a pure, exported
  `pluginRegistrationSteps()` and unit-tested (the v0.2.8 fix was previously
  untested). Added guards for committed-bundle version freshness (catches a
  bump-without-rebuild) and `--no-grant-permissions` parsing.

### Note
- The worker reports its version as of process **start** (it reads the source once
  and Bun doesn't hot-reload), so after upgrading, restart the worker
  (`systemctl --user restart captain-memo-worker`, or `captain-memo install`) for
  `/stats` to show the new number.

## [0.2.8] — 2026-05-31

### Fixed
- **`install`/upgrade now repairs a frozen plugin cache.** A `directory`-source
  marketplace is snapshotted by Claude Code at *add* time, and a bare
  `claude plugin marketplace add` is a no-op once the entry exists — so a plugin
  file that changed after the marketplace was first added (notably `hooks.json`)
  stayed **frozen** in the cache. After the v0.2.3 `bin/`→`dist/` hook move, any
  install whose marketplace had been added at 0.1.0 kept launching the deleted
  `bin/captain-memo-hook`, producing `… /plugin/bin/captain-memo-hook: not found`
  on every hook event. `registerPlugin` now does a best-effort
  `marketplace remove` before `add`, forcing a fresh re-copy of the current plugin
  on **every** install/upgrade.

### Changed
- **`marketplace.json` plugin version synced to `plugin.json` (→ 0.2.4).** It had
  silently lagged at 0.1.0, which is what froze the directory-marketplace cache.

### Added
- **Guard tests (`tests/unit/plugin-manifest.test.ts`).** Assert `marketplace.json`
  and `plugin.json` versions stay in lockstep, and that the shipped hooks reference
  the committed `dist/` bundle (never the deleted `bin/captain-memo-hook` symlink)
  with both bundles present — turning this class of drift into a CI failure rather
  than a field break.

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
