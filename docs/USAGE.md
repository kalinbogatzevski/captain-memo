# captain-memo Plan-1 — Manual Usage (Foundation)

This is what's available after Plan 1 ships. Hooks (auto-injection) come in Plan 2; migration from claude-mem comes in Plan 3.

## Prerequisites

- Bun ≥ 1.1.14 installed.
- A reachable Voyage embeddings endpoint (default: `http://localhost:8124/v1/embeddings`, model `voyage-4-nano`). Local Voyage installation is out of scope for this plan — see project-level install notes.

The vector store is in-process via `sqlite-vec` (no separate Chroma daemon needed).

## Start the worker

```bash
bun run worker:start
```

Default port: `39888`. Override via env:

| Variable | Default | Meaning |
|---|---|---|
| `CAPTAIN_MEMO_WORKER_PORT` | `39888` | HTTP port for the long-lived worker. |
| `CAPTAIN_MEMO_PROJECT_ID` | `default` | Project namespace for the per-project vector collection. |
| `CAPTAIN_MEMO_VOYAGE_ENDPOINT` | `http://localhost:8124/v1/embeddings` | Voyage embeddings endpoint. |
| `CAPTAIN_MEMO_VOYAGE_MODEL` | `voyage-4-nano` | Model identifier passed to Voyage. |
| `CAPTAIN_MEMO_VOYAGE_API_KEY` | — | Optional bearer token for Voyage. |
| `CAPTAIN_MEMO_WATCH_MEMORY` | — | Comma-separated globs to watch for memory files (channel = `memory`). The sentinel **`auto`** expands to every installed assistant's memory location that exists on this machine (Claude, Codex, Gemini, Cursor, Copilot, repo `AGENTS.md`). Composes: `auto,/my/notes/*.md`. |
| `CAPTAIN_MEMO_WATCH_SKILLS` | — | Comma-separated globs to watch for skill files (channel = `skill`). |
| `CAPTAIN_MEMO_DATA_DIR` | `~/.captain-memo` | Where the meta SQLite + vector SQLite + logs live. |

> Plan-1 supports **one watch channel per worker process**. If both `CAPTAIN_MEMO_WATCH_MEMORY` and `CAPTAIN_MEMO_WATCH_SKILLS` are set, the worker uses memory and warns. Multi-channel watch is on the Plan-2 backlog.

## Use the CLI

```bash
captain-memo status                     # health check + total chunk count
captain-memo stats                      # corpus stats by channel
captain-memo reindex                    # cheap sha-diff reindex
captain-memo reindex --channel memory   # restrict to one channel
captain-memo reindex --force            # ignore sha cache, re-embed all
```

## Use the MCP server (manual)

The stdio MCP server connects to the worker over HTTP and exposes 8 tools to Claude Code.

```bash
bun run mcp:start
```

Expose to Claude Code via `.mcp.json`:

```json
{
  "mcpServers": {
    "captain-memo": {
      "type": "stdio",
      "command": "bun",
      "args": ["/absolute/path/to/captain-memo/src/mcp-server.ts"]
    }
  }
}
```

Tools exposed: `search_memory`, `search_skill`, `search_observations`, `search_all`, `get_full`, `reindex`, `stats`, `status`.

## Watch paths

Set the env vars `CAPTAIN_MEMO_WATCH_MEMORY` or `CAPTAIN_MEMO_WATCH_SKILLS` to comma-separated globs. Patterns are passed to Bun's native glob — typical forms like `~/.claude/memory/*.md` work after shell expansion (note: env-passed values won't expand `~`, so prefer absolute paths in env).

Example:

```bash
CAPTAIN_MEMO_WATCH_MEMORY="/home/me/.claude/memory/*.md" bun run worker:start
```

## What's NOT in Plan 1

- Auto-injection on user prompts (Plan 2)
- Session observation pipeline (Plan 2)
- Migration from claude-mem (Plan 3)
- Optimization / duplicate detection (Plan 3)
- Voyage install script (Plan 3)

---

# captain-memo Plan-2 — Hooks + Observation Pipeline

Plan 2 layers auto-injection hooks, the observation queue, and a configurable
Haiku-class summarizer on top of the Plan-1 foundation.

## Summarizer — pick a provider

