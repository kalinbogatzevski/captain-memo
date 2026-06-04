# Captain Memo across AI tools (Codex, Cursor, Gemini CLI, …)

Captain Memo's worker is an **agent-agnostic local HTTP service**, and it ships an **MCP server**. So
*any* MCP-speaking AI coding tool can share the **same local memory corpus** — the same one Claude Code
populates. Point several tools at one worker and context one tool learned becomes available to the others.

It's two pieces per tool:

1. **Register the MCP server** → the tool gets `search_all`, `search_observations`, `search_memory`,
   `get_full`. The MCP server is a thin stdio bridge that talks to your running worker on
   `http://localhost:39888`, so every tool reuses the **same worker and corpus** — nothing is duplicated.
2. **Install the skill** (`skills/captain-memo/SKILL.md`) into the tool's skills/rules directory → it
   tells the model *when* to recall (search at task start; "have we decided/hit this before?").

The MCP tools are **read-only/recall** (search + drill). Capture is automatic where the tool has
lifecycle hooks (Claude Code today); other tools recall the shared memory that Claude Code and the
session hooks write.

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

---

**One worker, many tools.** Start the worker once (`captain-memo` installs it as a service); every tool
above connects to `localhost:39888`. They share recall; they do not each run their own store.
