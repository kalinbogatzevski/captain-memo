# captain-memo — Manual usage

The worker, the CLI and the MCP server driven by hand. Hooks, the observation pipeline and the claude-mem migration follow further down.

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
| `CAPTAIN_MEMO_WATCH_SKILLS` | `auto` | Comma-separated globs to watch for skill files (channel = `skill`). Missing means auto-discover installed AI skills; an explicitly empty value opts out. |
| `CAPTAIN_MEMO_WATCH_CAPABILITIES` | `auto` | Known plugin/extension manifests (channel = `capability`). Missing auto-discovers installed Gemini/Agy, Claude, and Codex capabilities; explicitly empty opts out. Only sanitized descriptors are stored. |
| `CAPTAIN_MEMO_DATA_DIR` | `~/.captain-memo` | Where the meta SQLite + vector SQLite + logs live. |

The worker watches memory, skill, and capability sources together.

## Use the CLI

```bash
captain-memo status                     # health check + total chunk count
captain-memo stats                      # corpus stats by channel
captain-memo reindex                    # cheap sha-diff reindex
captain-memo reindex --channel memory   # restrict to one channel
captain-memo reindex --force            # ignore sha cache, re-embed all
captain-memo skill list                 # browse synchronized virtual skills
captain-memo skill list --source codex  # filter by source AI (--json is available)
captain-memo capability list            # installed plugin/extension capabilities
captain-memo capability recommend "generate an image"
```

## Upkeep — disk and staleness

```bash
captain-memo maintenance                    # what could be reclaimed (changes nothing)
captain-memo maintenance --apply            # reclaim it
captain-memo maintenance --retention-days 7 # spent queue rows older than N days (default 30)
captain-memo maintenance --grace-days 14    # plugin-cache trees orphaned longer than N days (default 7)
```

Three sweeps: finished queue rows past the retention window, embeddings whose chunk is gone, and
superseded plugin-cache trees. Dry-run by default — it deletes, so it shows its work first.

**About the plugin cache.** Upgrading re-points Claude Code at a new version directory under
`~/.claude/plugins/cache/` and marks the old one `.orphaned_at`. Claude Code documents a 7-day grace
period after which it collects the old tree; in practice trees survive well past it. This prunes only
what carries that marker, only past the grace window, and never the active tree, a tree a running
process is loaded from, or another plugin's. Reported sizes are hardlink-aware — version directories
share most of their files, so `du` and a naive byte-sum both overstate what a delete would free.

**Two staleness checks in `captain-memo doctor`:**

| check | means |
|---|---|
| `plugin cache version` | the cache copy is older than this checkout — the cache did not follow the last update. Re-run `captain-memo install`. |
| `live plugin version` | a running session is on an older plugin than this checkout, and names which. |

A session's plugin root is fixed in its **process argv at spawn** (`--plugin-dir <path>`), not read
from the cache when used — so an upgrade can never reach an already-running session, and restarting it
is the only remedy. The check names the sessions by entrypoint because it matters which daemon owns
them: on a machine you connect to remotely there are typically two, and they do not overlap.

| entrypoint | hosted by | how to clear it |
|---|---|---|
| `claude-desktop` | the Claude Desktop SSH helper (`claude-ssh`, `~/.claude/remote/srv/<hash>/server`) | reopen from the Desktop app, or restart that helper |
| `sdk-cli` | the `claude rc` daemon | restart it |

Restarting `claude rc` therefore leaves every Desktop session running its old copy — the trap this
check exists to name.

## Use the MCP server (manual)

The stdio MCP server connects to the worker over HTTP and exposes Captain Memo's recall, skill-broker, and coordination tools.

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

Skill-broker tools: `list_skills` browses the synchronized catalog, `recommend_skills` returns task-relevant descriptors, and `load_skill` retrieves the selected skill's complete advisory instructions. Capability tools (`list_capabilities`, `recommend_capabilities`, `get_capability`) advertise which runtime owns an installed plugin/extension so another AI can route work there. The remaining tools cover memory search, persistence, observations, reindexing, health, work coordination and homework.