> **Pick exactly ONE.** There is only ever a single active summarizer. Setting two — two `install` runs, or a combined `codex,agy` value — does **not** run both:
> - **`captain-memo install --summarizer <x>` REPLACES the previous choice** (it doesn't add). Running it for `codex` and then `agy` leaves you on `agy` only; the wizard prints `summarizer changed: codex → agy (replaces it)` so you can see the swap.
> - **A combined value like `codex,agy` is invalid** — the worker won't understand it, logs a loud error listing the valid values, and falls back to `claude-oauth` (which needs a Claude login, so on a no-Claude machine that means *nothing gets summarized*).
> - **To see which one is actually running:** `captain-memo stats` (or `captain-memo top`) now shows a `Summarizer` line with the resolved provider and whether it's actively summarizing. `captain-memo doctor` shows the configured value.

The summarizer compresses raw tool-use events into structured observations. Pick how it gets a model via `CAPTAIN_MEMO_SUMMARIZER_PROVIDER`:

| Provider | How it works | When to use |
|---|---|---|
| `claude-oauth` (default) | Direct Anthropic API with Claude Code's stored OAuth token | Fastest (~700 ms). Needs a Claude Max/Pro plan + `claude login` |
| `codex` | Shells out to `codex exec`, uses your **ChatGPT Plus/Pro account** | **No Claude subscription and no API key.** ~6–7 s/call (agent boot, not inference). Needs `codex login` |
| `agy` | Shells out to `agy -p`, uses a plain **Google account** (Antigravity CLI) | **No Claude AND no ChatGPT subscription needed.** ~3–5 s/call — fastest agent CLI. Needs agy ≥ 1.1.1, logged in |
| `claude-code` | Shells out to `claude -p`, uses your **Claude Code Max/Pro plan** | Zero setup, no API key |
| `openai-compatible` | POSTs to any `/v1/chat/completions` endpoint you point it at | Local LLMs (Ollama, LM Studio, vLLM, llama.cpp), OpenAI, OpenRouter, Together, Groq, DeepSeek, Mistral, etc. |
| `anthropic` (default) | Direct Anthropic SDK + `ANTHROPIC_API_KEY` | You already have Anthropic API billing |

### Quick start — a plain Google account (no Claude, no ChatGPT, no API key)

```bash
agy                                        # once, to log in (Antigravity CLI, >= 1.1.1)
export CAPTAIN_MEMO_SUMMARIZER_PROVIDER=agy
# Model defaults to 'Gemini 3.5 Flash (Low)' — the Flash tier, cheapest AND fastest.
# Set it to `default` to just use your account default.
```

Model names here are the **display names** `agy models` prints (`Gemini 3.5 Flash (Low)`), not
slugs. A typo exits 1 and lists the valid ones, so it fails loudly rather than silently.

`agy` has no `--ephemeral` flag and no home override — every run persists a conversation
(~364 KB). So captain-memo runs it under a private `$HOME` (`<DATA_DIR>/agy-home`) with your
OAuth token symlinked in, and prunes its conversations after each call. Your real
`agy --continue` history is never touched and never grows.

### Quick start — ChatGPT Plus/Pro (no API key, no Claude subscription)

```bash
npm i -g @openai/codex && codex login    # once
export CAPTAIN_MEMO_SUMMARIZER_PROVIDER=codex
# CAPTAIN_MEMO_SUMMARIZER_MODEL defaults to gpt-5.4-mini; set it to `default`
# to just use whatever model your ChatGPT plan gives you.
```

A ChatGPT account gates the model list server-side (`gpt-5.4-nano` and every
`gpt-5.1-*` slug are rejected outright), so the fallback chain ends at the
sentinel `default` — meaning "send no model at all" — which the account always
accepts. You never have to know which slugs your plan allows.

Summarization runs on the worker's 5 s background tick and collapses a whole
prompt window into ONE call, so the ~6–7 s never lands on your keystrokes.

### Quick start — Max/Pro plan (no API key, no install)

```bash
export CAPTAIN_MEMO_SUMMARIZER_PROVIDER=claude-code
bun run worker:start
```

Auth comes from your existing Claude Code login. Trade-off: ~1-2 s subprocess overhead per batch (vs ~200-400 ms direct API), and calls count against your Max session rate limits.

### Quick start — local LLM via Ollama

```bash
# Run any model via Ollama (e.g. llama3.3-70b, qwen2.5-coder, mistral-nemo)
ollama pull qwen2.5:14b-instruct
export CAPTAIN_MEMO_SUMMARIZER_PROVIDER=openai-compatible
export CAPTAIN_MEMO_OPENAI_ENDPOINT=http://localhost:11434/v1/chat/completions
export CAPTAIN_MEMO_SUMMARIZER_MODEL=qwen2.5:14b-instruct   # whatever your endpoint serves
bun run worker:start
```

No API key needed for local servers. The same pattern works for **LM Studio** (port 1234), **vLLM** (port 8000), **llama.cpp's `--server`** mode, and any other tool that exposes the OpenAI Chat Completions shape.

### Quick start — OpenAI / OpenRouter / Together / Groq / DeepSeek / etc.

```bash
export CAPTAIN_MEMO_SUMMARIZER_PROVIDER=openai-compatible
export CAPTAIN_MEMO_OPENAI_ENDPOINT=https://api.openai.com/v1/chat/completions
export CAPTAIN_MEMO_OPENAI_API_KEY=sk-...
export CAPTAIN_MEMO_SUMMARIZER_MODEL=gpt-4o-mini
bun run worker:start
```

(Replace endpoint + model with whatever provider you use.)

### Quick start — direct Anthropic API

```bash
export ANTHROPIC_API_KEY=sk-ant-...
bun run worker:start
```

(Default `CAPTAIN_MEMO_SUMMARIZER_PROVIDER=anthropic`, no other config needed.)

## New prerequisites

| Variable | Default | Required for |
|---|---|---|
| `CAPTAIN_MEMO_SUMMARIZER_PROVIDER` | `claude-oauth` | `claude-oauth` / `codex` / `agy` / `anthropic` / `claude-code` / `openai-compatible`. |
| `ANTHROPIC_API_KEY` | — | Required when `provider=anthropic`. Ignored under other providers. |
| `CAPTAIN_MEMO_OPENAI_ENDPOINT` | — | Required when `provider=openai-compatible`. Full URL to `/v1/chat/completions`. |
| `CAPTAIN_MEMO_OPENAI_API_KEY` | — | Optional bearer token for `provider=openai-compatible`. Local servers (Ollama, LM Studio) typically don't need it. |
| `CAPTAIN_MEMO_SUMMARIZER_MODEL` | `claude-haiku-4-6` | Primary summarizer model. Provider-agnostic — set it to whatever model your endpoint serves (e.g. `gpt-4o-mini`, `qwen2.5:14b`, `deepseek-chat`, etc.). |
| `CAPTAIN_MEMO_SUMMARIZER_FALLBACKS` | `claude-haiku-4-5` | Comma-separated fallback chain. Each model is tried in order on `model_not_found`; the first one that responds is cached for the worker's lifetime. |
| `CAPTAIN_MEMO_HOOK_BUDGET_TOKENS` | `4000` | Hard cap on `<memory-context>` token budget. |
| `CAPTAIN_MEMO_HOOK_TIMEOUT_MS` | `250` | UserPromptSubmit hard timeout. |
| `CAPTAIN_MEMO_AUTO_UPDATE` | `0` | `1` opts a **git-clone** install into autonomous self-update: on session start, fast-forward the checkout to the newest stable `vX.Y.Z` tag on `origin`, `bun install`, restart the worker. Fast-forward only; refuses a dirty tree / detached HEAD; ignores pre-release tags. No-op on a marketplace install. |
| `CAPTAIN_MEMO_AUTO_UPDATE_INTERVAL_MS` | `21600000` (6h) | Minimum gap between auto-update checks (each does a `git fetch`), so it doesn't hit the network every session. |
| `CAPTAIN_MEMO_OBSERVATION_BATCH_SIZE` | `20` | Rows pulled per processor tick. |
| `CAPTAIN_MEMO_OBSERVATION_TICK_MS` | `5000` | Interval for the auto-tick processor. |

> If neither `CAPTAIN_MEMO_SUMMARIZER_PROVIDER=claude-code` nor `ANTHROPIC_API_KEY` is set, the queue accepts events but `flush` returns 503 (observations stay queued; nothing is dropped).

## Install hooks

```bash
# User-scope (default) — registers in ~/.claude/settings.json
captain-memo install-hooks

# Project-scope — registers in <cwd>/.claude/settings.json
captain-memo install-hooks --project
```

The command is idempotent — running it twice doesn't duplicate entries.
Foreign hook entries (from other tools) are preserved.

## CLI extensions (Plan 2)

```bash
captain-memo config show              # Effective config + masked secrets
captain-memo observation list         # Recent observations
captain-memo observation list --limit 50
captain-memo observation flush        # Drain the whole queue
captain-memo observation flush --session ses_xyz
captain-memo install-hooks            # Register hooks in settings.json
captain-memo install-hooks --project
```

## Hook contracts at a glance

| Hook | Latency budget | Behavior on worker down |
|---|---|---|
| `UserPromptSubmit` | 250 ms p95 | No envelope; original prompt still passes through |
| `SessionStart` | 250 ms p95 | Silent |
| `PostToolUse` | 100 ms (fire-and-forget) | Event dropped |
| `Stop` | 5 s drain | Queue persists for next session |

## Migrating from claude-mem

Plan-3 ships a one-time, **read-only** migration command that imports your
existing `~/.claude-mem/claude-mem.db` into the Captain Memo corpus. The
source database is opened with `readonly: true` and is never modified or
deleted — claude-mem keeps running side-by-side for as long as you want it to.

```bash
# 1. Inspect first (zero-risk — prints row counts only):
captain-memo inspect-claude-mem

# 2. Preview what would migrate (no writes):
captain-memo migrate-from-claude-mem --dry-run

# 3. Real migration (writes to ~/.captain-memo/, never to ~/.claude-mem/):
captain-memo migrate-from-claude-mem --project erp-platform

# Resumable / partial:
captain-memo migrate-from-claude-mem --limit 1000        # process first 1000 rows then stop
captain-memo migrate-from-claude-mem --from-id 12000     # resume from observation/summary id
captain-memo migrate-from-claude-mem --db /custom/path/claude-mem.db
```

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--dry-run` | off | Walk the source DB, transform every row, but never write to the meta DB or vector store. Reports the same counts a real run would. |
| `--limit N` | unlimited | Cap the number of new rows processed this run. Already-migrated rows still count as `skipped`, not `migrated`. |
| `--from-id N` | `0` | Only consider source rows with `id >= N`. Useful for sharding very large migrations. |
| `--project ID` | `$CAPTAIN_MEMO_PROJECT_ID` or `default` | Project namespace for the migrated corpus. |
| `--db PATH` | `~/.claude-mem/claude-mem.db` | Override the source database path. |
| `--keep-original` | always on | Documented for clarity — Captain Memo never deletes the source DB. |

### Safety contract

- `~/.claude-mem/claude-mem.db` is opened with `readonly: true` and never
  written to or deleted.
- Migration is **idempotent**: a `migration_progress` table inside
  `~/.captain-memo/meta.sqlite3` tracks every `(source_kind, source_id)` pair
  processed. Re-running the command picks up only new rows; previously
  migrated rows show up as `skipped`.
- Re-running with `--dry-run` always reports the count of rows that *would*
  be migrated — it does not write progress, so it remains a true preview.
- claude-mem continues running side by side for the dual-running phase
  (Spec §7 Phase 3). You can keep both installed indefinitely.

### Rollback

```bash
# Drop the captain-memo data directory (vector + meta DB + queues):
rm -rf ~/.captain-memo

# Reinstall:
captain-memo install
```

claude-mem keeps working independently — its database, vector store, and
hooks are completely untouched by Captain Memo.

### What gets migrated

| Source table | Destination | Notes |
|---|---|---|
| `observations` | One `Document` per row, channel `observation` | `narrative` becomes one chunk, each non-empty entry in `facts[]` becomes another chunk. Empty rows are marked done and skipped. |
| `session_summaries` | One `Document` per row, channel `observation` | One chunk per non-empty field across `request`, `investigated`, `learned`, `completed`, `next_steps`, `notes`. |
| `sdk_sessions` / `user_prompts` / `pending_messages` | not migrated | Session/prompt logs are session-bound and not useful as cross-session memory. |

Each migrated chunk carries `metadata.migrated_from = "claude-mem"` plus the
original `observation_id` / `summary_id` for traceability.

## What's NOT in Plan 2

- `optimize` / `purge` / `forget` (Plan 3)
- Retrieval-quality eval runner (Plan 3)
- Local Voyage install script (Plan 3)
