# Captain Memo

> *Your AI coding agent's logbook — local memory, kept in sync, retrieved on every prompt.*

Captain Memo is a local memory layer for AI coding agents (built first for [Claude Code](https://github.com/anthropics/claude-code) but provider-agnostic). Every session leaves a wake; Captain Memo keeps the log so the next session sails with what was learned in the last one.

- **Local-first.** Vector store and metadata live on your machine — `sqlite-vec` + SQLite WAL, no cloud database, no per-call billing for retrieval.
- **Hybrid search.** Voyage embeddings + FTS5 keyword index, fused via Reciprocal Rank Fusion. Natural-language queries match short docs.
- **Three summarizer providers.** Pick at install time:
  - `claude-code` — uses your existing **Claude Code Max/Pro** plan (no API key)
  - `openai-compatible` — Ollama / LM Studio / vLLM / OpenAI / OpenRouter / DeepSeek / Groq / Together / Mistral / etc.
  - `anthropic` — direct Anthropic SDK with `ANTHROPIC_API_KEY`
- **Auto-injected context.** A `<memory-context>` envelope is added to every user prompt by the `UserPromptSubmit` hook — relevant memory, skills, and prior session observations are visible to the model without you typing anything.
- **Session observations.** Every tool use is captured (fire-and-forget); on `Stop`, batched events are summarized into structured observations and indexed into the same hybrid search.

## 30-second quick start (Max/Pro plan, no API key)

```bash
# 1. Clone + install
git clone https://github.com/<your-account>/captain-memo
cd captain-memo
bun install

# 2. Use your existing Claude Code login as the summarizer
export CAPTAIN_MEMO_SUMMARIZER_PROVIDER=claude-code

# 3. Watch your Claude memory directory (use absolute paths)
export CAPTAIN_MEMO_WATCH_MEMORY="$HOME/.claude/memory/*.md"

# 4. Start the worker
bun run worker:start &

# 5. Register the four hooks in ~/.claude/settings.json
./bin/captain-memo install-hooks

# 6. Restart Claude Code. Done.
```

You'll see a `<memory-context>` block in every session transcript — the items Captain Memo retrieved for the prompt — and `./bin/captain-memo observation list` will show what it captured.

## 30-second quick start (local LLM via Ollama)

```bash
ollama pull qwen2.5:14b-instruct
export CAPTAIN_MEMO_SUMMARIZER_PROVIDER=openai-compatible
export CAPTAIN_MEMO_OPENAI_ENDPOINT=http://localhost:11434/v1/chat/completions
export CAPTAIN_MEMO_SUMMARIZER_MODEL=qwen2.5:14b-instruct
bun run worker:start
```

No API key needed for any local server (Ollama / LM Studio / vLLM / llama.cpp `--server`).

## CLI

```bash
captain-memo status              # is the worker reachable?
captain-memo stats               # corpus stats by channel
captain-memo reindex             # cheap sha-diff reindex (or --force to re-embed)
captain-memo observation list    # recent captured observations
captain-memo observation flush   # force-drain the queue
captain-memo config show         # effective config (secrets masked)
captain-memo install-hooks       # register hooks in ~/.claude/settings.json
captain-memo install-hooks --project   # ...or in <cwd>/.claude/settings.json
```

## What's inside

| Component | What it does |
|---|---|
| **Worker** (`:39888`) | Long-lived HTTP server. Owns the SQLite + sqlite-vec stores, file watcher, observation queue, summarizer. |
| **MCP server** (stdio) | Exposes 8 tools (`search_memory`, `search_skill`, `search_observations`, `search_all`, `get_full`, `reindex`, `stats`, `status`) to Claude Code via `.mcp.json`. |
| **Four hook scripts** | `UserPromptSubmit` (inject envelope, ≤250 ms p95), `SessionStart` (warm worker), `PostToolUse` (fire-and-forget enqueue), `Stop` (5 s drain → summarize → index). |
| **CLI** | The commands above. |

Channels indexed: `memory` (curated user memory files), `skill` (Claude Code skill bodies, section-level), `observation` (summarized session events).

Detailed docs: [`docs/USAGE.md`](docs/USAGE.md).

## Status

| Plan | Scope | State |
|---|---|---|
| 1 | Worker, MCP server, CLI, hybrid search, file watcher, ingest pipeline | Shipped |
| 2 | Hooks + observation pipeline + summarizer (3 providers) | Shipped |
| 3 | claude-mem migration · federation client · optimize/purge/forget · retrieval-quality eval · Voyage installer · doctor | Drafted, not yet implemented |

148 tests pass. Typecheck clean. Bun ≥ 1.1.14, TypeScript strict.

## Why "Captain Memo"?

The captain keeps the ship's log. Every voyage gets entered. When the ship sails again, the captain remembers what happened on the last one — the storms, the trade winds, the islands that turned out to have fresh water. That's what this plugin does for your AI coding sessions.

The metaphor extends throughout the codebase: memory files = logbook entries, observations = voyage logs, the file watcher = lookout in the crow's nest, federation (Plan 3) = sister ships exchanging signals, claude-mem migration = transferring the old ship's log.

## Contributing

Open issues, pull requests welcome. Three plans live in [`docs/plans/`](docs/plans/) — they're the full implementation roadmap. Plan 3's 35 tasks are good first issues for anyone who wants to help build the migration / federation / optimization layers.

## License

MIT — see [LICENSE](LICENSE).
