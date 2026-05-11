<p align="center">
  <img src="docs/logo.png" alt="Captain Memo — The Ship-Log for Your Digital World" width="320">
</p>

<h1 align="center">Captain Memo</h1>

<p align="center"><em>Your AI coding agent's logbook — local memory, kept in sync, retrieved on every prompt.</em></p>

<p align="center">
  Built by <a href="https://github.com/kalinbogatzevski">Kalin Bogatzevski</a> · <a href="LICENSE">Apache-2.0</a> · <a href="https://github.com/kalinbogatzevski/captain-memo/issues">Issues</a>
</p>

Captain Memo is a Claude Code plugin (and a self-contained local-memory layer for any AI coding agent that speaks the standard hook + MCP shapes). Every session leaves a wake; Captain Memo keeps the log so the next session sails with what was learned in the last one.

> **v0.1.0 "Europe Day" — Linux only.** The runtime is portable, but the installer assumes systemd. macOS and Windows support are planned for v0.2.0. Mac users wanting to try v0.1.0 today can run the worker manually under launchd / tmux / nohup; see [issue #1](https://github.com/kalinbogatzevski/captain-memo/issues/1).

---

## Why I built this

I run an ISP and built the ERP platform behind it. The same platform now runs at a friend's ISP in another country, and most of the code that keeps both deployments alive passes through Claude Code on its way to production. Billing fixes, NAS migrations, OLT integrations, GitLab tickets that drag on for weeks. The kind of work where the *context* is half the job.

Sometime in the last year, my AI pair-programmer became my most patient colleague. It would sit through a four-hour debugging arc with me, never tire, never lose the thread inside that session. But the moment a session ended, every hard-won realisation went with it. The next morning I'd open a new chat and re-explain why we *don't* round in the middle of a billing calculation, why bills on one tenant are trigger-driven, why we never `clone $smy` in CLI smoke tests. The same lessons. Every. Single. Day.

I tried writing things down. The `~/.claude/memory/` folder filled up — feedback rules, project notes, references, observations from incidents. Hundreds of small markdown files, each a hard-earned scrap of judgment. Then [`claude-mem`](https://github.com/thedotmack/claude-mem) came along and made some of that searchable, and for months it was my colleague's memory. It helped me a lot. Without it, Captain Memo wouldn't exist — because I wouldn't have known what shape the problem really had.

Eventually I started noticing the gaps for the way *I* work: small English-only embeddings, opinionated retention, one cloud LLM. My Bulgarian-and-English notes returned no hits on the Bulgarian half. Some retrievals felt random on a corpus this size. None of that takes away from how useful claude-mem still is — it just turned out my work needed something a little different.

So I sat down to build that "something different" for myself, and ended up with something I think other people might want too.

---

## What it is

- **Local-first.** Vector store and metadata live on your machine — `sqlite-vec` + SQLite WAL. No cloud database, no per-call billing for retrieval, no network round-trips on the hot path.
- **Hybrid search.** Voyage embeddings (default) + SQLite FTS5 keyword index, fused via Reciprocal Rank Fusion with exponential recency decay on observations. Multilingual (BG/EN/etc.) — your non-English memory is searchable too.
- **Four summarizer providers**, picked at install time:
  - `claude-oauth` *(default)* — direct Anthropic API using the OAuth token Claude Code already stored. No API key. ~700 ms/call. Just works on a Max plan.
  - `anthropic` — direct Anthropic SDK with `ANTHROPIC_API_KEY` (paid)
  - `claude-code` — `claude -p` subprocess (slower; for users without OAuth file access)
  - `openai-compatible` — Ollama / LM Studio / vLLM / OpenAI / OpenRouter / DeepSeek / Groq / Together / Mistral / etc.
- **Four embedder backends**, picked at install time:
  - `voyage-hosted` *(default)* — Voyage API (`voyage-4-lite`, 1024-dim). Free signup, ~$0.30/year typical use, fast on any hardware.
  - `local-sidecar` — `voyageai/voyage-4-nano` open weights via a self-contained FastAPI sidecar (offline, private, 2048-dim, needs AVX2)
  - `openai-compatible` — Any `/v1/embeddings` endpoint (Ollama, OpenAI, OpenRouter, etc.)
  - `skip` — keyword-only retrieval (FTS5 only, no vectors)
- **Auto-injected context.** A `<memory-context>` envelope is added to every user prompt by the `UserPromptSubmit` hook. The model sees relevant memory, skills, and prior session observations before it answers.
- **Session observations.** Every tool use is captured fire-and-forget; on `Stop`, batched events are summarized into structured observations (type / title / facts / concepts) and indexed into the same hybrid search. Future sessions can recall them.
- **Indefinite retention.** No 30-day cleanups. A project takes years; your memory should too.

---

## Requirements

**Always required:**

| Component | Minimum | Notes |
|---|---|---|
| OS | Linux (systemd) | macOS / Windows port not yet implemented |
| Bun | ≥ 1.1.14 | https://bun.com |
| Disk | ~50 MB | The corpus itself + worker code; grows ~1 MB per few hundred chunks |
| Sudo | **not required** | The default install runs entirely as your user. Sudo only needed for `--system` (multi-user / always-on server). |

**Plus, depending on the embedder you pick:**

| If you choose | Extra requirement | Approx footprint |
|---|---|---|
| **Hosted Voyage API** *(recommended)* | Free API key from [dash.voyageai.com](https://dash.voyageai.com), outbound HTTPS | ~$0.30/year typical use, no install bloat |
| **Local voyage-4-nano sidecar** | Python 3.11+, **AVX2 CPU**, 8 GB RAM, ~6 GB disk | Self-contained but heavy; bring patience for first-time pip install + model download |
| **Other OpenAI-compatible endpoint** (Ollama, OpenAI, OpenRouter) | Whatever your endpoint requires | Depends on backend |

**And, depending on the summarizer you pick:**

| If you choose | Extra requirement |
|---|---|
| **Claude Max via OAuth** *(recommended)* | A Claude Max subscription + `claude login` already done. No API key. |
| **Anthropic API** | `ANTHROPIC_API_KEY=sk-ant-…` (paid per token) |
| **Claude Code subprocess** | `claude` CLI on PATH; uses Max plan but adds 5–15 s per call vs OAuth |
| **OpenAI / Ollama / OpenRouter** | Endpoint URL + optional API key |

The install wizard runs **pre-flight checks** before touching anything — it tells you exactly which requirement is unmet and how to fix it. If your CPU can't run the local embedder, the wizard recommends a hosted backend instead.

## Install — pick a path

All paths lead to the same plugin loaded into Claude Code. The wizard asks which embedder + summarizer to use, then sets everything up.

```bash
git clone https://github.com/kalinbogatzevski/captain-memo
cd captain-memo
bun install
./bin/captain-memo install
```

The wizard asks ~5 questions and sets up:
- **Worker daemon** at `~/.config/systemd/user/captain-memo-worker.service` (port 39888)
- **Plugin registration** via `claude plugin marketplace add` + `claude plugin install` — your hooks, MCP server, and slash commands all auto-register
- **Config** at `~/.config/captain-memo/worker.env`
- **Embedder sidecar** at `~/.captain-memo/embed/` *(only if you pick the local backend)*

After the wizard, **fully restart Claude Code** (quit the `claude` process, not just the session) for the plugin to load.

### What the wizard asks you

**Question 1 — Summarizer** (compresses tool-use events into observation chunks):

| Pick | When |
|---|---|
| **Claude Max via OAuth** *(recommended)* | You have a Claude Max subscription. Free, fast (~700 ms/call), no API key — Captain Memo reads the OAuth token Claude Code already stored. |
| Anthropic API | You want explicit per-token billing or don't have Max. |
| Claude Code subprocess | OAuth not available; falls back to spawning `claude -p` per call (slower). |
| OpenAI / Ollama / OpenRouter | You're routing to a different model fleet. |
| Skip | Events queue but don't summarize (rare; you keep raw events for later). |

**Question 2 — Embedder** (turns text into vectors for semantic search):

| Pick | When |
|---|---|
| **Hosted Voyage API** *(recommended)* | Best for most users. Fast on any hardware, ~$0.30/year typical use, free signup at [dash.voyageai.com](https://dash.voyageai.com). 1024-dim. |
| Local voyage-4-nano sidecar | You want offline / fully-private inference. Needs AVX2 CPU + 6 GB Python install. 2048-dim. |
| External /v1/embeddings | Self-hosted (Ollama, vLLM, llama.cpp), or another hosted provider. |
| Skip | Keyword-only retrieval (FTS5, no vectors). Search quality drops a lot. |

If you pick Voyage hosted and don't have your API key handy, leave it blank — the wizard writes a placeholder and tells you which line of `worker.env` to edit later.

### System-wide install (headless servers, multi-user)

For headless boxes, multi-user dev servers, or "always-on regardless of who's logged in":

```bash
sudo ./bin/captain-memo install --system
```

Installs to `/opt/captain-memo-embed/` + `/etc/systemd/system/` + `/etc/captain-memo/` instead of `$HOME`. Same wizard, same result, just at system scope. Survives any user logout.

### Plugin-only install (advanced, no local worker)

If you already have a Captain Memo worker running on another box and just want THIS Claude Code install to talk to it:

```bash
claude plugin marketplace add github.com/kalinbogatzevski/captain-memo
claude plugin install captain-memo@captain-memo
```

You'll need to set `CAPTAIN_MEMO_WORKER_BASE` in your environment to point at the remote worker's `:39888`. This is a power-user setup; most people should run the wizard.

### Other lifecycle commands

```bash
captain-memo doctor              # health check across all components
captain-memo uninstall           # clean removal (--purge for data too)
captain-memo uninstall --system  # for the system-mode install
```

---

## Inside Claude Code

After install + a full Claude Code restart, the plugin exposes two layers to every session:

### 5 slash commands you can type directly

```
/captain-memo:search <query>      # hybrid search across memory + skills + observations, top 5 hits
/captain-memo:recall <doc_id>     # full content of a hit (use the doc_id from a search result)
/captain-memo:observations        # recent captured session observations (--limit N optional)
/captain-memo:stats               # corpus stats inline in chat
/captain-memo:doctor              # health probe inline in chat
```

### 8 MCP tools the model calls automatically

These fire when the model decides retrieval would help your prompt — no slash command required. List them anytime with `/mcp`:

| Tool | Purpose |
|---|---|
| `search_all` | Hybrid search across all channels |
| `search_memory` | Curated memory only (filter: type, project) |
| `search_skill` | Skill bodies only (filter: skill_id) |
| `search_observations` | Past session observations (filter: type, files, since) |
| `get_full` | Full content of a hit by `doc_id` |
| `reindex` | Trigger re-embed |
| `stats` | Corpus stats |
| `status` | Worker health |

## CLI commands (any terminal)

```bash
captain-memo status              # is the worker reachable?
captain-memo stats               # corpus stats by channel + indexing progress
captain-memo reindex             # cheap sha-diff reindex (or --force to re-embed)
captain-memo observation list    # recent captured observations
captain-memo observation flush   # force-drain the queue
captain-memo config show         # effective config (secrets masked)
captain-memo doctor              # component health probe
captain-memo install             # interactive install wizard
captain-memo uninstall           # clean removal
captain-memo inspect-claude-mem        # read-only row counts of ~/.claude-mem/
captain-memo migrate-from-claude-mem   # one-time migration (--dry-run for preview)
```

`status` and `stats` accept `--json` for machine-readable output — handy for statuslines, dashboards, monitoring probes.

## Recipes

- **[Statusline integration](docs/statusline-integration.md)** — surface worker health, observation count, disk usage, and indexing progress in your Claude Code status bar. Cached for sub-millisecond reads; uses the `--json` output from `stats` / `status`.

### Token-savings badges

Each captured observation records how many tokens the summarizer spent producing it (`work_tokens = input + output`). When the `<memory-context>` envelope is built, a per-hit savings badge shows how much was compressed compared to injecting the raw session events. By default only the percentage is shown; the absolute amounts are opt-in so the envelope stays concise.

| Env var | Default | Shows |
|---|---|---|
| `CAPTAIN_MEMO_SHOW_SAVINGS_PERCENT` | `1` (on) | `saved X%` |
| `CAPTAIN_MEMO_SHOW_SAVINGS_AMOUNT` | `0` (off) | `N tokens saved` |
| `CAPTAIN_MEMO_SHOW_WORK_TOKENS` | `0` (off) | `work N` |
| `CAPTAIN_MEMO_SHOW_READ_TOKENS` | `0` (off) | `recall N` |

Set any flag to `0` to hide it, or `1` to show it. When all four are `0` no badge line is emitted. Observations captured before v0.1.6, and those migrated from claude-mem without a `discovery_tokens` record, silently skip the badge (`work_tokens = NULL`). Migrated observations that _do_ have a `discovery_tokens` value inherit it as `work_tokens` so the badge renders for historical data too.

### Recall audit log

Disabled by default. Enable with `CAPTAIN_MEMO_RECALL_AUDIT=1` in your `worker.env` to start recording retrieved hits and boost provenance to `${CAPTAIN_MEMO_DATA_DIR:-~/.captain-memo}/recall-audit.jsonl` (one JSON line per search). Each line records the timestamp, session and project IDs, the query, and for every returned hit: the chunk ID, channel, score, a 200-character snippet, and which of the identifier-match or same-branch boosts fired and with what multiplier. Useful for tuning the search boosts against real prompts. The file is append-only; rotate manually if needed.

## Migrating from claude-mem

If you've been using [`claude-mem`](https://github.com/thedotmack/claude-mem) and want to bring your existing observations and session summaries into Captain Memo, the migration is one command. Your claude-mem install stays intact — Captain Memo only **reads** from `~/.claude-mem/claude-mem.db`, never modifies it.

```bash
# Preview what would migrate (no writes)
captain-memo migrate-from-claude-mem --dry-run

# Run the actual migration
captain-memo migrate-from-claude-mem

# Flags:
#   --dry-run             preview only, no writes
#   --limit N             cap at N observations (useful for testing)
#   --from-id <obs_id>    resume from a specific observation
```

While running, you'll see a live progress bar (`⠋ obs ████████░░░░░░░░ 5,234/13,440 (39%)  10.2/s  ETA 13m 22s`) and, on completion, a side-by-side comparison of the source claude-mem DB vs your new Captain Memo data dir — disk size, row counts, channel breakdown, observed date range.

The migration is **idempotent** (re-runs skip already-migrated rows via a progress table) and **resumable** (interrupt + resume via `--from-id`). Both claude-mem and Captain Memo can coexist running side-by-side after migration.

---

## Schema upgrades

Each SQLite database owned by the worker (`observations.db`, `queue.db`, etc.) maintains its own `schema_versions` table. Stores declare their changes as an ordered migration list; on every worker startup the runner applies any that are not yet recorded.

You never need to run manual `ALTER TABLE` commands. For installs that already have columns from an earlier release (before v0.1.7), the runner recognises the "duplicate column" error as idempotent recovery and marks the migration applied without re-running.

Run `captain-memo doctor` to see which migrations have been applied per database:

```
Schema migrations:
  observations.db:      2/2 applied
    [1] add_branch      (2026-05-11T...)
    [2] add_work_tokens (2026-05-11T...)
  observation_queue.db: 1/1 applied
    [1] add_last_error  (2026-05-11T...)
```

---

## What's inside

| Component | What it does |
|---|---|
| **Worker** (`:39888`) | Long-lived HTTP daemon. Owns the SQLite + sqlite-vec stores, file watcher, observation queue, summarizer + embedder wiring. |
| **Embedder** | Pluggable: hosted Voyage API (default), local voyage-4-nano sidecar (`:8124`), or any OpenAI-compatible `/v1/embeddings` endpoint. |
| **Summarizer** | Pluggable: Claude Max via OAuth (default, no API key), Anthropic API, `claude -p` subprocess, or any OpenAI-compatible `/v1/chat/completions`. |
| **MCP server** (stdio) | Exposes 8 tools to Claude Code (`search_all`, `search_memory`, `search_skill`, `search_observations`, `get_full`, `reindex`, `stats`, `status`). |
| **Four hooks** | `SessionStart` (corpus banner), `UserPromptSubmit` (inject memory envelope, ≤1.5 s budget), `PostToolUse` (queue tool-use events), `Stop` (drain → summarize → index). |
| **CLI** | The commands above. |

Channels indexed: `memory` (curated user memory files), `skill` (Claude Code skill bodies, section-level), `observation` (summarized session events). Observations get an exponential recency decay at search time (90-day half-life by default) so newer truth ranks above stale truth without losing history.

Detailed docs: [`docs/USAGE.md`](docs/USAGE.md).

---

## Status

| Plan | Scope | State |
|---|---|---|
| 1 | Worker, MCP server, CLI, hybrid search, file watcher, ingest pipeline | Shipped |
| 2 | Hooks + observation pipeline + 4-provider summarizer + 4-provider embedder | Shipped |
| 3 — Layer A | claude-mem migration (`inspect-claude-mem`, `migrate-from-claude-mem`) | Shipped |
| 3 — Layer B | OAuth-direct summarizer (no API key needed) · recency decay · install wizard fast-path defaults | Shipped |
| 3 — Layers C-G | MEMORY.md transformation · federation client · optimize/purge/forget · retrieval-quality eval · doctor enhancements | Drafted in [`docs/plans/`](docs/plans/) |

172 tests pass. Typecheck clean. Bun ≥ 1.1.14, TypeScript strict.

---

## Why "Captain Memo"

The captain keeps the ship's log. Every voyage gets entered. When the ship sails again, the captain remembers what happened on the last one — the storms, the trade winds, the islands that turned out to have fresh water. That's what this plugin does for your AI coding sessions.

The metaphor extends throughout the codebase: memory files = logbook entries, observations = voyage logs, the file watcher = lookout in the crow's nest, federation (Plan 3) = sister ships exchanging signals, claude-mem migration = transferring the old ship's log.

(There's a tiny in-joke in the name too. *cap**TAI**n* — the AI was always there, hiding in plain sight.)

---

## Open source, because

The people most likely to benefit are people working the way I work — alone or in small teams, on real systems, in languages other than English, with budgets that don't include a per-call billing line. The same shape of problem keeps showing up: *my AI forgets between sessions and I'm tired of re-saying the same things*. If you've felt that, this is the tool I wish I'd had a year earlier.

Apache 2.0-licensed. Run it locally, point it at any LLM you have, and tell it nothing it doesn't need to know. Captain Memo logs the voyage; you stay the captain.

> By day I work on the commercial side — [**ISPCQ**](https://ispcq.com), the multi-tenant ERP platform Captain Memo's engineering DNA came from. Different product, same approach to careful, locally-sovereign software. If you run an ISP and want a turnkey ERP with the same care put into it, that's where to look.

## Contributing

Issues + PRs welcome. Plan 3's 35 tasks in [`docs/plans/`](docs/plans/) are good first contributions for the migration / federation / optimization layers.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

— Kalin
