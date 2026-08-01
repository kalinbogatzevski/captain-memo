# Configuration reference

Every setting Captain Memo reads from the environment, what it defaults to, and when you would
change it.

## Read this first: you need none of these

Captain Memo ships with working defaults for all 138 settings. A fresh install indexes, recalls,
summarises, dedupes and decays without a single line in `worker.env`.

This document exists for the operator who wants to *change* something, not for the operator who
has to configure something before the product works. If you find yourself needing an env var to
get normal behaviour, that is a bug in our defaults, not a gap in your reading. Report it.

The corollary: **do not copy settings out of this file into `worker.env` "to be explicit."** A
pinned value is a value that stops tracking our defaults when we improve them. Several settings
below were opt-in for months and reached almost nobody; the fix was to change the default, and
installs that had pinned the old value did not benefit. Set only what you are deliberately
overriding.

## Where configuration lives

| Location | Purpose |
|---|---|
| `~/.config/captain-memo/worker.env` | The operator file. `KEY=value` per line, `#` comments. Read by the worker at startup. |
| Process environment | Anything exported before launching the worker or CLI wins the same way. |
| `~/.captain-memo/` | Data, not config: the SQLite databases, vectors, and audit log. Move it with `CAPTAIN_MEMO_DATA_DIR`. |

Changes take effect on worker restart:

```bash
captain-memo restart && captain-memo status
```

Booleans are strings. `1`/`true` enable, `0` disables. Read the polarity carefully: some settings
are ON unless you write `0`, others are OFF unless you write `1`. Numeric values that fail to
parse fall back to the default rather than becoming `NaN`.

## The kill switches

Everything that can be turned off, in one place. This is the table to reach for when something
misbehaves and you want it to stop.

| Setting | Turns off | Default |
|---|---|---|
| `CAPTAIN_MEMO_QM_ENABLED=0` | All Quartermaster housekeeping (dedup + supersede + semantic) | ON |
| `CAPTAIN_MEMO_QM_DEDUP=0` | Near-duplicate folding only | ON |
| `CAPTAIN_MEMO_QM_SUPERSEDE=0` | Stale-version demotion only | ON |
| `CAPTAIN_MEMO_QM_SEMANTIC=0` | Idle-time semantic consolidation only | ON |
| `CAPTAIN_MEMO_TIDE_ENABLED=0` | Decay re-ranking; back to flat recency | ON |
| `CAPTAIN_MEMO_TIDE_TIERING=0` | Lifecycle transitions (active → dormant → archived) | ON |
| `CAPTAIN_MEMO_RECALL_AUDIT=0` | The recall audit log that feeds dream stats | ON |
| `CAPTAIN_MEMO_BRANCH_BOOST=0` | Ranking preference for the current git branch | ON |
| `CAPTAIN_MEMO_IDENTIFIER_BOOST=0` | Ranking boost for code identifiers in the query | ON |
| `CAPTAIN_MEMO_RARE_TOKEN_BOOST=0` | Ranking boost for rare tokens | ON |
| `CAPTAIN_MEMO_WORKNOTE_SEMANTIC=0` | Semantic matching for work-note collision detection | ON |
| `CAPTAIN_MEMO_CAPTURE_CODEX=0` | Capturing Codex sessions (same for `_AGY`, `_GEMINI`, `_KIMI`, `_OPENCODE`) | ON |
| `CAPTAIN_MEMO_SKIP_EMBED=1` | Embedding entirely (keyword search only) | OFF |
| `CAPTAIN_MEMO_DISABLE_SELF_HEAL=1` | The session-start hook's self-repair | OFF |

Note the asymmetry in the last two rows: most switches are *off-by-writing-zero*, but
`SKIP_EMBED` and `DISABLE_SELF_HEAL` are named negatively, so they are *on-by-writing-one*.

## Common tasks

### Move the data directory

```bash
CAPTAIN_MEMO_DATA_DIR=/mnt/big/captain-memo
```

Everything lives under it: `observations.db`, `queue.db`, `pending_embed.db`, vectors, and
`recall-audit.jsonl`. Stop the worker, move the directory, set the var, start the worker.

### Run two independent corpora on one machine

Give each worker its own port, data directory and project id:

```bash
CAPTAIN_MEMO_WORKER_PORT=39889
CAPTAIN_MEMO_DATA_DIR=/home/me/.captain-memo-experiment
CAPTAIN_MEMO_PROJECT_ID=experiment
```

They will not contend: each worker owns its own SQLite files.

### Use a different embedding provider

