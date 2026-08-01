# Changelog

All notable changes to captain-memo are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
semantic-ish versioning while pre-1.0. Full notes for each release live on the
[GitHub releases page](https://github.com/kalinbogatzevski/captain-memo/releases).

## [0.27.49] — 2026-08-01

### Fixed

- **`captain-memo dedup --apply` folded rows the automatic sweep protects.** The background pass
  skips any member that was drilled into or explicitly anchored — "a protected memory is never
  archived automatically" — but the manual command called the merge directly and never consulted
  that gate. The manual tool was therefore *more* destructive than the automatic one it supplements,
  which is exactly backwards, and it mattered the moment the automatic pass started shipping on.

  Filtered when the groups are built rather than at apply time, so the dry-run stops promising folds
  that will not happen. On a 124k-row corpus the dry-run drops from 628 groups / 850 archivable to
  626 / 846.

### Changed

- **`captain-memo dedup` now documents that its gate differs from the hourly sweep's.** It decides on
  title similarity alone; the sweep additionally requires an embedding cosine ≥ 0.95. That gap is the
  reason the command exists — the sweep is bounded to the most-recently-surfaced
  `CAPTAIN_MEMO_QM_DEDUP_WINDOW` rows, and folding slides that window only by as much as it folds, so
  on a 14,409-row surfaced corpus it reaches a fixed point after about three sweeps having folded 212
  of 846 foldable rows and then goes quiet. This command is the unbounded pass that clears the rest.
  Reach in exchange for a looser gate, which is why it is dry-run by default. An operator should not
  have had to read the source to learn their manual tool judges differently from the automatic one.

## [0.27.48] — 2026-08-01

### Changed

- **Both Quartermaster housekeeping passes are now ON by default.** Auto-dedup and version-supersede
  were each opt-in. On the heaviest known install, supersede had recorded **zero** rows in `qm_runs`
  after 1,241 dedup runs — the env var it needed had never been set, so in two months of running it
  had never executed once. A default nobody enables is a feature nobody has.

  Neither pass is as destructive as the opt-in default implied. Dedup **archives** a near-duplicate
  into a survivor rather than deleting it, skips any row that was ever drilled into or explicitly
  anchored, partitions by `(project, branch)` so a fold can never cross scopes, and requires **both**
  a title-similarity gate and a cosine confirm. Supersede applies a reversible 0.5× score demotion.
  `captain-memo dedup --undo` and `captain-memo supersede undo` reverse them.

  Turn either off with `CAPTAIN_MEMO_QM_DEDUP=0` / `CAPTAIN_MEMO_QM_SUPERSEDE=0`, or both with
  `CAPTAIN_MEMO_QM_ENABLED=0`. (Both env reads were `=== '1'`, which ignored the shipped default
  outright; they are now `!== '0'`.)

- **`CAPTAIN_MEMO_QM_DEDUP_WINDOW` default raised from 500 to 5,000.** The 500 was never measured —
  it came from the original design plan, specified in the same breath as the 0.98 cosine threshold
  that later proved unsatisfiable. Measured on a 14,409-row surfaced set across 211 partitions
  (grouping is O(n²) per partition):

  | window | grouping cost | foldable rows visible |
  |---|---|---|
  | 500 | 37 ms | 9 |
  | 2,000 | 131 ms | 44 |
  | **5,000** | **401 ms** | **200** |
  | 14,409 (all) | 3,076 ms | 850 |

  So 500 hid 94% of the duplicates that existed, and the symptom was visible in the audit table:
  11 merges across 1,241 runs. Scanning everything is not the fix either — `candidates()` is
  evaluated synchronously before the slice's first yield, so the full set means a 3-second stall.
  5,000 sits just under the ~450 ms whole-corpus scan the supersede pass already runs hourly.

### Fixed

- **The supersede sweep never converged.** Its candidate scan selected on `archived = 0` alone, so a
  pair stayed a candidate forever after being linked. `linkSupersede` is idempotent, so nothing was
  ever corrupted — but every hour the sweep re-proposed the same finished work and paid a vector read
  plus a cosine compare for each re-proposal. An already-superseded row is never the newest version of
  its entity, so excluding it cannot hide a head. Harmless while the pass reached nobody; not harmless
  once it is on by default.

- **`supersedeCandidateWindow` ignored its own window limit.** The parameter was declared, documented
  as "caps how many PAIRS are emitted", and never read, so an operator lowering
  `CAPTAIN_MEMO_QM_DEDUP_WINDOW` to bound the work got no effect at all. Now honoured — which is only
  safe because of the convergence fix above: without it, a cap would have permanently starved
  whichever partitions sorted last.

- **`/stats` reported one Quartermaster pass under the other's heading.** Both passes write to
  `qm_runs`, and `qm.last_run` read the latest row of *any* job. With supersede switched on, a
  supersede sweep showing `merges: 0` appeared beside `dedup_enabled` and `cosine_threshold` — reading
  exactly like a dedup sweep that found nothing. `qm.last_run` is now scoped to `job='dedup'`, and
  supersede gets its own block carrying its enabled flag, threshold and last run.

- **"Top recalled" printed a number it was not sorted by.** The list is ranked by drill count alone,
  but each entry displayed its `auto + search + drill` total, so on a real corpus it read
  `9× 7× 8× 7× 38×` — indistinguishable from an unsorted list, and reported as one. The order was
  correct throughout: every entry was tied on drill count and fell through to recency. Each top list
  now prints the metric that ranks it; the provenance triplet beneath still carries the full
  breakdown.

### Added

- **`docs/CONFIGURATION.md`** — a reference for all 133 environment variables: what each defaults to,
  which subsystem owns it, and a single table of every kill switch. Coverage is verified
  mechanically, so no setting the code reads is missing and no setting listed is one the code ignores.
  It opens by arguing you should set none of them, and against pinning values you are not deliberately
  overriding — several of the defaults changed in this release precisely because opt-in reached
  nobody, and a pinned value would not have benefited.

## [0.27.47] — 2026-07-31

### Changed

- **Memory tiering (Tide phase 2) is now ON by default.** It had been built, tested and left
  switched off, so it had never moved a row. The reason was misread as "the flag is off"; measuring
  showed the real cause is that `ageFloorDays` is 90 and the oldest observation on the heaviest known
  install is 83 days old — nothing has ever been *eligible* to ebb. On that 123,166-row corpus the
  first sweep moves **zero** rows, and a brand-new install stays inert for its first ~109 days.

  Ebbing is non-destructive. A sunk observation is dropped only from the **auto-injected context
  envelope**; it stays fully searchable, is merely down-ranked by buoyancy, and a single recall
  re-floats it. Nothing is deleted, no vector is removed, and rows that came from a drill or are
  anchored are excluded from the sweep entirely.

  Turn it off with `CAPTAIN_MEMO_TIDE_TIERING=0`. (The env read was previously `=== '1'`, which
  ignored the shipped default outright — it is now `!== '0'`, matching how `CAPTAIN_MEMO_TIDE_ENABLED`
  already behaved.)

### Fixed

- Corrected a source comment that blamed a measured test-suite slowdown on the code, when the cause
  was concurrent test processes on the machine doing the measuring.

## [0.27.46] — 2026-07-30

### Added

- **`captain-memo maintenance [--apply] [--retention-days N]`** and an hourly automatic sweep in the
  worker (plus one at boot, so an upgrade repairs immediately). Nothing ever deleted from
  `observation_queue` — `markDone` only flipped a status — and nothing ever removed embeddings whose
  chunk had gone. One live install carried 235,899 finished queue rows in a 610.9 MB `queue.db` and
  57,373 orphaned vectors (29.3%) in an 807.9 MB store. Applying it reclaimed **357 MB**.
  `CAPTAIN_MEMO_QUEUE_RETENTION_DAYS` tunes the window (0 disables).

  Two details that decide whether this works at all: `VACUUM` alone does not shrink a WAL database — the
  rewrite lands in the `-wal` sidecar, so the checkpoint is what returns the pages. And the orphan
  cleanup refuses to run without the `sqlite-vec` extension loaded, because `vec_chunk_meta` is an
  ordinary table that deletes fine without it while the index does not: a half-clean would strand every
  embedding in the opposite direction, invisible to the check that found it.

### Fixed

- **Dedup could never fire.** `dedupCosineThreshold` shipped at 0.98, above what two phrasings of one
  fact reach in this embedding space. Measured on 122,647 observations: 400 pairs with *identical*
  titles scored median 0.9467, p95 0.9779, max 0.9896 — only 3.5% reached 0.98, while unrelated pairs
  sit near 0.50. Dedup merged 5 rows after examining 16,679 candidate groups across 1,204 runs. It was
  never blocked by the merge guard or the partitioning; one unsatisfiable constant. Now 0.95, with
  supersede split onto its own `supersedeCosineThreshold` (0.93) since it applies a reversible demotion
  where dedup archives a row.
- **Supersession could never see a pair.** Its candidate window reused the surfaced-rows query — 11.7%
  of the corpus — and required both halves inside one 500-row recency slice, while real version chains
  span months. Of 294 version pairs present corpus-wide, the live window contained 0. It now scans all
  live rows (~450 ms hourly; only ~2% of titles parse a version), and requires creation order to agree
  with version order so a calendar-style version like `2026.0512.24` cannot mark a *newer* note stale.
- **`files_modified` was empty on every observation.** The hook decided "was this a modification?" by
  sniffing the tool *response* for a `success` key, which Claude Code's Edit/Write responses do not
  carry — so every file-touching tool was recorded as a read (198 of 400 sampled events had
  `files_read`, zero had `files_modified`). Classification is by tool name now; an unknown tool degrades
  to "read" rather than claiming a false modification.

## [0.27.45] — 2026-07-30

### Added

- **`captain-memo queue dedupe`** — a repair tool for installs that accumulated duplicates before the
  capture fix in 0.27.44. That release stopped the amplification but could not undo it: an affected
  queue still holds re-summarisations of turns the corpus already has, and each one is a real LLM call.
  One live install sat at 30,564 pending. Dry-run by default; `--apply` removes.

  Identity is `(session_id, prompt_number)` — stable across re-extracts of an append-only log, and
  deliberately not the whole payload (a session without timestamps gets a `ts_epoch` seeded from
  `now()`, which drifts between extracts of the same turn). Exactly two classes are removed: a pending
  turn already marked `done`, and pending rows duplicating an earlier pending row (earliest kept). Rows
  in `processing` are never touched, nor used to justify removing a sibling, so a row being summarised
  cannot vanish under the worker. Safe to run with the worker up.

## [0.27.44] — 2026-07-30

### Fixed

- **Cross-AI capture re-enqueued a growing session's whole history on every tick.** The dedup key is
  the session file's `mtime:size`, which changes on every append, and `extract()` has no cursor — it
  returns the entire file each time. A session growing to N turns therefore cost **N(N+1)/2** enqueues
  instead of N (a 50-turn codex session: 1,275 items instead of 50), and every one of those is a
  summarizer LLM call. Seen on a light install: codex at 8,950 observations — 97.8% of the corpus —
  with 30,564 more queued and 12.1 M tokens distilled. `capture_ingested` now carries an event cursor
  and only the new tail is enqueued; a file that comes back *shorter* was rotated, so it is re-ingested
  whole rather than silently skipped.
  *This stops further amplification but does not shrink a queue that already contains duplicates.*
- **The queue line now says why it is not draining.** Showing the count was half the job — 30,000
  waiting looks the same whether it is a backlog being worked through or a queue nothing will ever
  process. `/stats` has carried `summarizer.last_error` since it was added with nothing rendering it.
  It now reads `stalled — no summarizer configured` or `retry in 45s — <error>`.

## [0.27.43] — 2026-07-30

### Changed

- **The recall audit log is ON by default, so Dreaming works out of the box.** It was opt-in on privacy
  grounds and Dreaming reads it, so the feature shipped dead — the stats page reported it disabled and
  pointed at a setting. The privacy rationale does not survive contact with the filesystem: the log
  never leaves the machine (nothing indexes it into the searchable corpus, nothing relays it to a peer
  or hub — every reader is local), the raw prompts are already in the Claude transcript on that same
  disk, and the memory snippets are already in `observations.db` on that same disk. Set
  `CAPTAIN_MEMO_RECALL_AUDIT=0` to opt out.
- **The audit log is now bounded.** One live host reached 24.7 MB with nothing to stop it; default-on
  without a bound fills a disk. Past 32 MB (`CAPTAIN_MEMO_RECALL_AUDIT_MAX_BYTES`) it rotates to
  `recall-audit.jsonl.1`, keeping one generation.

### Fixed

- An empty audit log no longer renders as a red **"— off"** with a "set this env var" hint. It is on by
  default now, so an empty log means "nothing retrieved yet" — the old wording read as a fault on a
  fresh install and sent people looking for a setting that was already enabled.

## [0.27.42] — 2026-07-30

### Fixed

- **`doctor` honours `CAPTAIN_MEMO_WORKER_PORT`.** mcp-server, restart and upgrade all read it; doctor
  alone hardcoded the default, so on a captain moved to another port every probe hit an empty port and
  doctor reported the worker down while it was serving fine — a diagnostic tool confidently
  misdiagnosing the one thing it exists to check.
- **Stats labels name what they actually count.** The all-time total bills sessions AND agents but was
  labelled with the session count alone, so the reader divided a two-population total by one
  population; it also dropped `oldest_epoch_ms`, leaving "all time" with no start date. Dream
  co-retrieval counted doc_ids from every channel while calling them "observations" and dividing by
  the observation count, which both misnames the set and lets the percentage exceed 100%. And "since
  worker start" appeared only in the zero-data branches, so the qualifier vanished exactly when there
  were numbers to misread as lifetime totals.

## [0.27.41] — 2026-07-30

### Fixed — doctor

- Schema health is judged by **evidence, not by a claim**. doctor counted rows in `schema_versions`,
  but a migration that aborted partway was still recorded as applied — so it reported "20/20 applied"
  while the column it was supposed to add did not exist and every query touching it threw. It now
  builds the canonical schema by running the real store constructors into `:memory:` and diffs
  `PRAGMA table_info` against the live file, so there is no hand-maintained column list to rot: the
  migrations stay the single source of truth and a new one automatically extends what is verified.
  `pending_embed.db` is included because it has no `schema_versions` at all — which is exactly why the
  missing `last_error` column broke every existing install with nothing to catch it.
- The migration report now reaches the PASS/WARN/FAIL list. It printed as loose text outside the
  verdict, so a captain with pending migrations still ended on "All systems go" and exit 0.
- `/health` green + `/stats` broken is a FAIL with a remedy, not a remedy-less WARN and exit 0. That
  combination means the worker cannot serve a single read — the cockpit shows the captain as
  unreachable — and it is what a schema change that outran its migration looks like from outside.
- A hosted embedder endpoint is no longer PASSed on sight. The default install IS hosted, so the one
  backend everybody runs was the one never checked; a 429-throttled queue with stuck observations
  reported clean. doctor now judges it by what the worker says its embed queue is doing, and
  distinguishes a rate limit (drains on its own, remedy optional) from an auth failure (retrying never
  fixes a bad key).

### Fixed — metering, storage

- `injectedBySession` advanced a shared read cursor across an `await`; with no per-message dedupe on
  that path, an overlapping read genuinely double-counted and then left the offset past what it had
  consumed, which never self-heals.
- Window totals counted agents as sessions under a field named `sessions` (the mislabel already fixed
  on the all-time figure), and dropped finished workflow agents from what is a spend figure, not a
  liveness one.
- `busy_timeout = 5000` on `observations.db`. It was SQLite's default 0 — a locked database throws
  `SQLITE_BUSY` instantly rather than waiting, which with WAL and several processes on one file turns
  routine contention into hard errors, and is precisely what leaves a migration half-applied.

## [0.27.40] — 2026-07-30

### Fixed
- **A migration that aborts partway was permanently marked applied, silently discarding data.** Each migration ran bare, so a multi-statement `up` interrupted by a crash, OOM, restart-during-upgrade or `SQLITE_BUSY` left half its statements committed. The retry then hit *"duplicate column"* on statement 1 — which the runner reads as idempotent-recovery — and **recorded the migration as applied**, so the rest never ran. Proven with a kill sweep, not argued: every offset in a ~400 ms window left all four v5 `ALTER`s committed and the backfill rolled back, and the next boot marked v5 applied and **discarded 200,000 rows of retrieval history with no error raised**. The harsher variant leaves later migrations throwing `no such column` on every boot forever while `doctor` still reports "20/20 applied ✓". Six existing migrations are multi-statement. Each now runs in one transaction, so a partial `up` rolls back whole and the retry re-runs it cleanly.
- **The workflow-name cache blanked every workflow after a session's first.** Keyed on `sessionId`, it held *the set of workflow ids that existed when that session was first scanned* — and a session runs many workflows (ten in one session here). Every later workflow rendered as anonymous `wf_` hex with no description, for the life of the worker: the exact failure the naming feature exists to prevent, reintroduced by its own performance optimisation hours later. A miss now invalidates and re-reads, which leaves the measured 490 ms saving intact because a hit is every poll and a miss is a new workflow.
- **Releasing a transcript's message-id map moved a full re-read onto the 10-second poll.** Sealing an idle transcript bounded memory, but the all-time scan seals essentially everything — so resuming a session after a break made the next live poll re-read the entire file, and the release could land between a concurrent scan's read and its digest, doubling those bytes. Replaced with a bounded ring of recent ids: no sealing, no rebuild branch, no race window. Measured while tuning it, because the obvious theory was wrong — varying the ring 32x moved RSS by less than run-to-run GC noise, so the id map is not the dominant memory and there is nothing to tune.

## [0.27.39] — 2026-07-30

### Fixed
- **HOTFIX: `/stats` returned 500 on every existing install — *"no such column: last_error"*.** The previous release added `last_error` and `last_error_at_epoch` to the `pending_embed` schema, but `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so those columns were never added to any database that had run before. The first query touching them threw, `/stats` 500'd, and because `/health` does not touch that table it stayed green — so the cockpit reported the captain **unreachable** rather than one endpoint broken. A fresh install worked perfectly, which is exactly why the tests passed: every one of them built the database from scratch, leaving the entire upgrade path unrepresented. The queue now migrates additively on open (read `PRAGMA table_info`, add only what is missing), and the regression test creates the OLD table explicitly before opening the queue over it.
- **The team-lead and workflow-name lookup caches survived a test reset.** Both are module-level and keyed by a name rather than by the config directory they were resolved under, so a test running earlier under a different `CLAUDE_CONFIG_DIR` left a cached MISS that a later test inherited — the team-lead test passed alone and failed in the suite. `_resetNativeUsageCache()` clears them now. Same class as the render-loop bugs fixed earlier: state that outlives the scope it was computed for.

## [0.27.38] — 2026-07-29

### Fixed
- **A failed embed reported a count and never a cause.** The pending-embed queue stored `retries` and `next_retry_at_epoch` but not WHY a chunk failed, so the cockpit showed "19 failed" and an operator had to open `worker.log` to discover a Voyage free-tier rate limit — HTTP 429, *"you have not yet added your payment method … 3 RPM"*. Nothing was lost and nothing was broken: the queue had been retrying with per-row exponential backoff the whole time. But a self-healing configuration state rendered as damage. The queue now records the error text (clamped to 400 chars — it is an upstream body headed for a dashboard) and classifies it, because the remedies differ: `rate_limited` needs nothing at all, `auth` will never recover without action, `unreachable` is transient, `other` is shown verbatim rather than guessed at. `/stats` carries `embed_pending`, `embed_error`, `embed_error_class` and a timestamp beside the count.

## [0.27.37] — 2026-07-29

### Fixed
- **Agent output tokens were under-counted ~30x: a repeat is not always a copy.** The per-message dedupe added in 0.27.33 keeps the first copy of a usage block, which is exact for session transcripts and wrong for agents — agents stream PARTIAL usage, rewriting one message id with identical input and a growing `output_tokens` (`39 → 197 → 2742`). Measured across a 400-file sample of each: sessions had 9,684 duplicated ids with **zero** differing, agents had 3,762 of which **3,112 (83%) differed**, and agent output read 142,777 against a true 4,694,491. The earlier "exact, not a heuristic" claim was measured on the four largest transcripts — all of them sessions — and generalised. Usage is now accumulated as the **largest value seen per id**, adding only the increment: a no-op for a true copy, and it cannot walk a total backwards if a smaller copy arrives late. Fleet-wide token totals barely move (output is small against cache reads); what changes is attribution — agents' share of all output goes from ~2.5% to ~36%.

## [0.27.36] — 2026-07-29

### Fixed
- **The all-time token total was understated by 27%.** Retiring finished workflow agents (0.27.34) is right for "what is running now" and wrong for "what has this ever cost" — but one rule served both, so the lifetime scan silently dropped every agent whose workflow journal recorded a result. On this machine that was **2,634 agent transcripts holding 188.9M billed tokens**; the host's all-time figure went from 700.1M to 886.3M once the two questions were separated. `readNativeSessionUsage` now takes `{ includeFinished }`, which `allTimeTotals()` sets and the live board does not.

## [0.27.35] — 2026-07-29

### Fixed
- **The vibe adapter and `mergeVibeMcpConfig` shipped with no tests.** Both are in this line, but their coverage existed only on the federation branch — so the TOML merge and the `connect vibe` path were untested here. Ported back (3 tests). A test that exists on one of two mirrored lines protects neither.

## [0.27.34] — 2026-07-29

### Fixed
- **`install` looked hung during "Wiring other AI tools", and an operator killed it.** Every line that step printed came *after* its work finished, so a slow tool left nothing on screen but the section header. Measured: detection is 19 ms for eight `which` probes, while wiring runs each tool's own CLI and **`gemini mcp add` alone takes ~5 s — 91% of the step**. It now announces what it is about to do and names each tool *before* probing or wiring it, so whatever line is last on screen says what it is waiting on. `connect` narrates identically, since that is the command an operator is told to re-run after a stall. Nothing was ever at risk here: wiring is the last step, and indexing runs asynchronously inside the worker service, not in the installer.
- **A stuck `PATH` entry could hang the installer indefinitely.** Detection shells out to `which`, which walks every `PATH` entry — one network mount or stale automount and it blocks with no ceiling. Detection now has a 5 s ceiling and reads a timeout as "not installed" (a timed-out probe returns `status: null`, which detection already treated that way). Wiring gets its own, far longer ceiling: a single shared 5 s limit would have killed `gemini mcp add` at 5,031 ms, right at the boundary, breaking Gemini wiring intermittently.
- **A workflow's finished agents lingered on the fleet board as ACTIVE.** Liveness is transcript mtime inside the activity window — correct for a session, where a person idles between prompts, and wrong for an agent, which is a one-shot task that either writes or is done. A completed 12-agent workflow stayed listed for the rest of the window with its tokens counting toward "what is running now". The workflow journal records a `result` line per finished agent, so those are dropped; the journal is re-read per poll rather than cached (it grows while the workflow runs), and a missing journal reports every agent, because absence of evidence is not evidence of completion.
- **Concurrent scans could silently LOSE tokens.** `accumulate()` computed its read range and advanced the shared offset *after* two awaits, so a foreground poll overlapping the unawaited 365-day scan left the offset ahead of the bytes actually digested — and everything later written into that gap was skipped permanently, since the truncation self-heal never fires once the file grows past it. The read position is captured before the awaits and the write is now a max, so a duplicated read is harmless.
- **A workflow's name went unread when its script was filed under a different project directory.** A session whose cwd differs when it launches a workflow persists the script under *that* project's dir while its agents stay under the session's own — one session id, two directories. Both of this machine's own workflows hit it and rendered as bare `wf_` ids.

## [0.27.33] — 2026-07-29

### Fixed
- **Every reported token figure was 2.4x-3.2x too high.** `digest()` summed `message.usage` once per JSONL record, but Claude Code writes ONE assistant response as several records — thinking, tool_use, text — and each carries an identical copy of the same usage block, because the usage describes the *message*, not the record. Measured on four large real transcripts: 43.8M fresh tokens reported against 13.9M actually billed (3.15x), 56.1M against 19.7M (2.84x), 77.7M against 32.8M (2.36x). Usage is now counted once per `message.id`. This is exact rather than a heuristic: across **7,276 message ids appearing more than once, not one carried differing usage**. The id is claimed only *after* the usage check — a message's leading records (a thinking block) carry no usage at all, and claiming the id on one of those made it swallow the id so the record holding the real numbers was skipped, reporting zero. Dedupe state lives on the accumulator, not the chunk, because the transcript is read in appended slices and copies of one message routinely land in different reads.

## [0.27.32] — 2026-07-29

### Added
- **A teammate reports the full session id of its team lead (`teamLeadSession`).** `teamName` carries only `session-<8hex>`, so a teammate's parent had to be resolved by matching those eight characters against whatever sessions happened to be listed — a guess that silently fails when the parent is outside the activity window, and that would nest under the wrong session entirely if two shared a prefix. Claude Code records the answer: `~/.claude/teams/<team>/config.json` holds `leadSessionId`, the parent's full uuid. **19 of 19 teams on this machine carry it.** Reported as-is; a team with no config on disk reports no lead rather than a guessed one.

## [0.27.31] — 2026-07-29

### Added
- **A workflow reports what it is FOR, not only its name (`workflowDescription`).** Read from `meta.description` in the script the Workflow tool persists — which that tool requires to be a pure literal, so it needs no evaluation. Scoped to the `meta` block deliberately: workflow scripts routinely define JSON schemas whose properties carry their own `description:` keys, and an unscoped match would return one of those as the run's purpose. Cached per script path, which never changes once written. Per-agent labels are deliberately NOT reported: they exist only in the process running the workflow (absent from every transcript, and the journal keys on a content hash), so any mapping would be a guess.

### Fixed
- **0.27.30 shipped with mismatched version manifests.** `package.json` was bumped without `plugin.json`, `marketplace.json`, or a rebuild of the committed `plugin/dist/` bundle — so the plugin manifests and the bundle still declared 0.27.29 while the release called itself 0.27.30. This repo has guards for exactly that (`tests/unit/plugin-manifest.test.ts`) and they caught it; the bump had simply been made after the last full run. All four now move together.

## [0.27.30] — 2026-07-29

### Added
- **Agent sessions now report a name instead of a bare hex id.** `/sessions/usage` returned agents as `agent-a3bfc79ec25585f22` — eight characters that say nothing about what is spending 250k tokens. The name already existed: when an agent is dispatched, the parent transcript records the operator's description (`"QA 35-point review"`) against the agent's id, at **spawn** time (`status: async_launched`), minutes before the agent finishes — so it is available while the agent is still running, which is the only time it is useful. Rows now carry `agentName`. It costs no extra I/O: the parent transcript is already read on the same poll for its token counts, so the map is harvested during that pass. On this machine the dispatch record covers 663 of 682 agent transcripts.
- **A workflow's fan-out is named by the workflow that ran it (`workflowName`).** Workflow agents are dispatched by the Workflow tool rather than the Agent tool, so no dispatch record exists for them — their parent transcript does not contain their id at all, the workflow journal keys on a content hash, and their own metadata says only `"agentType": "workflow-subagent"`. Seven of them ran as anonymous hex while burning roughly a million tokens between them. The run *is* named, in the script the Workflow tool persists as `workflows/scripts/<name>-<wf id>.js`; that filename is now matched on the exact workflow id, so two runs under one session can never inherit each other's name. A workflow with no persisted script leaves the agent unnamed rather than borrowing a sibling's.

## [0.27.29] — 2026-07-28

### Fixed
- **macOS: the worker could not start at all — SQLite has no extension support.** Apple ships `libsqlite3` built with `SQLITE_OMIT_LOAD_EXTENSION` and Bun links against the system library, so `sqlite-vec` died with *"This build of sqlite3 does not support dynamic extension loading"* on the first vector open. launchd then relaunched it faithfully, forever, so the agent looked healthy while the worker never came up. Bun is now pointed at a Homebrew SQLite via `Database.setCustomSQLite()` before the first connection is opened (it is process-global and ignored afterwards), and the error, if it still occurs, carries the remedy — `brew install sqlite` — instead of naming `sqlite-vec`'s internals. Pre-flight probes for it too, so the wizard says so before the crash loop rather than after.
- **The "worker unreachable" message named a file that does not exist.** `top` hardcoded `~/.captain-memo/logs/worker.log`: the wrong directory on macOS (the LaunchAgent wrote to `~/Library/Logs`), the wrong filename everywhere (the daemon writes `captain-memo-worker.log`), and the wrong mechanism on Linux, where systemd sends output to the journal and no such file is ever created. It now names the real location per platform — and the LaunchAgent writes to `LOGS_DIR` like every other platform, so there is one log directory and one message rather than two of each.
- **`uninstall` reported "No Captain Memo install detected" on macOS.** It looked only for systemd units. It now finds LaunchAgents, and removes them with `launchctl bootout` before deleting the plist — a plain file delete leaves the job running until logout.

## [0.27.28] — 2026-07-28

### Fixed
- **The macOS install aborted with `spawnSync launchctl ETIMEDOUT`.** Three launches were stacked into one throttle window: `bootstrap` starts the job via `RunAtLoad`, `install()` then ran `kickstart`, and the caller ran `restart()` on top. launchd refuses to respawn a job more than once per `ThrottleInterval` (ours is 10 s, which is launchd's floor) and `kickstart` **blocks** while throttled — against a spawn timeout that was also 10 s. The plist installed correctly; only the redundant third launch timed out. `install()` no longer kickstarts when `RunAtLoad` already started the job, the caller no longer restarts on top, the launchctl timeout is 90 s, and a timeout is now checked against the job's real state before it is called a failure — a stopwatch is not evidence. A test pins the timeout at ≥3× the plist's throttle interval so the collision cannot come back.
- **`install()` now verifies the agent is actually running** before reporting success, instead of treating `bootstrap` as proof. A plist that loads but whose program cannot exec reports here, with the `launchctl print` command and the log path to look at.

### Added
- **`AssociatedBundleIdentifiers` in the LaunchAgent plists.** macOS names a background item in *Login Items & Extensions* after the code-signing identity of the program it runs — for us that is `bun`, so users were told "software by Jarred Sumner can run in the background", which is accurate and useless to someone who installed Captain Memo. This is Apple's hook for re-attributing the job. Honest limit: it fully re-labels the entry only when a bundle with that identifier is installed and signed by the same team, so without a signed Captain Memo bundle macOS may still fall back to Bun's signature.

## [0.27.27] — 2026-07-28

### Added
- **macOS support: the worker now runs as a launchd LaunchAgent.** A third `ServiceManager` implementation alongside systemd and Windows Scheduled Tasks, writing `~/Library/LaunchAgents/com.captainmemo.worker.plist` and driving it with the modern `launchctl` verbs (`bootstrap` / `bootout` / `kickstart`), scoped to the user's GUI domain so nothing needs root. The interface was designed for this and no command needed changing — only the factory. Where launchd differs from systemd, deliberately: `stop` is `bootout` rather than `launchctl stop`, because with `KeepAlive` set the latter is undone within seconds; `restart` is `kickstart -k`, one atomic job, so a caller dying mid-way cannot strand the worker stopped; and there is no `EnvironmentFile=` equivalent because none is needed — the worker calls `loadWorkerEnv()` itself at startup, the same arrangement Windows uses.

### Fixed
- **The installer reported success for commands that never ran.** `installWorkerService()` fired `daemon-reload`, `enable` and `restart` and checked none of their exit codes, printing "worker service enabled + started" unconditionally. On macOS all three failed with ENOENT and it still printed the green tick — *after* its own pre-flight had reported `systemctl not found`. Reported from the field 2026-07-28. Each call is now checked, and a failure says what failed. An installer that lies about what it did is worse than one that refuses to run.
- **`getent` was assumed to exist.** It is a glibc tool; macOS has no usable one, so `getent passwd $USER` returned empty and the wizard resolved every derived path against `""`. Replaced at all four call sites with one `homeOf()` helper that shells out to nothing for the case that actually occurs — the current user — and falls back to `dscl` on macOS or `getent` on Linux only when resolving a *different* user (the sudo case). Diagnosed by the reporter, who also supplied a fix for the first of the four sites.
- **Pre-flight and closing hints named the wrong tools for the platform.** It probed `systemctl` on a Mac, then recommended `journalctl` and `loginctl`, none of which exist there. It now probes the supervisor that will actually be used and points at `~/Library/Logs/captain-memo/`.

## [0.27.26] — 2026-07-28

### Added
- **`stats` now reports token spend**, window and all-time, with cache reads stated as excluded. The panel could say what memory costs to *store* but nothing about what the work costs to *run*, while `allTimeTotals()` sat in the tree with no callers. The two figures are separate lines on purpose: they differ by three orders of magnitude, and one unlabelled number invites reading a lifetime total as a rate. Cache reads bill at roughly a tenth of input and on a real corpus are 95%+ of the raw count, so folding them in produces a headline dominated by the cheapest tokens.
- **Sessions report the name they were started under.** `claude --resume <name>` records it as `agentName`/`customTitle`, so a UI can show `CPT-TOP` rather than `f9b5463d` — eight hex characters distinguish nothing when a dozen sessions share one project. The hub bridge id each bridged session carries is reported alongside. Deliberately NOT interpreted as evidence of parentage: the name is just a name and the bridge id is on every bridged session, so reading either as "this is a sub-task agent" mislabels an operator's own named session.

## [0.27.25] — 2026-07-28

### Added
- **Token usage is now windowed for real, not approximated.** Each session keeps per-minute buckets keyed off the ISO timestamp Claude Code writes on every record, so "the last 30 minutes" means tokens whose messages were *written* in those 30 minutes. Previously a window could only select *which* sessions to include while each contributed its whole lifetime — two individually reasonable halves whose product means nothing. A long-lived session writing one message would rejoin the window and drag days of accumulation with it. History is pruned past 24h, bounding memory at 1 440 buckets per session.
- **All-time totals across every transcript on disk**, computed in the background behind a 5-minute TTL (~19 s cold over 1 479 transcripts, 253 ms warm). Reports `null` until the first scan completes, so a cold start shows "computing…" instead of a small wrong number that later jumps.
- **A displacement proxy (`src/eval/displacement.ts`)** comparing discovery-tool use (Read/Grep/Glob) in turns that received an injection against turns that did not — **with the permutation test built into the report, not bolted on after**. Memory's *cost* is directly measurable; its *saving* requires a counterfactual that leaves no trace, so any single "saved: N" figure is invented. The first real run showed a 13% reduction at **p = 0.38** — noise, and reported as noise. Turns are split on real prompts only: the API returns tool results with role `"user"`, so a naive split counted ~10 tool round-trips as 10 turns and flattened both arms toward zero.

## [0.27.24] — 2026-07-27

### Added
- **The `[m]` token-flow tab now labels each session with its project**, read from the transcript's own `cwd`. This is the only *reliable* label available: a tmux session name cannot be joined to a session id from outside the process — the CLI does not hold its transcript open, several panes routinely share one cwd, `--resume` makes a transcript predate its process so start-time correlation fails, and `CLAUDE_CODE_SESSION_ID` is **inherited** by child processes (three panes here all reported the same id). The transcript's `cwd` is self-reported by the session itself, so it is exact. Sessions running in other terminals were always in this tab — each carries its own session id — they are now identifiable at a glance.

## [0.27.23] — 2026-07-27

### Added
- **Memory's cost is now measurable, per corpus and per session.** `injected_tokens` is recorded on every auto-injection and aggregated into `stats` (`Injected 12.9 k tok · 23 injections · ~562 avg   since 27 Jul`), with the new `GET /sessions/usage` breaking it out per session. The "since" travels with every total on purpose: the field only began being written in this release, so the figure is not all-time and a bare number would overstate it.
- **`top` gained an `[m]` tab: live per-session token flow — native sessions included.** A session started by hand talks straight to the provider, so nothing on this machine meters it. But it writes a transcript, and every assistant message in it carries the **provider's own** `usage` block — the numbers were on disk all along. The join is free because the transcript filename **is** the `session_id`, the same id the recall audit records each injection against. `cache-read` is shown dim and separate rather than folded into an input total: it is the same context re-sent each turn, so a share measured against it compares a one-time write against N re-reads of itself.
- **`Max pair age gap` on every dreaming dry-run**, plus a warning naming the exact `--tau-days` fix when `--since` is wider than that ceiling.

### Fixed
- **The snippet cap was silently overriding the token budget.** Injection advertised 4 000 tokens and spent a mean of **736** across 89 real injections — 18%. Not relevance running out: a fixed 600-character slice was applied per hit *before* the envelope, and `formatEnvelope` already enforces the budget and truncates proportionally. So the pre-filter was quietly acting as the enforcer and the two numbers had never been reconciled. The cap is now derived from the budget, floored at the old 600 so a small budget can never make recall worse than before. Same queries after the change: 1 254 and 1 521 tokens, still 5 hits — the remaining gap is content, which is the correct place for the limit to live.
- **The dry-run reported signal weights it could not prove**, and **an age ceiling the code denied having** — see 0.27.22.

## [0.27.22] — 2026-07-27

### Fixed
- **The dry-run reported signal weights it could not prove.** `orchestrate.ts` hardcoded `temporal: 0.3 / 0.8, coRetrieval: 0.5 / 0.8` for the report while `weightedSimilarity` renormalized `DEFAULT_WEIGHTS` internally — two hand-maintained copies of one calculation, so tuning the weights would have left the report confidently describing the old ones with no test to catch it. Both now derive from a single exported `effectiveWeights()`. The duplication also produced the visible symptom: `0.3 / 0.8` evaluates to `0.37499999999999994`, so `toFixed(2)` printed `0.37` for a weight that is exactly `0.375`. Weights now print at 3dp — they are exact eighths, and anyone verifying a cluster by hand starts here.
- **A hard ceiling on pair age that the code denied having.** `distance.ts` claimed cross-month pairs still cluster "unless the co-retrieval signal carries them". They don't, and it can't: requiring `0.625·coRet + 0.375·e^(−Δt/τ) ≥ 1 − eps` caps Δt at `−7·ln(0.025/0.375) ≈ 18.96 days` even at a **perfect** co-retrieval score of 1.0. So `--since 30d` could not cluster across its own window however strong the evidence, and nothing said so.

### Added
- **`Max pair age gap` on every dry-run**, computed by the new `maxBridgeableGapDays()`. No default was changed — the shipped pairing is coherent (a 14d window under a 19d ceiling), so re-clustering everyone's corpus to fix a problem that does not occur out of the box would have been the wrong trade. The run simply stops being silent about a limit it was already enforcing.
- **A warning when `--since` is wider than that ceiling**, naming the exact fix: `Use --tau-days 12`. `tauDaysForWindow()` reads the per-day constant off `maxBridgeableGapDays` at τ=1d rather than restating the logarithm, so the advice cannot drift from the limit it advises about.
- **Where the name "dreaming" comes from**, in `README.md` and `docs/GLOSSARY.md`. Anthropic shipped [Dreams](https://platform.claude.com/docs/en/managed-agents/dreams) in Claude Managed Agents in May 2026: a pass that reads an agent's memory store alongside its past session transcripts and emits a reorganised store, leaving the input intact. Their split is the one worth borrowing — memory captures what an agent learns *as it works*, dreaming refines it *between sessions*. Ours differs in where it runs and what it reads: local SQLite files, grouped by co-retrieval rather than by a model re-reading transcripts. Deliberately not repeated: several third-party write-ups attribute a REM-sleep metaphor and a "Harvey 6×" figure to Anthropic; neither appears in Anthropic's own doc or blog.

## [0.27.21] — 2026-07-27

### Changed
- **The dashboard uses the width it always had.** Measured at a 160-column panel: 69 rows with **5 873 unused cells — 85 blank columns per row, 53% of the panel** — because only a few blocks were laid out in columns and the rest hugged the left margin. `Tide │ Dream` and the status block now pair side by side when the panel affords it, each pair with its own minimum width so a block is never squeezed below its natural size — below the threshold it stacks exactly as before. **69 rows → 50.** `Embedder` deliberately keeps a full-width row of its own: with the 0.27.20 queue tail it reaches ~101 columns and a half-panel would wrap it.
- **Percentages dropped the repeated `of corpus`.** It appeared on four separate lines (Recall Surfaced/Recalled, Tide Strengthened, Dream Co-retrieval) and the section heading already establishes the denominator. `(10.5% of corpus)` → `(10.5%)`. This is also what takes Tide's widest row from 81 columns to 71, which is what lets it pair inside a 145-column panel instead of needing 165.
- **AI sources moved to the foot of the panel.** It has a dedicated `top` tab (`[a]`), so it is the right section to lose first when a short terminal clips the frame.

### Fixed
- **`top` no longer scrolls its own header off the screen.** The render loop wrote every frame line from `HOME` with no clip to `dims.rows`. The alt-screen buffer scrolls *gracefully*, so a panel taller than the terminal silently pushed the wordmark off the top and you saw the **bottom** of the dashboard with no indication anything was missing — and any change in row count moved everything on screen, which is what made an appearing queue row read as "the whole screen shifts". `clipFrame()` now pins the two header rows and the hint bar and drops from the bottom of the body; a frame that already fits is returned untouched.

### Added
- **A description of Local Dreaming** in `README.md` and `docs/GLOSSARY.md` — what the offline pass does, why it clusters on co-retrieval rather than embedding similarity, and an explicit note that `--dry-run` is the only path shipped. The glossary's `Dream` section now says outright that it lists the pipeline's **inputs**, not its output.

## [0.27.20] — 2026-07-27

### Changed
- **The observation backlog rides on the `Embedder` line instead of claiming a row of its own.** 0.27.18 added the `Queue  2 949 waiting · 20 in flight · 678 failed` row, pushed only when the queue is non-empty — which under `top` means the whole panel below it drops a line the moment work arrives and springs back when it drains. Since `top` re-renders the entire panel on every refresh, that read as the screen jumping. The counts now render as a tail on the `Embedder` row, so the status block is a fixed height whether or not there is a backlog: `Embedder  voyage-4-lite · https://api.voyageai.com/v1/embeddings   Queue 0 waiting · 6 in flight`. Same three counts, same colours, still silent when the queue is idle. Known ceiling: below roughly 110 columns the combined row can wrap when all three states are non-zero (the endpoint alone already overflows the 60-column default).

## [0.27.19] — 2026-07-26

### Fixed
- **Observations are no longer lost when the model leaves an interior quote unescaped.** Requeuing 675 dead-lettered rows surfaced repeated `failed to parse JSON: Expected '}'` / `Unterminated string`. Replaying a failing batch against the live API disproved both obvious theories: `stop_reason=end_turn` and `output_tokens=307` of a 4096 budget rule out truncation, and the greedy extraction regex captured 929 of 941 characters correctly. The real cause is that the model escapes *some* interior quotes and not others — reliably so when the observation is **about punctuation**:
  `"...a straight ASCII double-quote (\") instead of the proper closing " (U+201D)..."` — first escaped, second bare. Content-dependent and deterministic, so all three retries fail identically and the row dead-letters.
  `repairJsonQuotes()` now makes a second parse attempt: a JSON string can only end where the next non-space character is `,` `:` `}` `]` or EOF, so every other `"` inside a string is provably a literal and can be escaped without a second API call or model cooperation. Verified against the verbatim reply that killed rows 41682/41683 — both now summarize on the first attempt with the Bulgarian quotes intact.
- **`max_tokens` truncation reports itself instead of masquerading as malformed JSON.** `stop_reason` was never inspected, so a response cut off at the token limit produced `Unterminated string` — indistinguishable from the model emitting junk, and the two need opposite fixes (raise the budget vs. fix the prompt). The transport now surfaces `stop_reason` and `summarize()` raises an explicit truncation error before attempting a parse.
- **`claude-oauth` honours the caller's `max_tokens`.** It hardcoded `4096` and silently discarded every `args.max_tokens` the transport contract passes (`Summarizer` 800, `mergeBody` 1200, `fillFrontmatter` 400), so no caller could control its own truncation point. Now `max(1024, args.max_tokens)` — floored because the observation schema does not fit in the smaller asks.

### Changed
- Parse failures now include a length-capped echo of the model's actual reply. Diagnosing the above required replaying the payload against the API because the error threw the evidence away; `last_error` in `stats` now shows the offending text directly.
- The summarizer system prompt explicitly requires escaping interior double quotes, naming the punctuation-describing case that triggers the failure. Prompting alone proved insufficient (hence `repairJsonQuotes`), but it reduces how often the repair is needed.

## [0.27.18] — 2026-07-26

### Fixed
- **`remember` merge/frontmatter fills no longer 400 on the default provider.** `Summarizer.getTransport()` returned the *bare* transport, but three separate comments described it as "the model-fallback transport" — the chain actually lived inside `summarize()`, which that path never calls. `writeMemory` passes `model: ''` to mean "you pick"; `codex`/`agy` tolerated it (they guard on `args.model &&` and fall through to the account default) but `claude-oauth` (the default) and `claude-code` put the empty string on the wire, so every merge failed with `HTTP 400: model: String should have at least 1 character` and silently fell back to appending instead of merging. `getTransport()` now wraps a shared `runWithModelChain()`, and the `''` sentinel is documented on `SummarizerTransportArgs` so a bare transport can't be handed to a `''` caller again.

### Added
- **The observation backlog is visible in `stats` and `top`.** `queue_pending`/`queue_processing` were already in the `/stats` payload but rendered nowhere, and `queue_failed` was not exposed at all — so ~2 900 observations stalled behind a dead summarizer looked exactly like an idle system. Both surfaces render through `renderStats`, which now emits `Queue  1 642 waiting · 20 in flight · 678 failed` whenever there is anything to report (silent when idle).
- **The summarizer says *why* it stopped.** `/stats.summarizer` gains `cooldown_until_epoch`, `last_error` and `consecutive_failures`; the worker hoists the failure reason out of `processBatch` (where it was a local that died with the call) into `lastSummarizerError`. The status dot has three states instead of two — previously it was driven by `enabled`, which only means "a provider resolved at boot" and therefore stayed **green** through a 21-hour rate-limit outage. Now:
  `Summarizer ● claude-oauth · claude-haiku-4-5 · paused, retries in 2d 1h`
  `           ↳ reason: claude-oauth: HTTP 429: …rate_limit_error…`
  A fully clean cycle clears the reason; a batch that summarizes 19 of 20 keeps it.

## [0.27.17] — 2026-07-22

### Fixed
- **Glossary link now points to `/glossary.html`.** The site host (Cloudflare + origin) does no extensionless routing — `/glossary` returns 404 — so the `top` help and README now link to [captain-memo.ispcq.com/glossary.html](https://captain-memo.ispcq.com/glossary.html), the page that actually resolves. The full glossary is also committed as [`docs/GLOSSARY.md`](docs/GLOSSARY.md).

## [0.27.16] — 2026-07-22

### Added
- **`top` help now includes a stats glossary + a link to the full one.** The `?` help screen explains every dashboard term (Compression, Dedup, AI sources, Surfaced/Recalled, Drill-in rate, Tide/floor, Strengthened, Dream, …), and points to the full, detailed glossary at [captain-memo.ispcq.com/glossary.html](https://captain-memo.ispcq.com/glossary.html) — also committed as [`docs/GLOSSARY.md`](docs/GLOSSARY.md). Every definition is what the code actually computes. README `top` section updated with the `a` AI-sources tab and the glossary link.

## [0.27.15] — 2026-07-22

### Fixed
- **`/stats.summarizer.enabled` was always `true` — the summarizer-down surfacing (0.27.13) never fired.** `summarize` is `opts.summarize ?? null`, so it's `null` (never `undefined`) when no summarizer was built — but the field computed `summarize !== undefined`, and `null !== undefined` is `true`. So `doctor` reported the summarizer green even when it was completely off (no token → whole obs + capture pipeline dead), exactly the case 0.27.13 was meant to catch. Now `summarize != null`. `doctor` (and `capture status`) now correctly go red when the summarizer isn't running.
- **Corrected the claude-oauth token-storage note.** Verified against Claude Code's auth docs: on Windows the token is a plain JSON file at `%USERPROFILE%\.claude\.credentials.json` (NOT the Windows Credential Manager, as an old comment speculated). The file token expires ~24h and Claude Code does not auto-refresh it, so a long-running daemon should set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, ~1-year) in `worker.env` — now documented in the code.

## [0.27.14] — 2026-07-22

### Changed
- **`capture status` / `capture backfill` name the real cause when capture is off.** Both used to say "no cross-AI capture sources active" / "(none detected)" even when the actual reason was that the summarizer isn't running (capture is gated on it). They now read the worker's summarizer state and say "gated OFF — the summarizer is not running; run `captain-memo doctor`" instead — consistent with the `doctor` surfacing (0.27.13).

## [0.27.13] — 2026-07-22

### Fixed
- **`doctor` now surfaces a non-working summarizer** instead of hiding it. When the resolved summarizer provider has no usable credentials, the worker builds NO summarizer — which silently disables the ENTIRE observation pipeline (Claude Code AND cross-AI capture). That only ever went to `worker.log`, so `doctor` looked all-green while nothing was being distilled, and the capture line misleadingly read "on — no non-Claude tool sessions detected." `doctor` now reads the worker's live summarizer state (`/stats.summarizer.enabled`/`cooling_down`) and **fails loudly**: red when the summarizer isn't running (`claude-oauth`: no valid OAuth token found by the worker — run `claude login`, or set `CLAUDE_CODE_OAUTH_TOKEN` in `worker.env`) and red when it's built-but-failing (in error-backoff — most often an expired token → 401). The capture check now says "gated OFF — the summarizer is not running" in that case rather than blaming missing tool sessions.

## [0.27.12] — 2026-07-22

### Changed
- **Cross-AI capture logs the resolved path + availability of every source at boot.** Previously a source that resolved to the wrong directory (or whose home didn't resolve) failed *silently* — `doctor`/`stats` just said "no non-Claude tool sessions detected," with no way to see WHERE it looked. The worker now logs one line, e.g. `cross-AI capture armed (tick 60s): agy=watching[/home/u/.gemini/antigravity-cli/conversations] codex=absent[/home/u/.codex/sessions] …`, so a misresolved path is visible in `worker.log`. Added `describe()` to the `CaptureSource` contract.

## [0.27.11] — 2026-07-22

### Fixed
- **The capture-state SQLite handle is now closed on worker shutdown.** With capture armed on every boot (0.27.9), `CaptureState` opens `capture-state.db` at startup — but `stop()` never closed it (the handle was hoisted out of the capture block's scope). On Windows an open handle blocks the temp-dir cleanup (`EBUSY` — red CI), and in production it would hold a lock a `restart`/`vacuum` needs released. `stopResources()` now closes it alongside the other stores.

## [0.27.10] — 2026-07-22

### Fixed
- **`capture-state.db` is co-located with `observations.db`** instead of the module `DATA_DIR` constant. With capture now armed unconditionally (0.27.9), a worker started with custom store paths but a default `DATA_DIR` (a threaded writer that doesn't inherit a runtime-set `CAPTAIN_MEMO_DATA_DIR`; the test harness) would open its state file in the wrong directory — or fail to open it if that directory didn't exist. It now sits beside the stores it accompanies (in production both are `DATA_DIR`, so this is a no-op there). Prevents a latent split-brain where capture state and observations lived in different dirs.

## [0.27.9] — 2026-07-22

### Fixed
- **Cross-AI capture now picks up a tool used *after* the worker booted — no restart needed.** The capture source list was filtered by `available()` **once at boot**, so a captain that started before a tool's data dir existed (e.g. `~/.gemini/antigravity-cli/conversations` for agy) never captured that tool — and if *no* tool's data existed at boot, the capture tick wasn't even armed. Now every **enabled** source is armed and the driver re-checks availability **each tick** (it already seeds a per-source cutoff the first time a source appears, so pre-existing history is skipped, not bulk-ingested). `/stats.capture.sources` is refreshed each tick, so `doctor`/`stats` reflect a newly-appeared tool within one tick (≤60s). Regression test covers a source that becomes available on a later tick.

## [0.27.8] — 2026-07-22

### Fixed
- **agy capture no longer re-ingests the same session every ~60s** (duplicate-observation loop). The agy `CaptureSource` marker folded in the `-wal`/`-shm` mtime+size. But a readonly open of a WAL-mode SQLite db **creates/touches those sidecars** (verified: they don't exist until we open the db), so our own read bumped the marker → the next tick saw "changed & quiesced" → re-ingest → open → bump, on a loop with period = the quiesce window. The effect was one near-duplicate observation per minute from a single stale session (and a `/stats` cache invalidation every minute). The marker is now **content-derived** (`stepCount:maxIdx`, read through the WAL), which is stable across our own reads and moves only when agy actually appends a step. Only agy was affected — codex/gemini/kimi read append-only JSONL whose mtime/size change only on real new content. Regression test asserts the marker is stable across repeated `discover()` calls.

## [0.27.7] — 2026-07-21

### Performance
- **`/stats` recall/token queries indexed — ~1040ms → ~100ms.** The stale-while-revalidate cache (0.27.6) stopped *most* polls blocking, but the refresh still runs its DB reads **synchronously on the event loop**, so the poll that triggers a refresh stalled ~1s (and stalled every concurrent request with it). Measured, the cost was four un-indexed full scans: the recall aggregate (243ms), the surfaced/recalled candidate scans (191+169ms), the recently-surfaced scan (170ms), and the paired-token SUM (185ms). Added four indexes (migrations 17–20): a **covering partial** index on the recall score `(from_auto+from_search+from_drill)` (surfaced rows are only ~12% of the table), partial indexes on `from_drill>0` and `last_surfaced_at`, and a **covering** index on `(work_tokens, stored_tokens)`. The recall aggregate is also rewritten to sum over surfaced rows only (non-surfaced rows contribute 0), making it a covering index-only search. Each query dropped to single-digit ms; net `/stats` synchronous cost ~10×. (Supersedes the v15 note that these "aren't cheaply indexable".) Indexes build once on upgrade (~0.7s) and add ~8 MB.

## [0.27.6] — 2026-07-21

### Performance
- **`/stats` cache is now stale-while-revalidate.** Under the 0.27.4 cache, an idle `top` poll that landed after the TTL expired still blocked on the ~1s recompute (an occasional ~4s clock step). Now a cached snapshot is served **instantly**; a past-TTL poll returns the cached body and kicks the refresh into the **background**, so an idle poll never blocks. Only a *missing* cache (fresh boot, or just-invalidated by a write) computes synchronously — which is what keeps read-your-writes exact.

### Fixed
- **Generation guard closes a stale-count race the background refresh could widen.** A refresh reads its counts, then yields at `await getDreamStats`; if a write landed during that yield (nulling the cache), the resolving refresh would overwrite the null with its *pre-write* snapshot. The refresh now captures a generation counter at kickoff and only writes the cache if no invalidation happened meanwhile — so the cache never holds counts older than the last write. Also: a failed background refresh can no longer surface as an unhandled promise rejection.

## [0.27.5] — 2026-07-21

### Security
- **Clears a new `bun audit` advisory** (GHSA-4c8g-83qw-93j6, high): `@modelcontextprotocol/sdk › ajv › fast-uri <3.1.3` (host confusion via failed IDN canonicalization). Added `fast-uri: ^3.1.3` to `overrides` (resolves to 3.1.4). Lockfile + bundle rebuild only.

## [0.27.4] — 2026-07-21

### Fixed
- **`/stats` cache now preserves read-your-writes.** The 0.27.3 short-TTL cache could serve a stale snapshot — a retrieval bump or a newly-created observation wasn't reflected until the TTL expired (broke integration tests and would mislead `top`). The cache is now **invalidated on the mutations `/stats` reports**: retrieval bumps (`from_auto`/`search`/`drill`) and observation creation. Idle `top` polling still hits the cache; any state change serves fresh immediately. (Also fixes: the TTL being shorter than `top`'s 2s refresh meant every poll missed the cache and blocked on the ~1s recompute — now the default TTL (5000ms) exceeds top’s 2s refresh, so idle polls are cache hits.)

## [0.27.3] — 2026-07-21

### Performance
- **Short-TTL `/stats` cache with in-flight dedup.** `top` polls `/stats` every ~2s, and `/stats` is expensive (recall scans, dream digest, Tide counts). Under a busy worker a poll could land while the previous computation was still running, piling requests onto the engine. `/stats` now serves a cached snapshot for `CAPTAIN_MEMO_STATS_CACHE_MS` (default 1500 ms) and shares a single in-flight computation across concurrent requests — so `top`'s polling can no longer stack up on the engine. (Verified: `uptime_s` is frozen across rapid calls, i.e. served from cache.)

## [0.27.2] — 2026-07-21

### Security
- **Clears a new `bun audit` advisory** (GHSA-frvp-7c67-39w9, moderate): `@modelcontextprotocol/sdk` transitively pulled `@hono/node-server <2.0.5` (path traversal in `serve-static` on Windows via encoded backslash). Added `@hono/node-server: ^2.0.5` to `overrides`. Lockfile-only.

### Performance
- **Faster first `/stats` / `top` load.** The Dreams co-retrieval digest reads `recall-audit.jsonl` incrementally, but the *first* call after boot digested the whole file from offset 0 (~1.4s on an 18 MB log) on the request path. The worker now pre-warms that digest at boot (fire-and-forget), so the first `/stats` returns without the cold-digest stall. (Note: on a busy federation worker, periodic engine contention can still add latency — separate from this.)

## [0.27.1] — 2026-07-21

### Changed
- **AI sources chart folds legacy `(unclassified)` into `claude-code`.** Pre-capture observations carry no `origin_agent` (null), but Captain Memo was Claude-Code-only before cross-AI capture — so those *are* Claude Code. The chart now attributes them to `claude-code` instead of a large `(unclassified)` bucket.

### Performance
- **Indexed the hot `/stats` counts** (run every ~2s under `top`, previously full-table `SCAN`s on the whole observations table): `idx_obs_origin` makes the "AI sources" GROUP BY a covering-index scan; **partial** indexes `idx_obs_stability` (`stability_days IS NOT NULL`) and `idx_obs_anchored` (`is_anchored=1`) make the Tide `strengthened`/`anchored` counts index lookups (empty ⇒ instant when Tide is off), at near-zero write cost. Keeps `/stats` flat as the corpus grows. (The paired-token `SUM` and recall's computed `ORDER BY` read most rows and aren't cheaply indexable, so they remain scans.)

## [0.27.0] — 2026-07-21

### Added
- **"AI sources" chart — see observations per AI tool.** Now that codex/agy/gemini/kimi/opencode all feed observations, `captain-memo stats` gains an **AI sources** section: a horizontal bar chart of observation counts per originating AI (sorted, with counts + % of corpus; legacy pre-capture rows shown as `(unclassified)`). `top` gains a dedicated **Sources tab** (press **`a`**) showing the same chart full-width and live-refreshing, and the drill-in **detail view** now shows each observation's `source`. Backed by a new `/stats.observations.by_origin` breakdown (`obsStore.countByOrigin()`). Bars use the panel's cyan accent — the reserved gold/cyan/green provenance triad is untouched.

## [0.26.2] — 2026-07-21

### Security
- **Clears the `bun audit` CI advisory** (GHSA-v422-hmwv-36x6, low): `express` (via `@modelcontextprotocol/sdk`) transitively pulled `body-parser@2.2.2`, vulnerable to a DoS when an invalid `limit` silently disables size enforcement. Added a `body-parser: ^2.3.0` entry to the existing `overrides` block so every resolution uses the patched line. Lockfile-only; no code or behavior change. (The advisory was published upstream and had reddened CI since 0.25.2 — unrelated to any feature here.)

## [0.26.1] — 2026-07-21

### Fixed
- **agy sessions are now actually captured — the lingering-WAL trap.** The agy capture source skipped any conversation `.db` that had a `-wal` sibling, treating it as "session still live". But agy **never checkpoints its WAL on exit** — the `-wal`/`-shm` linger indefinitely (and the freshest transcript lives *in* the WAL), so agy sessions were **never** ingested by the normal tick. Fixed: `discover()` now gates on the freshest mtime across `.db`/`-wal`/`-shm` (the WAL is the real last-write) instead of requiring the WAL's absence, and folds the WAL's size/mtime into the dedup marker so a resumed session re-ingests. Extraction already read the WAL correctly (a readonly open applies it). Verified end-to-end on a live captain: a real agy session now produces an observation. (codex/gemini were unaffected and already worked.)

## [0.26.0] — 2026-07-21

### Added
- **Cross-AI observation capture — non-Claude tools now submit their own observations.** Until now only Claude Code fed the observation pipeline (via its plugin hooks); every other wired tool was recall-only. A new worker-side capture driver reads the per-session transcripts these tools persist to disk and enqueues them into the same summarize→embed→store pipeline, stamped with the right `origin_agent`. **Five sources ship on by default** (each activates only when its tool's session dir exists on the host):
  - **codex** — `~/.codex/sessions/**/rollout-*.jsonl` (JSONL)
  - **agy** (Antigravity CLI) — `~/.gemini/antigravity-cli/conversations/*.db` (SQLite; heuristic text extraction, since the payload is an undocumented protobuf)
  - **gemini** (Google Gemini CLI) — `~/.gemini/tmp/*/chats/session-*.json` (JSON)
  - **kimi** (MoonshotAI kimi-cli) — `~/.kimi/sessions/*/*/context.jsonl` (JSONL)
  - **opencode** — `~/.local/share/opencode/opencode.db` (SQLite `session`/`message`/`part`)
  - All live-verified against real sessions producing real observations. Sessions are aggregated **per user turn** (Claude-like granularity), deduped by a change marker, and a **first-run cutoff** means enabling capture never floods on pre-existing history. `origin_agent` gained `agy` and `kimi`.
- **`captain-memo capture <status|backfill>`** — `status` shows which sources are active and how many sessions each has ingested; `backfill` ingests pre-cutoff history on demand (`POST /capture/backfill`).
- **`doctor` + `config show` report capture** — doctor gains a `cross-AI capture` line (active sources from `/stats`); `config show` shows the tick interval and any opt-outs.

### Config
- `CAPTAIN_MEMO_CAPTURE_<CODEX|AGY|GEMINI|KIMI|OPENCODE>=0` to opt a source out; `CAPTAIN_MEMO_CAPTURE_<TOOL>_DIR` / `_OPENCODE_DB` to override a location; `CAPTAIN_MEMO_CAPTURE_TICK_MS` (default 60s) and `CAPTAIN_MEMO_CAPTURE_QUIESCE_MS` (default 60s) to tune cadence.

### Notes
- `cursor` / `vibe` / `vscode` persist transcripts too and are a documented next batch (build when there's a live install to test against). `jetbrains` keeps no local transcript (IDE-only) and is not capturable without an in-IDE plugin. Suite: 1147/1147.

## [0.25.2] — 2026-07-21

### Fixed
- **Embedding-dimension mismatch now has a real fix and honest guidance.** When the embedder returns N-dim vectors but the vector index was built at M dims (e.g. after switching to `voyage-4-lite` (1024) on a 2048 index), every write (`remember`) throws at `vector.add()` and **vector search silently falls back to keyword-only** — reads "work" while writes are dead. Three changes:
  - **`captain-memo reindex --redim <n>`** — one guarded command that rebuilds the index at a new dimension: stop worker → persist `CAPTAIN_MEMO_EMBEDDING_DIM=<n>` → drop the derived `embeddings.db` (never `observations.db`) → restart → re-embed everything from source. Replaces the error-prone "hand-edit env + hand-delete files" dance.
  - **`captain-memo doctor` gains an `embedding dim` check** — compares the embedder's measured dim against the index dim and **FAILs** with the exact remedy. The worker now reports both `embedder.dim` and `vector_store.dim` in `/stats`.
  - **The boot-time `DIM MISMATCH` message was actively misleading** — it said "set `CAPTAIN_MEMO_EMBEDDING_DIM` and restart", which does **not** fix an existing index (the vec0 table is locked to its original dimension). It now names the real symptom (keyword-only search) and points at `reindex --redim`.

## [0.25.1] — 2026-07-15

### Changed
- **You can't run two summarizers, and now the tooling says so** — a customer ran `captain-memo install` twice (codex, then agy) expecting both; only ever one is active. Three idiot-proofing fixes:
  - **The install wizard announces the swap.** Re-running with a different provider prints `summarizer changed: codex → agy (this REPLACES it — only one summarizer runs at a time)`. It was silently overwriting before.
  - **An unrecognized `CAPTAIN_MEMO_SUMMARIZER_PROVIDER` fails LOUD instead of silently falling back.** A combined value like `codex,agy`, or any typo, now logs the valid list and — special-cased — calls out "you set more than one provider … only ONE is supported". It still falls back to `claude-oauth`, but the log now says that fallback needs a Claude login, so a no-Claude box isn't silently dead. (Resolution extracted to a pure, unit-tested `resolveSummarizerProvider`.)
  - **`captain-memo stats` / `top` now show the active summarizer.** A new `Summarizer` line reports the RESOLVED provider (post-fallback — so a bad `codex,agy` shows as its real `claude-oauth` fallback, not the raw string), its model, and whether it's actually summarizing (`○ … (resolved, but NOT summarizing)` when the transport couldn't be built, e.g. `claude-oauth` with no login). `/stats` gained a `summarizer` field.
- Docs: USAGE gains a "pick exactly ONE" callout up front — install replaces (not adds), a combined value is invalid, and how to check which one is live.

### Notes
- Suite: 1125/1125.

## [0.25.0] — 2026-07-15

### Added
- **Opt-in autonomous self-update for git-clone installs (`CAPTAIN_MEMO_AUTO_UPDATE=1`).** A marketplace install already self-updates via Claude Code, but a local `git clone` install sat on old code until someone ran `git pull` + `captain-memo install`. With this flag, on session start Captain **fast-forwards the checkout to the newest stable `vX.Y.Z` tag on its own `origin`, runs `bun install`, restarts the worker, and shows a `⚓ Captain Memo auto-updated` banner** — then verifies the worker booted and **rolls back** if it didn't. Off by default (auto-pulling a developer's checkout should be a choice); no-op on a non-git / marketplace install. Throttled to one `git fetch` per 6h (`CAPTAIN_MEMO_AUTO_UPDATE_INTERVAL_MS`). The git mechanics are a moat-safe re-lift of the federation self-updater (which can't be shared directly — it lives under `src/worker/federation/`).

### Security
- **The feature was adversarially reviewed BEFORE release; two serious holes were found and fixed, so they never shipped:**
  - **Command-injection → RCE (git argument-injection).** The current branch name from `git rev-parse --abbrev-ref HEAD` flowed unsanitized into `git fetch … origin <branch>`; a repo whose HEAD is a branch named `--upload-pack=…` executed arbitrary code on an opted-in user's next session (reproduced end-to-end on git 2.47.3, and it fired *before* the clean-tree / ff-only gates). Fixed two ways: the branch positional is **dropped from the fetch entirely** (tag discovery doesn't need it), and any dash-leading branch/tag/sha is **refused** (`isSafeRefName`). Re-verified: a real dash-named-HEAD repo now bails before any git command runs.
  - **Origin invariant was not enforced.** Candidate tags came from `git tag --list` — the *entire* local tag namespace — so a contributor who added a fork remote could get a malicious `v99.0.0` fast-forwarded in, despite the "only from your own origin" promise. Now candidates are scoped to `git ls-remote --tags origin`, and `git fetch --tags --force` guarantees a name in that set resolves to origin's exact sha.
- Also hardened from the same review: **rollback** if the new code crash-loops (captures the prior HEAD sha, resets + reinstalls + restarts the old code); a **repo-identity gate** (only touch a checkout whose `package.json` name is `captain-memo`, so a marketplace install nested in an unrelated git repo can't mis-target it); a **concurrency lock** (only one session updates at a time); **`bun install` gets its own 300s budget** instead of the 20s `git fetch` cap (a half-written `node_modules` would crash the worker); **`GIT_TERMINAL_PROMPT=0` + ssh `BatchMode`** so an auth prompt can't stall session start; and suppression of a **redundant second worker restart**.

### Notes
- 20 dedicated unit tests (fake git port, no real git) cover every gate and the two exploits; the git path was also dry-run and the RCE reproduction re-run against the real repo. Suite: 1119/1119.

## [0.24.2] — 2026-07-15

### Fixed
- **`agy` summarizer was broken on Windows — two platform bugs, both now fixed.** The provider shipped in 0.24.0 assuming POSIX:
  - **Home isolation silently failed on Windows.** agy is a Go binary using `os.UserHomeDir()`, which reads `$HOME` on POSIX but `%USERPROFILE%` on Windows. The transport set only `HOME`, so on Windows agy ignored it, fell back to the real user profile, and would have **polluted the user's real `~/.gemini` history** (and grown it unbounded) — the exact thing the isolated home exists to prevent. Now sets **both** `HOME` and `USERPROFILE`.
  - **The OAuth token was symlinked, which throws `EPERM` on Windows.** `fs.symlinkSync` needs Administrator or Developer Mode on Windows, so every summarize would have crashed. The token is now **copied** on Windows (and re-copied when the real token is newer, so a re-login still propagates), while POSIX keeps the symlink (token refresh flows through the real home for free).
  - Home setup is now fail-safe: a missing token or a placement failure no longer throws — agy surfaces its own auth error on spawn, which is the better signal, and never crashes the worker.
  - New unit tests exercise the Windows branch (copy-not-symlink, re-copy-on-newer, POSIX-symlink, missing-token-no-throw) via injectable `isWindows`/`tokenSource`, so they run on the POSIX CI. Linux behavior re-verified live: real `~/.gemini` conversation count stays at delta 0. Suite: 1099/1099.

### Note
- This only affects `CAPTAIN_MEMO_SUMMARIZER_PROVIDER=agy` on Windows. `claude-oauth` (recommended on Windows) and `codex` were never affected.

## [0.24.1] — 2026-07-15

### Security
- **Pinned `qs` and `hono` past their advisories via `overrides` — `bun audit` goes from 10 findings (1 high, 9 moderate) to zero.** Both arrive transitively through `@modelcontextprotocol/sdk` (`sdk › express › body-parser › qs`, `sdk › @hono/node-server › hono`). The high was GHSA-88fw-hqm2-52qc: hono's CORS middleware reflecting any Origin with credentials when `origin` defaults to the wildcard.
  - **Reachability, checked before fixing rather than assumed: neither package is ever loaded.** captain-memo imports exactly two SDK entrypoints — `server/stdio.js` and `server/webStandardStreamableHttp.js` — and *neither* pulls in express or hono; the SDK's express-dependent code lives in `server/express.js` and `server/auth/*`, which we never import. The gateway is served by `Bun.serve`, and no file under `src/` or `bin/` references express, hono, or qs. So the advisories were not exploitable here.
  - Fixed anyway, because "unreachable today" is a property of current code, not a guarantee — a future HTTP/auth code path would have silently inherited a known-vulnerable CORS middleware. `overrides` makes it true regardless of what we import later.
  - Both bumps are semver-compatible (`qs` 6.15.1 → 6.15.3, `hono` 4.12.18 → 4.12.30); bumping the SDK itself would not have helped, as it is already at the latest (1.29.0) and still resolves the vulnerable ranges.
  - Suite: 1095/1095, typecheck clean.

## [0.24.0] — 2026-07-14

### Added
- **`agy` summarizer provider — a zero-key summarizer on a plain Google account.** `codex` (0.23.0) closed the gap for ChatGPT subscribers; this closes it for everyone else. `CAPTAIN_MEMO_SUMMARIZER_PROVIDER=agy` shells out to the Antigravity CLI (`agy -p`), authenticating off the Google OAuth token agy already stored. No Claude plan, no ChatGPT plan, no API key. Three of the six providers now need no key at all.
  - **Fastest of the three agent-CLI transports: ~3.4–5.5 s/call** on `Gemini 3.5 Flash (Low)`, the Flash/Haiku tier (measured; also the cheapest). Still an agent-runtime boot rather than inference, and still on the background tick, so it never blocks a prompt.
  - Model names are the **display names** `agy models` prints (`Gemini 3.5 Flash (Low)`), not slugs. An unrecognised value exits 1 and lists the valid ones — a typo fails loudly. The fallback chain still ends at the `default` sentinel (= pass no `--model`).
  - **Runs under an isolated `$HOME` (`<DATA_DIR>/agy-home`), and this is not optional.** `agy` has no `--ephemeral` equivalent and no home-override env var — it derives everything from `$HOME`, and *every* run persists a conversation (measured: **~364 KB and 3 conversation entries per single call**). Unmanaged, a summarizer on the prompt-window tick would grow `~/.gemini` without bound **and poison the user's `agy --continue` history** — their next `agy -c` would resume a *summarizer* conversation instead of their own work. So captain-memo points `$HOME` at a private dir with the real OAuth token **symlinked** in (a symlink, so re-login stays in sync) and prunes its own conversations after each call. Verified: the user's real `~/.gemini` conversation count stays at delta 0.
  - Always passes `--sandbox`; the summarizer must never execute model-authored commands (session tool-logs are semi-untrusted input).
  - **Requires agy ≥ 1.1.1.** Two upstream fixes there are non-negotiable for subprocess use: 1.1.1 fixed `agy -p` **hanging when run inside a subprocess** (it read stdin — a hang would strand `processBatch`'s in-flight guard and silently halt the observation queue), and fixed print mode exiting 0 with empty output on a server-side failure, which is otherwise indistinguishable from success.

### Notes
- **Argument order in the agy transport is load-bearing and is enforced by a test.** `--print`/`-p` is a *string* flag whose value IS the prompt — it is not a boolean. `agy -p --model "<m>" "<prompt>"` makes `-p` swallow the literal string `"--model"`; agy then answers *"I am running on Gemini 3.5 Flash"*, silently discards the real prompt, and **exits 0**. It does not fail — it succeeds against the wrong input. The correct form is `agy --sandbox --model "<m>" -p "<prompt>"`, with the prompt always the final element. `summarizer-agy.test.ts` asserts this so nobody can "tidy" the flags and reintroduce it.
- Suite: 1095/1095. moat-guard green (master carries no federation code).

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
