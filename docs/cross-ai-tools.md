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
| **Codex CLI** | Yes | Yes — native hooks when enabled, rollout fallback otherwise | Yes — native hooks | `captain-memo connect codex` |
| **Gemini CLI** | Yes | Yes — native hooks when supported, transcript fallback otherwise | Yes — native hooks | `captain-memo connect gemini` |
| **Kimi CLI** | Yes | Yes — native hooks on 1.28+, transcript fallback otherwise | Yes — native hooks on 1.28+ | `captain-memo connect kimi` |
| **Antigravity (`agy`)** | Yes | Yes — transcript capture | No | `captain-memo connect agy` |
| **opencode** | Yes | Yes — transcript capture | No | `captain-memo connect opencode` |
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
Native-hook auto-injection is guaranteed only where the Codex host executes `~/.codex/hooks.json`;
the shared rollout reader still observes the other surfaces.

It's two pieces per tool:

1. **Register the MCP server** → the tool gets memory recall, `list_skills` / `recommend_skills` / `load_skill`,
   `list_capabilities` / `recommend_capabilities` / `get_capability`,
   the work-coordination tools `work_set`/`work_active`/`work_clear`, and the homework tools
   `todo_add`/`todo_list`/`todo_claim`/`todo_done`. The MCP server is a
   thin stdio bridge that talks to your running worker on `http://localhost:39888`, so every tool reuses
   the **same worker and corpus** — nothing is duplicated.
2. **Install the skill** (`skills/captain-memo/SKILL.md`) into the tool's skills/rules directory → it
   tells the model *when* to recall and when to ask Captain Memo for a specialized skill.

Captain Memo imports each discovered `SKILL.md` losslessly into a first-class SQLite registry while
also indexing searchable chunks. The row keeps its CLI provenance, content hash, and portability
warnings. Because it lives in `meta.sqlite3`, ordinary backup/restore includes it automatically;
merge-import of two corpora remains a separate, future operation.

Humans can browse the same repository with `captain-memo skill list` (or add `--source codex` and
`--json`). Connected AIs call `list_skills` for the local catalog, then `load_skill` with a returned
`doc_id`; `recommend_skills` is the task-ranked route when browsing everything would be wasteful.

This is also a project milestone: it is the first Captain Memo feature built with Codex rather than
Claude, with Captain Memo's shared memory supplying the accumulated architecture, decisions,
conventions, and release process instead of requiring the maintainer to explain them again.

Plugin wrappers remain runtime-specific. Captain Memo publishes only a secret-free capability card
(descriptions, operation/interface names, and runtime ownership), never executable plugin content or
environment values. That lets Codex discover that Nano Banana can generate an image on Gemini, for
example, and route/delegate the task there instead of claiming the extension was imported into Codex.

The MCP tools provide recall, persistence, skill/capability discovery, and coordination. Capture is
automatic: Captain Memo installs useful native lifecycle hooks for Codex, Gemini CLI, and Kimi when
the installed CLI advertises support, while keeping the existing transcript/rollout source armed as
a compatibility fallback. A session is considered native only after its PostToolUse event reaches
the worker, so an untrusted, disabled, or broken hook cannot silently turn fallback capture off.

### Native hook compatibility

| Runtime | Native contract used | Captain Memo behavior |
|---|---|---|
| Codex CLI | Stable `hooks` feature; `UserPromptSubmit`, `PostToolUse`, `Stop` | Probes `codex features list`; installs only when the effective value is `true`. Older or explicitly disabled installs keep rollout capture. Review the managed hooks once in `/hooks`. |
| Gemini CLI | Experimental hooks; `BeforeAgent`, `AfterTool`, `AfterAgent` | Probes `gemini hooks --help`, enables the two vendor-required settings, and preserves foreign hook groups. Older releases keep transcript capture. |
| Kimi CLI | Beta hooks introduced in 1.28.0; `UserPromptSubmit`, `PostToolUse`, `Stop` | Version-gated because Kimi exposes no feature-list command. Older releases keep transcript capture. |
| Antigravity (`agy`) | Hooks exist in 1.1.11, but documented `PostToolUse` omits tool input and result | Keeps its persisted conversation capture; installing a lossy native hook would produce worse observations. |
| Ollama | Model server/API with tool calling, not an agent lifecycle host | No direct hook is installed. Captain Memo observes the host agent (for example Kimi or opencode) that runs the Ollama-backed loop. |

The detailed contract audit and upgrade rules live in
[Native lifecycle capture](native-lifecycle-capture.md).

**The fast path: `captain-memo connect`.** Every tool below except JetBrains can be wired automatically (for JetBrains it writes a snippet you paste in the IDE) —
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

Codex loads the skill automatically and will call `search_all` on its own. Verified live: Codex
recalled an observation that Claude Code had captured, from the same worker.