```bash
CAPTAIN_MEMO_EMBEDDER_ENDPOINT=https://api.voyageai.com/v1/embeddings
CAPTAIN_MEMO_EMBEDDER_MODEL=voyage-4-lite
CAPTAIN_MEMO_EMBEDDER_API_KEY=...
CAPTAIN_MEMO_EMBEDDING_DIM=1024
```

`CAPTAIN_MEMO_EMBEDDING_DIM` **must** match what the model returns. Changing it on a populated
corpus requires a reindex (`captain-memo reindex --redim <n>`); the vectors already stored are
the old width.

### Make the memory envelope quieter or louder

```bash
CAPTAIN_MEMO_SHOW_SAVINGS_PERCENT=0   # hide the "saved N%" line
CAPTAIN_MEMO_SHOW_WORK_TOKENS=1       # show raw work tokens
CAPTAIN_MEMO_SHOW_READ_TOKENS=1       # show raw read tokens
CAPTAIN_MEMO_SHOW_SAVINGS_AMOUNT=1    # show an absolute figure
```

### Give hooks more time on a slow machine

```bash
CAPTAIN_MEMO_HOOK_TIMEOUT_MS=4000
CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS=8000
```

Hooks fail open: a timeout costs you the injection for that turn, never the turn itself.

### Make housekeeping more or less aggressive

```bash
CAPTAIN_MEMO_QM_DEDUP_WINDOW=10000    # look at more rows per sweep (costs CPU, quadratic)
CAPTAIN_MEMO_QM_DEDUP_COSINE=0.97     # fold only closer matches
CAPTAIN_MEMO_QM_DEDUP_INTERVAL_MS=1800000  # sweep every 30 minutes instead of hourly
```

The window is quadratic per project/branch partition. Measured on a 14,409-row surfaced set:
500 rows cost 37 ms, 5,000 cost 401 ms, and the whole set cost 3,076 ms. Raising it past ~10,000
starts to stall the worker's heartbeat, because candidate grouping runs synchronously before the
sweep's first yield.

### Slow down or speed up forgetting

```bash
CAPTAIN_MEMO_TIDE_AGE_FLOOR_DAYS=180   # nothing goes dormant before six months
CAPTAIN_MEMO_TIDE_EBB_THRESHOLD=0.2    # sink only the very cold
```

Nothing is deleted. A dormant row leaves the auto-injection envelope, stays fully searchable, and
one recall re-floats it. Rows that were ever drilled into, or explicitly anchored, never sink.

---

## Full reference

### Core paths and identity

| Setting | Default | Notes |
|---|---|---|
| `CAPTAIN_MEMO_DATA_DIR` | `~/.captain-memo` | Databases, vectors, audit log. |
| `CAPTAIN_MEMO_CONFIG_DIR` | `~/.config/captain-memo` | Where `worker.env` is read from. |
| `CAPTAIN_MEMO_PROJECT_ID` | `default` | Namespaces the corpus. |
| `CAPTAIN_MEMO_REMEMBER_DIR` | `~/.claude/memory` | Where curated memories are written. |
| `CAPTAIN_MEMO_TRANSCRIPTS_DIR` | `~/.claude/projects` | Where native session transcripts are read. |
| `CAPTAIN_MEMO_WATCH_MEMORY` | unset | Glob of markdown files to index as the memory channel. |
| `CAPTAIN_MEMO_WATCH_SKILLS` | unset | Glob of skill files to index as the skill channel. |

### Worker runtime

| Setting | Default | Notes |
|---|---|---|
| `CAPTAIN_MEMO_WORKER_PORT` | `39888` | HTTP API port. |
| `CAPTAIN_MEMO_GATEWAY_PORT` | see `gateway.ts` | Port for the remote-access gateway. |
| `CAPTAIN_MEMO_WORKER_THREADED` | OFF | `1` runs the engine on a worker thread. |
| `CAPTAIN_MEMO_READER_POOL_SIZE` | `2` | Read replicas, clamped to 0-8. |
| `CAPTAIN_MEMO_READER_ACQUIRE_MS` | `REQUEST_DEADLINE_MS - 500` | Wait for a free reader. |
| `CAPTAIN_MEMO_ENGINE_REQUEST_MS` | `10000` | Per-request deadline. |
| `CAPTAIN_MEMO_ENGINE_STARTUP_MS` | `15000` | Grace period before the engine is called unhealthy. |
| `CAPTAIN_MEMO_REINDEX_MS` | `1800000` | Deadline for long write operations. |
| `CAPTAIN_MEMO_STATS_CACHE_MS` | `5000` | How long `/stats` is cached. |
| `CAPTAIN_MEMO_QUEUE_RETENTION_DAYS` | `30` | Age at which processed queue rows are swept. |
| `CAPTAIN_MEMO_AUTO_UPDATE` | OFF | `1` lets the session-start hook self-update. |
| `CAPTAIN_MEMO_AUTO_UPDATE_INTERVAL_MS` | `21600000` (6h) | Minimum gap between update checks. |
| `CAPTAIN_MEMO_DISABLE_SELF_HEAL` | OFF | `1` stops the hook repairing a broken install. |
| `CAPTAIN_MEMO_ENABLE_TEST_ENDPOINTS` | OFF | `1` exposes `/test/*`. Never set in production. |

