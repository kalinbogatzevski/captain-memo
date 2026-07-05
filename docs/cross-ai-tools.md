# Captain Memo across AI tools (Codex, Cursor, Gemini CLI, opencode, Mistral Vibe, VS Code, JetBrains, …)

Captain Memo's worker is an **agent-agnostic local HTTP service**, and it ships an **MCP server**. So
*any* MCP-speaking AI coding tool can share the **same local memory corpus** — the same one Claude Code
populates. Point several tools at one worker and context one tool learned becomes available to the others.

It's two pieces per tool:

1. **Register the MCP server** → the tool gets `search_all`, `search_observations`, `search_memory`,
   `get_full`, and the work-coordination tools `work_set`/`work_active`/`work_clear`. The MCP server is a
   thin stdio bridge that talks to your running worker on `http://localhost:39888`, so every tool reuses
   the **same worker and corpus** — nothing is duplicated.
2. **Install the skill** (`skills/captain-memo/SKILL.md`) into the tool's skills/rules directory → it
   tells the model *when* to recall (search at task start; "have we decided/hit this before?").

The MCP tools are **read-only/recall** (search + drill). Capture is automatic where the tool has
lifecycle hooks (Claude Code today); other tools recall the shared memory that Claude Code and the
session hooks write.

**The fast path: `captain-memo connect`.** Every tool below can be wired automatically —
`captain-memo connect` detects every installed tool and wires all of them in one shot;
`captain-memo connect --list` shows what's detected without changing anything;
`captain-memo connect <tool>` wires just one (`codex | gemini | cursor | opencode | vibe | vscode | jetbrains`).
The manual steps in each section below are what `connect` does under the hood, for tools that don't have
one, want to inspect the exact config, or are on an unsupported OS.

## Codex CLI

```bash
# 1. register the MCP server (stdio → your local worker)
codex mcp add captain-memo -- bun /path/to/captain-memo/plugin/dist/mcp-server.js
codex mcp list   # confirm: captain-memo  enabled

# 2. install the skill
mkdir -p ~/.codex/skills/captain-memo
cp /path/to/captain-memo/skills/captain-memo/SKILL.md ~/.codex/skills/captain-memo/SKILL.md
```

Codex loads the skill automatically and will call `search_all` on its own. The first tool call prompts
for approval interactively; approve it (or, for non-interactive automation, run
`codex exec --dangerously-bypass-approvals-and-sandbox …`). Verified live: Codex recalled an observation
that Claude Code had captured, from the same worker.

## Cursor

Add to `.cursor/mcp.json` (project) or the global MCP settings:

```json
{ "mcpServers": { "captain-memo": { "command": "bun", "args": ["/path/to/captain-memo/plugin/dist/mcp-server.js"] } } }
```

Then drop the skill body into `.cursor/rules/captain-memo.md` (Cursor reads project rules).

## Gemini CLI

Register the MCP server in Gemini's settings (`~/.gemini/settings.json` `mcpServers`), same command/args,
and place the skill text in `GEMINI.md`.

## opencode

opencode (MIT, model-agnostic) has no `mcp add` CLI — MCP servers, providers, and agents are all
config-file. `captain-memo connect opencode` merges `~/.config/opencode/opencode.json`: the
`captain-memo` MCP server, an `openrouter` provider (API key written as the `{env:OPENROUTER_API_KEY}`
*reference*, never a literal secret), a local runtime provider (Ollama by default; `--local-provider
vllm|lmstudio` picks another), and a permissive `captain-auto` agent for unattended sessions. The skill
is copied to `~/.config/opencode/skills/captain-memo/SKILL.md`.

## Mistral Vibe

Vibe (Apache-2.0, EU-sovereign — Devstral) reads MCP servers from `~/.vibe/config.toml` as
`[[mcp_servers]]` array-of-tables. `captain-memo connect vibe` appends one managed, marker-delimited
block — it never rewrites the rest of your TOML. Skill copied to
`~/.vibe/skills/captain-memo/SKILL.md`.

## VS Code (Copilot agent mode)

VS Code's MCP support is GA and auto-wireable. `captain-memo connect vscode` merges
`~/.config/Code/User/mcp.json` — note the top-level key is `servers`, not `mcpServers` like the other
tools. Skill copied as `~/.config/Code/User/prompts/captain-memo.instructions.md`.

## JetBrains (AI Assistant / Junie)

JetBrains configures MCP **in-IDE only** (Settings | Tools | AI Assistant | MCP) — there's no
programmatic config file to auto-wire. `captain-memo connect jetbrains` is honest about that: it writes
a paste-ready `mcpServers`-shaped snippet to `~/.config/JetBrains/captain-memo-mcp.json` (the shape
JetBrains' import expects) and copies the skill to `~/.config/JetBrains/captain-memo.md`, but you paste
the snippet in yourself.

---

**One worker, many tools.** Start the worker once (`captain-memo` installs it as a service); every tool
above connects to `localhost:39888`. They share recall; they do not each run their own store.
