# aelita-mcp Plan-1 — Manual Usage (Foundation)

This is what's available after Plan 1 ships. Hooks (auto-injection) come in Plan 2; migration from claude-mem and federation come in Plan 3.

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
| `AELITA_MCP_WORKER_PORT` | `39888` | HTTP port for the long-lived worker. |
| `AELITA_MCP_PROJECT_ID` | `default` | Project namespace for the per-project vector collection. |
| `AELITA_MCP_VOYAGE_ENDPOINT` | `http://localhost:8124/v1/embeddings` | Voyage embeddings endpoint. |
| `AELITA_MCP_VOYAGE_MODEL` | `voyage-4-nano` | Model identifier passed to Voyage. |
| `AELITA_MCP_VOYAGE_API_KEY` | — | Optional bearer token for Voyage. |
| `AELITA_MCP_WATCH_MEMORY` | — | Comma-separated globs to watch for memory files (channel = `memory`). |
| `AELITA_MCP_WATCH_SKILLS` | — | Comma-separated globs to watch for skill files (channel = `skill`). |
| `AELITA_MCP_DATA_DIR` | `~/.aelita-mcp` | Where the meta SQLite + vector SQLite + logs live. |

> Plan-1 supports **one watch channel per worker process**. If both `AELITA_MCP_WATCH_MEMORY` and `AELITA_MCP_WATCH_SKILLS` are set, the worker uses memory and warns. Multi-channel watch is on the Plan-2 backlog.

## Use the CLI

```bash
aelita-mcp status                     # health check + total chunk count
aelita-mcp stats                      # corpus stats by channel
aelita-mcp reindex                    # cheap sha-diff reindex
aelita-mcp reindex --channel memory   # restrict to one channel
aelita-mcp reindex --force            # ignore sha cache, re-embed all
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
    "aelita-mcp": {
      "type": "stdio",
      "command": "bun",
      "args": ["/absolute/path/to/aelita-mcp/src/mcp-server.ts"]
    }
  }
}
```

Tools exposed: `search_memory`, `search_skill`, `search_observations`, `search_all`, `get_full`, `reindex`, `stats`, `status`.

## Watch paths

Set the env vars `AELITA_MCP_WATCH_MEMORY` or `AELITA_MCP_WATCH_SKILLS` to comma-separated globs. Patterns are passed to Bun's native glob — typical forms like `~/.claude/memory/*.md` work after shell expansion (note: env-passed values won't expand `~`, so prefer absolute paths in env).

Example:

```bash
AELITA_MCP_WATCH_MEMORY="/home/me/.claude/memory/*.md" bun run worker:start
```

## What's NOT in Plan 1

- Auto-injection on user prompts (Plan 2)
- Session observation pipeline (Plan 2)
- Migration from claude-mem (Plan 3)
- Federation with remote MCPs (Plan 3)
- Optimization / duplicate detection (Plan 3)
- Voyage install script (Plan 3)

---

# aelita-mcp Plan-2 — Hooks + Observation Pipeline

Plan 2 layers auto-injection hooks, the observation queue, and the Haiku
summarizer on top of the Plan-1 foundation.

## New prerequisites

| Variable | Default | Required for |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Observation summarization (Haiku-class small model). Without it the queue accepts events but `flush` returns 503. |
| `AELITA_MCP_HAIKU_MODEL` | `claude-haiku-4-6` | Primary summarizer model. Default is a 2026-05 snapshot — point it at any newer model when one ships (e.g. `claude-haiku-4-7`). |
| `AELITA_MCP_HAIKU_FALLBACKS` | `claude-haiku-4-5` | Comma-separated fallback chain. Each model is tried in order on `model_not_found`; the first one that responds is cached for the worker's lifetime. |
| `AELITA_MCP_HOOK_BUDGET_TOKENS` | `4000` | Hard cap on `<memory-context>` token budget. |
| `AELITA_MCP_HOOK_TIMEOUT_MS` | `250` | UserPromptSubmit hard timeout. |
| `AELITA_MCP_OBSERVATION_BATCH_SIZE` | `20` | Rows pulled per processor tick. |
| `AELITA_MCP_OBSERVATION_TICK_MS` | `5000` | Interval for the auto-tick processor. |

## Install hooks

```bash
# User-scope (default) — registers in ~/.claude/settings.json
aelita-mcp install-hooks

# Project-scope — registers in <cwd>/.claude/settings.json
aelita-mcp install-hooks --project
```

The command is idempotent — running it twice doesn't duplicate entries.
Foreign hook entries (from other tools) are preserved.

## CLI extensions (Plan 2)

```bash
aelita-mcp config show              # Effective config + masked secrets
aelita-mcp observation list         # Recent observations
aelita-mcp observation list --limit 50
aelita-mcp observation flush        # Drain the whole queue
aelita-mcp observation flush --session ses_xyz
aelita-mcp install-hooks            # Register hooks in settings.json
aelita-mcp install-hooks --project
```

## Hook contracts at a glance

| Hook | Latency budget | Behavior on worker down |
|---|---|---|
| `UserPromptSubmit` | 250 ms p95 | No envelope; original prompt still passes through |
| `SessionStart` | 250 ms p95 | Silent |
| `PostToolUse` | 100 ms (fire-and-forget) | Event dropped |
| `Stop` | 5 s drain | Queue persists for next session |

## What's NOT in Plan 2

- Migration from `claude-mem` (Plan 3)
- Federation with remote MCPs (Plan 3)
- `optimize` / `purge` / `forget` (Plan 3)
- Retrieval-quality eval runner (Plan 3)
- Local Voyage install script (Plan 3)