On current Codex versions, `captain-memo connect codex` also merges three managed commands into
`~/.codex/hooks.json`. The prompt hook injects recall automatically, PostToolUse feeds observations
without waiting for the rollout to go idle, and Stop flushes the session. Foreign hooks and top-level
settings are preserved. Codex asks you to review newly discovered hooks once in `/hooks`; until a
Captain Memo hook actually succeeds, rollout capture remains active.

**Registering the server is not enough to make it work non-interactively — `captain-memo connect
codex` also pre-approves the tools, and here is why.** Codex gates every MCP tool call behind an
approval elicitation. In the TUI you answer it; under `codex exec` there is no one to answer, so the
call is rejected in ~13 ms with `user cancelled MCP tool call`. The failure is silent in the worst
way: the skill still loads and still tells the model to recall, so the agent believes it has memory,
gets none, and carries on. Anyone scripting `codex exec` in CI or a pipeline hits this.

The approval is stored **per tool** in `~/.codex/config.toml`, in codex's own shape — it is exactly
what codex writes when you pick *"Always allow"* in the TUI:

```toml
[mcp_servers.captain-memo.tools.search_all]
approval_mode = "approve"
```

`connect codex` appends one such block per tool, adding only headers that are absent so your
config.toml is never rewritten or reflowed. Note there is **no server-level switch**: a
`[mcp_servers.captain-memo] approval_mode = …` is rejected by `codex --strict-config` as an unknown
field, which is why it has to be enumerated.

Do **not** reach for `--dangerously-bypass-approvals-and-sandbox` for this. It disables approvals
*and* the sandbox for everything in that run, which is a far larger grant than "let captain-memo read
my memory", and `-a never` / `approval_policy = "never"` do not help — the MCP elicitation is a
separate gate from the shell-command approval policy.

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

When `gemini hooks --help` confirms support, `connect gemini` also installs `BeforeAgent`, `AfterTool`,
and `AfterAgent` commands in that same settings file. It enables Gemini's two currently required
experimental flags and preserves unrelated settings and hooks. Unsupported versions remain fully
usable through MCP plus the existing session transcript reader.

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

Agy 1.1.11 has named lifecycle hooks, but its documented PostToolUse event carries only step/error
metadata rather than the executed tool input and result. Captain Memo therefore keeps the conversation
database reader instead of advertising a lower-fidelity native observation path.

## goose

[goose](https://github.com/block/goose) is Block's open-source coding agent. It loads MCP servers as
**extensions**, and there is no non-interactive way to register one: `goose configure` is a TUI that takes
no arguments, `goose plugin install` only accepts git repositories, and `goose mcp <SERVER>` runs a *bundled*
server. So `captain-memo connect goose` edits goose's `config.yaml` directly, merging one entry under the
top-level `extensions:` map:

```yaml
extensions:
  captain-memo:
    name: captain-memo
    cmd: bun
    args:
      - /path/to/captain-memo/plugin/dist/mcp-server.js
    enabled: true
    envs: {}
    type: stdio
    timeout: 300
```

Your other extensions and goose's own top-level keys (`GOOSE_PROVIDER`, `GOOSE_MODEL`, …) are preserved;
re-running reports `already registered` and leaves the file byte-identical. Comments are not preserved —
any parse-then-write round-trip loses them, and goose authors this file itself via `goose configure`.

**Where the file lives depends on the OS**, because goose resolves it through the `etcetera` crate's
per-platform app strategy:

| Platform | `config.yaml` |
|---|---|
| Linux | `$XDG_CONFIG_HOME/goose/` → `~/.config/goose/` |
| macOS | `~/Library/Application Support/Block.block.goose/` |
| Windows | `%APPDATA%\Block\goose\config\` |
| any | `$GOOSE_PATH_ROOT/config/` when that variable is set to an **absolute** path (it overrides all of the above; goose ignores relative values, and so do we) |

`connect goose` probes all of these and uses whichever already exists, falling back to the platform default
for a first-time write. Verified on goose 1.45.0: `goose info` reports the Linux path exactly. The macOS and
Windows layouts are derived from goose's `paths.rs` and etcetera's sources, not yet observed on a real machine
— which is precisely why it probes rather than trusting one answer.

**The skill is deliberately not installed.** `goose skills list` shows goose reads `~/.claude/skills/`, which
is Claude Code's directory — Claude Code already gets this skill from the plugin install, so writing there to
serve goose would plant a second copy in another tool's skill set. `connect goose` reports `skill skipped`
rather than reaching into a neighbour's config.

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

Kimi 1.28.0 and newer also receive a managed `[[hooks]]` block for automatic recall, immediate
PostToolUse observation capture, and Stop flushing. Older Kimi releases keep the transcript reader;
re-running `connect kimi` after an upgrade adds the native path automatically.

Honest about capability, by design:

- **No local Ollama models ⇒ no managed Ollama provider/model block is written** (a `base_url`-only
  block would claim a capability you don't have). On Kimi 1.28+, `config.toml` may still receive the
  independent native-hooks block. It tells you to pull a chat model and re-run for local inference.
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