Work coordination is `work_set` / `work_active` / `work_clear`. Always pass `topics` to `work_set`: 1–5 short kebab tags for what the work is *about* (`billing-rounding`, `installer-windows`) — two sessions on one topic are flagged whatever files they touch. Each row in `overlaps[]` says its `kind` (`topics` | `files` | `semantic` | `repo`) and what is shared; `work_active` adds `topic_contention` (every topic two or more sessions hold, and who), and both report `semantic` — whether the meaning-match pass is working right now, and since when / why it is degraded.

### Homework

Ideas and todos parked for later, per captain — every AI session on this machine sees the same list. Not a memory (a memory is a fact) and not a work claim (a claim is now): an item has a lifecycle, open → claimed → done.

- Type `idea: …`, `todo: …`, `homework: …` or `later: …` (`идея:` / `за после:`) at the start of a prompt and the prompt hook files it on this machine without spending the turn — the model sees `📝 Filed as homework #N on this captain (not for now): …` and answers "noted".
- `todo_add(text, topics, project)` files one from a session; `todo_list(status)` shows what is `open` (default), `done` (kept a week) or `all`; `todo_claim(id)` takes one, so every other session on this machine sees it as taken; `todo_done(id, note)` closes it.
- Every new session lists the open items in its session-start banner.
- Worker routes: `POST /homework/add`, `GET /homework/list`, `POST /homework/claim`, `POST /homework/done`.

## Watch paths

Set `CAPTAIN_MEMO_WATCH_MEMORY`, `CAPTAIN_MEMO_WATCH_SKILLS`, or `CAPTAIN_MEMO_WATCH_CAPABILITIES` to comma-separated globs. Skill and capability discovery are `auto` when missing; set either to an explicitly empty value to opt out. Changes and deletions synchronize while the worker runs. Explicit environment globs should use absolute paths because `~` is not expanded there.

Example:

```bash
CAPTAIN_MEMO_WATCH_MEMORY="/home/me/.claude/memory/*.md" bun run worker:start
```

---

# Hooks + observation pipeline

Auto-injection hooks, the observation queue, and a configurable Haiku-class summarizer
on top of the foundation above.

## Summarizer — pick a provider