### Embedder (client side)

| Setting | Default | Notes |
|---|---|---|
| `CAPTAIN_MEMO_EMBEDDER` | unset | Provider name used by `captain-memo install`. |
| `CAPTAIN_MEMO_EMBEDDER_ENDPOINT` | `http://localhost:8124/v1/embeddings` | The local Python service by default. |
| `CAPTAIN_MEMO_EMBEDDER_MODEL` | `voyageai/voyage-4-nano` | |
| `CAPTAIN_MEMO_EMBEDDER_API_KEY` | unset | Required by hosted providers. |
| `CAPTAIN_MEMO_EMBEDDER_API_FORMAT` | `openai` | Request shape. |
| `CAPTAIN_MEMO_EMBEDDER_PROVIDER` | unset | Recorded in backups so a restore knows the source. |
| `CAPTAIN_MEMO_EMBEDDER_MAX_TOKENS` | provider-dependent | Truncation ceiling per input. |
| `CAPTAIN_MEMO_EMBEDDER_TIMEOUT_MS` | provider-dependent | |
| `CAPTAIN_MEMO_EMBEDDING_DIM` | `2048` | Must match the model. Changing it needs a reindex. |
| `CAPTAIN_MEMO_SKIP_EMBED` | OFF | `1` disables embedding; search degrades to keyword only. |
| `CAPTAIN_MEMO_OPENAI_ENDPOINT` | `http://127.0.0.1:11434/v1` | Used for local model discovery. |
| `CAPTAIN_MEMO_OPENAI_API_KEY` | unset | |
| `CAPTAIN_MEMO_VOYAGE_ENDPOINT` | falls back to `EMBEDDER_ENDPOINT` | Legacy name, honoured by the claude-mem migrator. |
| `CAPTAIN_MEMO_VOYAGE_MODEL` | falls back to `EMBEDDER_MODEL` | Legacy. |
| `CAPTAIN_MEMO_VOYAGE_API_KEY` | falls back to `EMBEDDER_API_KEY` | Legacy. |
| `CAPTAIN_MEMO_VOYAGE_API_FORMAT` | falls back to `EMBEDDER_API_FORMAT` | Legacy. |
| `CAPTAIN_MEMO_VOYAGE_TIMEOUT_MS` | falls back to `EMBEDDER_TIMEOUT_MS` | Legacy. |

### Embedder (local Python service)

Read by `services/embed/`, not by the worker. Set these where the service starts.

| Setting | Default | Notes |
|---|---|---|
| `CAPTAIN_MEMO_EMBED_MODEL` | `voyageai/voyage-4-nano` | |
| `CAPTAIN_MEMO_EMBED_DIM` | `2048` | Must agree with `CAPTAIN_MEMO_EMBEDDING_DIM`. |
| `CAPTAIN_MEMO_EMBED_DEVICE` | `cpu` | `cuda` / `mps` where available. |
| `CAPTAIN_MEMO_EMBED_MAX_SEQ_LEN` | `512` | Tokens per input. |
| `CAPTAIN_MEMO_EMBED_INFERENCE_BATCH_SIZE` | `8` | |
| `CAPTAIN_MEMO_EMBED_TORCH_THREADS` | `4` | |

### Summarizer

| Setting | Default | Notes |
|---|---|---|
| `CAPTAIN_MEMO_SUMMARIZER_PROVIDER` | `claude-oauth` | Uses your existing Claude login, no API key. |
| `CAPTAIN_MEMO_SUMMARIZER_MODEL` | `claude-haiku-4-5` | |
| `CAPTAIN_MEMO_SUMMARIZER_FALLBACKS` | `claude-haiku-4-6,haiku` | Tried in order when the primary fails. |
| `CAPTAIN_MEMO_SUMMARIZER_TIMEOUT_MS` | `60000` | |

