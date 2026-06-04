---
name: captain-memo
description: Persistent cross-session, cross-tool memory for this project via captain-memo. Use at the START of any non-trivial task to recall prior context, decisions, conventions, and past bugs/fixes, and whenever you'd ask "have we done / decided / hit this before?". Searches a shared local memory corpus (past session observations, curated project memory, skills) through the captain-memo MCP tools. Works across AI tools (Claude Code, Codex, Cursor, Gemini CLI) pointed at the same captain-memo worker.
metadata:
  short-description: Recall project memory before acting — it persists across sessions and across AI tools.
---

# Captain Memo — your persistent memory

You have a **persistent, local, cross-session memory** for this project, served by the `captain-memo`
MCP tools. It is shared across sessions AND across AI tools (Claude Code, Codex, Cursor, Gemini CLI …)
that point at the same captain-memo worker — so context one tool learned is available to the others.
It is local-first: the corpus lives on this machine, not in a vendor cloud.

## When to use it
- **At the start of any non-trivial task** — search memory first. Prior decisions, *why* something is
  the way it is, past bugs and their fixes, and project conventions all live there.
- Whenever you'd otherwise ask *"have we done this / decided this / hit this error before?"* — search
  instead of guessing.
- Before proposing a design, refactor, or a "let's just rewrite X" — check for a prior decision that
  constrains it. Overriding a past decision unknowingly is the failure this memory prevents.

## How to search (MCP tools)
- **`search_all`** — start here. Unified natural-language search across project memory + skills + past
  observations. Pass a `query`.
- **`search_observations`** — only captured session observations (what was done/learned), with
  `type` / `files` filters.
- **`search_memory`** — curated user/project memory files.
- **`get_full`** — open the full content of a hit by its `doc_id`. Search returns *truncated snippets*;
  when a hit looks relevant, drill in with `get_full` before relying on it.

## How to use the results
- Treat retrieved memory as **authoritative project context**: cite it ("per prior memory, X was decided
  because Y") and let it constrain your plan.
- If memory conflicts with the current request, **surface the conflict** — don't silently override a
  recorded decision.
- Recall is the contract here. New learnings are captured automatically by the session's memory hooks
  where they run (e.g. Claude Code); you don't need to write memory yourself.
