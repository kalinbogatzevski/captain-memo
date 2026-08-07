# Captain Memo across AI tools (Codex, Cursor, Gemini CLI, Antigravity, opencode, Mistral Vibe, Kimi CLI, VS Code, JetBrains, …)

Captain Memo's worker is an **agent-agnostic local HTTP service**, and it ships an **MCP server**. So
*any* MCP-speaking AI coding tool can share the **same local memory corpus** — the same one Claude Code
populates. Point several tools at one worker and context one tool learned becomes available to the others.

## Which surface gives you what

Captain Memo's reach depends on the surface you work in, because passive capture and
auto-injection need a hook or an on-disk transcript — neither of which a GUI chat app has.

| Surface | Read/write | Observe | Auto-inject | Setup |
|---|---|---|---|---|
| **Claude Code** — CLI, IDE extension | Yes | Yes | Yes | install the plugin |
| **Claude Code** — desktop-app Code tab | Yes | Yes¹ | Yes¹ | install the plugin |
| **Codex** — CLI, VS Code, desktop app | Yes | Yes | No | `captain-memo connect codex` |
| **Claude Desktop chat app** | Yes | No | No | `captain-memo connect claude-desktop` |

¹ *Unverified.* Observe/auto-inject need the worker to read the Code tab's on-disk transcripts, and
those are assumed to land in `~/.claude/projects` (`CAPTAIN_MEMO_TRANSCRIPTS_DIR`) like the CLI's do.
We now have evidence against that assumption: `%APPDATA%\Claude\` on a Windows install contains a
`claude-code-sessions\` directory, suggesting the Code tab stores its transcripts under the desktop
app's own data directory instead. Until confirmed either way, treat the Code tab's observe/auto-inject
as unverified — the CLI and IDE-extension rows are unaffected.

**Work in Claude Code (CLI/IDE extension) and you get everything; the chat app gives you tools only.**

One command covers a whole tool family, not one surface: `~/.codex/config.toml` is shared by
the Codex CLI, the VS Code extension and the Codex desktop app, and all three write their
transcripts to the same `~/.codex/sessions/`, so `connect codex` wires and observes all of them.

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
`captain-memo connect <tool>` wires just one (`codex | gemini | agy | cursor | opencode | vibe | kimi | vscode | jetbrains`).
The manual steps in each section below are what `connect` does under the hood, for tools that don't have
one, want to inspect the exact config, or are on an unsupported OS.

**Added an AI tool *after* installing Captain Memo?** Just re-run `captain-memo connect` — it re-detects and
wires anything new (e.g. you had Claude Code, then installed `agy` → `captain-memo connect agy`). It's
idempotent: re-running never duplicates or clobbers your existing config.

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

## Claude Desktop (chat app)

    captain-memo connect claude-desktop

Writes an `mcpServers` entry into `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\`,
Roaming). Restart the app afterwards.

The entry names an **absolute** path to the `bun` binary. This is not cosmetic: the app launches
configured servers with a minimal PATH, so a bare `bun` works in your terminal and fails inside
the app — and it fails silently, with the server simply never starting.

Recall here is **tool-driven**: the chat app has no hook surface, so the model must choose to
search rather than having memory injected for it. There is also no passive capture — nothing
observes the conversation. Both are structural, not missing features.

## Gemini CLI

Register the MCP server in Gemini's settings (`~/.gemini/settings.json` `mcpServers`), same command/args,
and place the skill text in `GEMINI.md`.

## Antigravity CLI (agy)

`agy` is the successor to the Gemini CLI (Gemini CLI is retired for consumer tiers on 2026-06-18). It reuses
`~/.gemini/` but keeps its **own** MCP config at `~/.gemini/config/mcp_config.json`, and there is no `agy mcp add`
subcommand — so `captain-memo connect agy` writes that file directly, merging:

```json
{ "mcpServers": { "captain-memo": { "command": "bun", "args": ["/path/to/captain-memo/plugin/dist/mcp-server.js"] } } }
```

(the same top-level `mcpServers` stdio shape as Cursor's, verified against agy 1.1.0), and drops the skill in
`~/.gemini/skills/`. agy's Google sign-in is a **separate keyring OAuth**, independent of this wiring. Once wired
and signed in, an `agy` session discovers captain-memo's full memory toolset.

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

## Kimi CLI

Kimi CLI (Moonshot AI, Apache-2.0) keeps MCP servers in `~/.kimi/mcp.json` and providers/models in
`~/.kimi/config.toml`. `captain-memo connect kimi` does both: it registers the MCP server
(`kimi mcp add captain-memo -- …`) **and** writes a managed, marker-delimited block into `config.toml` — a
**local Ollama provider** plus one `[models."<id>"]` alias per model from `ollama list`. So Kimi runs
**entirely on your own machine: no Moonshot key, no `/login`** — and `kimi -m "<id>"` reaches every model
you've pulled. Foreign tables in your TOML are never touched, and re-running is idempotent (newly pulled
models simply appear). Skill copied to `~/.kimi/skills/captain-memo/SKILL.md`.

Honest about capability, by design:

- **No local Ollama models ⇒ `config.toml` is NOT written** (a `base_url`-only config would claim a
  capability you don't have). It tells you to pull a chat model and re-run.
- The root **`default_model` is kept only if it still resolves** to a declared alias — so an `ollama rm`
  can't leave Kimi pointing at a model that's gone (bare `kimi` would die with *"LLM not set"* while the
  installer claimed success).
- An **embedding model is never chosen as the default.** `ollama list` returns embedders (Captain Memo's
  own docs tell you to pull one for the embedder backend) and an embedder cannot chat.

> Note: `default_model` is a **root** TOML key — it must precede every `[section]`, or TOML makes it a key of
> the preceding table and Kimi reports *"LLM not set"*. `connect kimi` always emits it in the right place.

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