### Hooks

| Setting | Default | Notes |
|---|---|---|
| `CAPTAIN_MEMO_HOOK_TIMEOUT_MS` | `1500` | General hook budget. |
| `CAPTAIN_MEMO_HOOK_BUDGET_TOKENS` | `4000` | Ceiling on injected context per turn. |
| `CAPTAIN_MEMO_HOOK_DEBUG` | OFF | `1` logs hook decisions to stderr. |
| `CAPTAIN_MEMO_HOOK_EVENT` | unset | Set by the dispatcher; not an operator setting. |
| `CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS` | `1500` | |
| `CAPTAIN_MEMO_SESSION_START_WAIT_HEALTHY_MS` | `15000` | How long session-start waits for a starting worker. |
| `CAPTAIN_MEMO_PRE_TOOL_USE_TIMEOUT_MS` | `1500` | |
| `CAPTAIN_MEMO_POST_TOOL_USE_TIMEOUT_MS` | `1000` | |
| `CAPTAIN_MEMO_PRE_COMPACT_TIMEOUT_MS` | `5000` | Larger: compaction is the one hook worth waiting for. |

### Cross-AI capture

Each source is ON by default and auto-detects its directory. Set `_DIR` only for a non-standard
install path.

| Setting | Default | Notes |
|---|---|---|
| `CAPTAIN_MEMO_CAPTURE_CODEX` | ON | |
| `CAPTAIN_MEMO_CAPTURE_CODEX_DIR` | `~/.codex/sessions` | |
| `CAPTAIN_MEMO_CAPTURE_AGY` | ON | Antigravity CLI. |
| `CAPTAIN_MEMO_CAPTURE_AGY_DIR` | `~/.gemini/antigravity-cli/conversations` | |
| `CAPTAIN_MEMO_CAPTURE_GEMINI` | ON | |
| `CAPTAIN_MEMO_CAPTURE_GEMINI_DIR` | `~/.gemini/tmp` | |
| `CAPTAIN_MEMO_CAPTURE_KIMI` | ON | |
| `CAPTAIN_MEMO_CAPTURE_KIMI_DIR` | `~/.kimi/sessions` | Falls back to `KIMI_SHARE_DIR`. |
| `CAPTAIN_MEMO_CAPTURE_OPENCODE` | ON | |
| `CAPTAIN_MEMO_CAPTURE_OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | |
| `CAPTAIN_MEMO_CAPTURE_TICK_MS` | `60000` | How often sources are polled. |
| `CAPTAIN_MEMO_CAPTURE_QUIESCE_MS` | `60000` | How long a session must be idle before it is captured. |

### Observation processing

| Setting | Default | Notes |
|---|---|---|
| `CAPTAIN_MEMO_OBSERVATION_BATCH_SIZE` | `20` | Observations summarised per batch. |
| `CAPTAIN_MEMO_OBSERVATION_TICK_MS` | `5000` | Queue drain interval. |
| `CAPTAIN_MEMO_OBSERVATION_HALF_LIFE_DAYS` | `90` | Recency half-life in the legacy decay path. |
| `CAPTAIN_MEMO_REMEMBER_DEDUP_THRESHOLD` | `0.85` | Similarity above which a new curated memory is treated as a duplicate. |

### Search and ranking

Defaults shown are for the `v2` rank profile. `CAPTAIN_MEMO_RANK_PROFILE` selects the base set;
every value below can be overridden individually.

| Setting | Default (v2) | Notes |
|---|---|---|
| `CAPTAIN_MEMO_RANK_PROFILE` | `v2` | Named bundle of the values below. |
| `CAPTAIN_MEMO_FUSION_MODE` | profile | How vector and keyword results are combined. |
| `CAPTAIN_MEMO_RRF_K` | `60` | Reciprocal-rank-fusion constant. |
| `CAPTAIN_MEMO_PER_STRATEGY_TOP_K` | `25` | Candidates pulled per strategy before fusion. |
| `CAPTAIN_MEMO_VECTOR_WEIGHT` | `0.7` | |
| `CAPTAIN_MEMO_KEYWORD_WEIGHT` | `0.3` | |
| `CAPTAIN_MEMO_RELEVANCE_FLOOR` | profile | Minimum score to be returned at all. |
| `CAPTAIN_MEMO_TEMPORAL_INTENT` | profile | Detect "last week"-style queries. |
| `CAPTAIN_MEMO_TEMPORAL_HALF_LIFE_DAYS` | profile | |
| `CAPTAIN_MEMO_TEMPORAL_TOP_N` | profile | |
| `CAPTAIN_MEMO_TEMPORAL_FLOOR` | profile | |
| `CAPTAIN_MEMO_BRANCH_BOOST` | ON | Prefer results from the current git branch. |
| `CAPTAIN_MEMO_IDENTIFIER_BOOST` | ON | Boost exact code identifiers. |
| `CAPTAIN_MEMO_PROPER_NOUN_BOOST` | profile | |
| `CAPTAIN_MEMO_PROPER_NOUN_BOOST_WEIGHT` | profile | |
| `CAPTAIN_MEMO_RARE_TOKEN_BOOST` | ON | Only active when proper-noun boost is on. |
| `CAPTAIN_MEMO_SUPERSEDE_PENALTY` | profile | Score multiplier applied to a superseded row. |

### Tide (decay and lifecycle)

| Setting | Default | Notes |
|---|---|---|
| `CAPTAIN_MEMO_TIDE_ENABLED` | ON | `0` reverts to flat recency decay. |
| `CAPTAIN_MEMO_TIDE_TIERING` | ON | `0` keeps every row `active` forever. |
| `CAPTAIN_MEMO_TIDE_RELEVANCE_FLOOR` | `0.30` | The decay multiplier never drops below this. |
| `CAPTAIN_MEMO_TIDE_W20` | `0.15` | FSRS power-law shape constant. |
| `CAPTAIN_MEMO_TIDE_S0_OBSERVATION_DAYS` | `7` | Starting stability for observations. |
| `CAPTAIN_MEMO_TIDE_S0_MEMORY_DAYS` | `60` | Curated memory starts more durable. |
| `CAPTAIN_MEMO_TIDE_S0_SKILL_DAYS` | `180` | Skills more durable still. |
| `CAPTAIN_MEMO_TIDE_SRC_AUTO` | `0.5` | Strengthening weight for auto-injection. |
| `CAPTAIN_MEMO_TIDE_SRC_SEARCH` | `1.0` | For an explicit search hit. |
| `CAPTAIN_MEMO_TIDE_SRC_DRILL` | `1.5` | For a deliberate drill-down. |
| `CAPTAIN_MEMO_TIDE_STAB_GAIN` | `0.5` | Base gain per recall. |
| `CAPTAIN_MEMO_TIDE_STAB_CAP_DAYS` | `365` | Saturation knob, not a hard cap: `fS = cap / (cap + S)`. Hot rows plateau slowly rather than stopping. |
| `CAPTAIN_MEMO_TIDE_EBB_THRESHOLD` | `0.30` | Buoyancy below which a row may go dormant. |
| `CAPTAIN_MEMO_TIDE_SURFACE_THRESHOLD` | `0.70` | Buoyancy above which a recall re-floats a row. |
| `CAPTAIN_MEMO_TIDE_ARCHIVE_THRESHOLD` | `0.05` | Dormant → archived. |
| `CAPTAIN_MEMO_TIDE_AGE_FLOOR_DAYS` | `90` | Nothing goes dormant younger than this. |
| `CAPTAIN_MEMO_TIDE_ARCHIVE_AGE_DAYS` | `180` | Nothing is archived younger than this. |
| `CAPTAIN_MEMO_TIDE_SWEEP_BATCH` | `256` | Rows reconsidered per sweep. |
| `CAPTAIN_MEMO_TIDE_SWEEP_MS` | `60000` | Sweep interval. |

Anchored rows, and any row ever drilled into, are permanently exempt from ebbing.

### Quartermaster (dedup and supersede)

| Setting | Default | Notes |
|---|---|---|
| `CAPTAIN_MEMO_QM_ENABLED` | ON | Master switch for both passes. |
| `CAPTAIN_MEMO_QM_DEDUP` | ON | Folds near-duplicates into a survivor. Archives, never deletes. |
| `CAPTAIN_MEMO_QM_DEDUP_TITLE` | `0.5` | Jaccard title similarity to become a candidate. |
| `CAPTAIN_MEMO_QM_DEDUP_COSINE` | `0.95` | Embedding confirm before folding. Measured, not guessed: identical-title pairs score median 0.947, max 0.990. |
| `CAPTAIN_MEMO_QM_DEDUP_WINDOW` | `5000` | Most-recently-surfaced rows examined per sweep. Quadratic per partition. |
| `CAPTAIN_MEMO_QM_DEDUP_INTERVAL_MS` | `3600000` (1h) | Also paces the supersede sweep. |
| `CAPTAIN_MEMO_QM_SLICE_MS` | `150` | Budget for one housekeeping chunk. |
| `CAPTAIN_MEMO_QM_SEMANTIC` | ON | Idle-time semantic consolidation: cosine as the FINDER, for same-session pairs. |
| `CAPTAIN_MEMO_QM_SEMANTIC_COSINE` | `0.95` | Cosine at or above which two same-session observations are one event. |
| `CAPTAIN_MEMO_QM_SEMANTIC_MIN_IDLE_S` | `1800` (30 min) | Quiet time required before a pass may start. |
| `CAPTAIN_MEMO_QM_SEMANTIC_CHECK_MS` | `600000` (10 min) | How often idleness is *checked* (the pass itself is rare). |
| `CAPTAIN_MEMO_QM_SEMANTIC_MAX_GROUPS` | `200` | Cap on groups emitted per pass. |
| `CAPTAIN_MEMO_QM_SUPERSEDE` | ON | Demotes an older version-fact when a newer one exists. |
| `CAPTAIN_MEMO_QM_SUPERSEDE_COSINE` | `0.93` | Lower than dedup's on purpose: supersede applies a reversible 0.5x demotion, dedup archives. |

The semantic pass is the one that runs only when the machine is idle: no ingest, no queued
observations, no live co-session, and nothing surfaced or written for `MIN_IDLE_S`. It is a
whole-corpus scan (~50 s measured on 124k rows) and competes for CPU, so a busy machine simply
defers it. It exists because title-gated dedup could never see a fact restated in different
words: on a live corpus, **zero** semantically-similar pairs reached the cosine confirm at any
threshold, because the title gate filtered them all first. Restricted to same-session pairs,
where 83% of high-cosine pairs live and "one event described twice" is near-definitional.

Both passes yield between groups and abort mid-slice when ingest arrives, so neither starves the
worker. `captain-memo dedup --undo` and `captain-memo supersede undo` reverse their effects.

### Promotion

| Setting | Default | Notes |
|---|---|---|
| `CAPTAIN_MEMO_PROMOTE_ENABLE` | OFF | `1` lets a judge pass promote durable observations into curated memory. |
| `CAPTAIN_MEMO_PROMOTE_INTERVAL_MS` | `21600000` (6h) | |
| `CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN` | `5` | |

### Envelope display

| Setting | Default | Notes |
|---|---|---|
| `CAPTAIN_MEMO_SHOW_SAVINGS_PERCENT` | ON | |
| `CAPTAIN_MEMO_SHOW_SAVINGS_AMOUNT` | OFF | |
| `CAPTAIN_MEMO_SHOW_WORK_TOKENS` | OFF | |
| `CAPTAIN_MEMO_SHOW_READ_TOKENS` | OFF | |

### Work notes

| Setting | Default | Notes |
|---|---|---|
| `CAPTAIN_MEMO_WORKNOTE_SEMANTIC` | ON | Semantic overlap detection between work claims. |
| `CAPTAIN_MEMO_WORKNOTE_SEMANTIC_THRESHOLD` | `0.80` | Similarity above which two claims are treated as colliding. |

### Diagnostics and development

| Setting | Default | Notes |
|---|---|---|
| `CAPTAIN_MEMO_RECALL_AUDIT` | ON | `0` disables the audit log that dream stats read. |
| `CAPTAIN_MEMO_RECALL_AUDIT_MAX_BYTES` | see `recall-audit.ts` | Rotation size. |
| `CAPTAIN_MEMO_EVAL_JUDGE_MODEL` | `claude-haiku-4-5-20251001` | Used by the eval harness only. |
| `CAPTAIN_MEMO_OPENCODE_LOCAL_PROVIDER` | unset | opencode integration. |
| `CAPTAIN_MEMO_OPENCODE_LOCAL_ENDPOINT` | unset | |
| `CAPTAIN_MEMO_OPENCODE_GATEWAY_ENDPOINT` | unset | |

---

## Checking what is actually in effect

`worker.env` is what you *wrote*; `/stats` is what the worker is *running*. When they disagree,
the worker is right and something did not restart.

```bash
captain-memo config          # resolved values the CLI sees
curl -s localhost:39888/stats | jq '{tide, qm, supersede}'
```

The `tide`, `qm` and `supersede` blocks each report their own enabled flag, thresholds and last
run, so you can confirm a pass is both switched on *and* actually sweeping.