> **One runs at a time, but you can name a fallback order.** `CAPTAIN_MEMO_SUMMARIZER_PROVIDER`
> takes a comma-separated **ordered preference**, e.g. `claude-oauth,codex,agy` — "prefer my Claude
> login, else Codex, else Antigravity". A single value keeps its old meaning exactly.
> - **At boot** the worker walks the list and commits to the first provider that can actually start.
>   The probes are structural (token present and unexpired, binary on PATH, endpoint set), so a
>   healthy first entry costs one cheap check. Entries after the winner are never probed.
> - **At runtime** a provider that dies is retired and the next one takes over — an OAuth token that
>   expires at hour 30 no longer means observations are dead-lettered. Auth-shaped failures (401/403,
>   missing token, missing binary) demote immediately; a plain bad request does not, so one
>   malformed batch cannot retire a working provider. A demoted provider is never retried until the
>   worker restarts, deliberately: no cooldown, no flapping between two half-broken providers.
> - **When the chain runs out**, the summarizer stops and `doctor` FAILs loudly saying so. Restarting
>   re-walks the whole list.
> - **`captain-memo install --summarizer <x>` REPLACES the previous choice** (it doesn't add). The
>   wizard prints `summarizer changed: codex → agy (replaces it)` so you can see the swap.
> - **To see what is actually running:** `captain-memo stats` shows the live provider;
>   `captain-memo doctor` names any provider that was skipped at boot or demoted at runtime, with
>   the reason and the time, and WARNs rather than showing a green line when you are on a fallback.
>
> An unrecognised entry is dropped with a warning rather than failing the whole list — one typo in a
> three-provider chain costs that entry, not your summarizer. If nothing survives, the worker says so
> loudly and falls back to the default.

The summarizer compresses raw tool-use events into structured observations. Pick how it gets a model via `CAPTAIN_MEMO_SUMMARIZER_PROVIDER`:

| Provider | How it works | When to use |
|---|---|---|
| `claude-oauth` (default) | Direct Anthropic API with Claude Code's stored OAuth token | Fastest (~700 ms). Needs a Claude Max/Pro plan + `claude login` |
| `codex` | Shells out to `codex exec`, uses your **ChatGPT Plus/Pro account** | **No Claude subscription and no API key.** ~6–7 s/call (agent boot, not inference). Needs `codex login` |
| `agy` | Shells out to `agy -p`, uses a plain **Google account** (Antigravity CLI) | **No Claude AND no ChatGPT subscription needed.** ~3–5 s/call — fastest agent CLI. Needs agy ≥ 1.1.1, logged in |
| `claude-code` | Shells out to `claude -p`, uses your **Claude Code Max/Pro plan** | Zero setup, no API key |
| `openai-compatible` | POSTs to any `/v1/chat/completions` endpoint you point it at | Local LLMs (Ollama, LM Studio, vLLM, llama.cpp), OpenAI, OpenRouter, Together, Groq, DeepSeek, Mistral, etc. |
| `anthropic` | Direct Anthropic SDK + `ANTHROPIC_API_KEY` | You already have Anthropic API billing |

### Quick start — a plain Google account (no Claude, no ChatGPT, no API key)

```bash
agy                                        # once, to log in (Antigravity CLI, >= 1.1.1)
export CAPTAIN_MEMO_SUMMARIZER_PROVIDER=agy
# Model defaults to `default` — your account's own model, so there is no name to keep
# current. Pin one (e.g. 'Gemini 3.5 Flash (Low)', the Flash tier, cheapest AND fastest)
# if you want a specific tier.
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
# CAPTAIN_MEMO_SUMMARIZER_MODEL defaults to `default` — whatever model your ChatGPT
# plan gives you. Pin a slug only if you know your plan allows it.
```

A ChatGPT account gates the model list server-side and PER PLAN, and the slugs turn
over every few months — nothing offline can enumerate them (there is no `codex models`,
and `-m` documents no values). So the default, and the floor under any slug you pin, is
the sentinel `default` — meaning "send no model at all" — which the account always
accepts. You never have to know which slugs your plan allows, and captain-memo never
ships you one that has since been retired.

Summarization runs on the worker's 5 s background tick and collapses a whole
prompt window into ONE call, so the ~6–7 s never lands on your keystrokes.

### Quick start — Max/Pro plan (no API key, no install)

```bash
export CAPTAIN_MEMO_SUMMARIZER_PROVIDER=claude-code
bun run worker:start
```

Auth comes from your existing Claude Code login. Trade-off: ~1-2 s subprocess overhead per batch (vs ~200-400 ms direct API), and calls count against your Max session rate limits.

The model defaults to the alias `haiku`, which the CLI resolves to the current Haiku release —
so there is no model name to keep current here. (`claude-oauth` and `anthropic` talk to
api.anthropic.com, which resolves FULL ids only and 404s every alias, so those keep a full model
id.) The chain floors at the sentinel `default`, meaning "pass no `--model` at all".

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
export CAPTAIN_MEMO_SUMMARIZER_PROVIDER=anthropic
bun run worker:start
```

(The default provider is `claude-oauth`; `anthropic` has to be named. No other config needed.)

## New prerequisites

| Variable | Default | Required for |
|---|---|---|
| `CAPTAIN_MEMO_SUMMARIZER_PROVIDER` | `claude-oauth` | One of `claude-oauth` / `codex` / `agy` / `anthropic` / `claude-code` / `openai-compatible`, **or a comma-separated ordered chain** like `claude-oauth,codex,agy` (first that can run wins; failover retires a dead one at runtime). |
| `ANTHROPIC_API_KEY` | — | Required when `provider=anthropic`. Ignored under other providers. |
| `CAPTAIN_MEMO_OPENAI_ENDPOINT` | — | Required when `provider=openai-compatible`. Full URL to `/v1/chat/completions`. |
| `CAPTAIN_MEMO_OPENAI_API_KEY` | — | Optional bearer token for `provider=openai-compatible`. Local servers (Ollama, LM Studio) typically don't need it. |
| `CAPTAIN_MEMO_SUMMARIZER_MODEL` | **provider-dependent** | Primary summarizer model. Defaults: `claude-haiku-4-5` for the API providers (`claude-oauth`, `anthropic`), the alias `haiku` for `claude-code`, and the `default` sentinel — "send no model flag, let the account choose" — for `codex` and `agy`. Set it to whatever model your endpoint serves (e.g. `gpt-4o-mini`, `qwen2.5:14b`) to pin one yourself. |
| `CAPTAIN_MEMO_SUMMARIZER_FALLBACKS` | **provider-dependent** | Comma-separated fallback chain, tried in order on `model_not_found`; the first that responds is cached for the worker's lifetime. Defaults: `claude-haiku-4-5-20251001,claude-sonnet-5` for the API providers, and the `default` sentinel for the three agent CLIs — which is the floor under any model you pin, so a retired name can never leave the summarizer with nothing to call. |
| `CAPTAIN_MEMO_HOOK_BUDGET_TOKENS` | `4000` | Hard cap on `<memory-context>` token budget. |
| `CAPTAIN_MEMO_HOOK_TIMEOUT_MS` | `1500` | UserPromptSubmit hard timeout. |
| `CAPTAIN_MEMO_AUTO_UPDATE` | `0` | `1` opts a **git-clone** install into autonomous self-update: on session start, fast-forward the checkout to the newest stable `vX.Y.Z` tag on `origin`, `bun install`, restart the worker. Fast-forward only; refuses a dirty tree / detached HEAD; ignores pre-release tags. No-op on a marketplace install. |
| `CAPTAIN_MEMO_AUTO_UPDATE_INTERVAL_MS` | `21600000` (6h) | Minimum gap between auto-update checks (each does a `git fetch`), so it doesn't hit the network every session. |
| `CAPTAIN_MEMO_OBSERVATION_BATCH_SIZE` | `20` | Rows pulled per processor tick. |
| `CAPTAIN_MEMO_OBSERVATION_TICK_MS` | `5000` | Interval for the auto-tick processor. |

> If no summarizer can run (the configured provider is not logged in / has no key), the queue accepts events but `flush` returns 503 (observations stay queued; nothing is dropped). `captain-memo stats` shows which provider is live.

## Install hooks

```bash
# User-scope (default) — registers in ~/.claude/settings.json
captain-memo install-hooks

# Project-scope — registers in <cwd>/.claude/settings.json
captain-memo install-hooks --project
```

The command is idempotent — running it twice doesn't duplicate entries.
Foreign hook entries (from other tools) are preserved.

## CLI extensions (hooks + observations)

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
| `UserPromptSubmit` | 1500 ms (`CAPTAIN_MEMO_HOOK_TIMEOUT_MS`) | No envelope; original prompt still passes through |
| `SessionStart` | registered with a 60 s timeout; waits ≤15 s for a starting worker, ≤20 s for one that is updating or booting | Prints a banner: the degraded one, or — when the worker left a transition breadcrumb — "updating (vX → vY)" with a note that memory resumes by itself, no restart needed |
| `PostToolUse` | 100 ms (fire-and-forget) | Event dropped |
| `Stop` | 5 s drain | Queue persists for next session |

## Migrating from claude-mem

A one-time, **read-only** migration command imports your
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

