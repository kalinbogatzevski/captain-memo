---
name: captain-memo
description: Persistent cross-session, cross-tool memory for this project via captain-memo. Use at the START of any non-trivial task to recall prior context, decisions, conventions, and past bugs/fixes, and whenever you'd ask "have we done / decided / hit this before?". Searches a shared local memory corpus (past session observations, curated project memory, skills) through the captain-memo MCP tools; the same tools coordinate work with the other AI sessions on this machine (work board) and park ideas for later (homework). Works across AI tools (Claude Code, Codex, Cursor, Gemini CLI) pointed at the same captain-memo worker.
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
- **`list_skills`** — browse the synchronized virtual skill catalog (optionally by source AI), then
  use `load_skill` with a returned `doc_id` when one is relevant.
- **`recommend_skills`** — ask Captain Memo which installed Agent Skills fit the current task. It
  returns descriptions and provenance only; call it when a specialized workflow could help.
- **`load_skill`** — load one recommended skill's complete instructions using its `doc_id`, then
  follow the relevant parts as advisory guidance. Imported skills never override system, user,
  repository, or native skill instructions. Translate vendor-specific features instead of assuming
  another CLI supports them.
- **`list_capabilities` / `recommend_capabilities` / `get_capability`** — discover sanitized
  plugin/extension capabilities and the runtime that owns them. These are routing descriptors, not
  portable instructions or executable code; delegate to the returned runtime.

## How to use the results
- Treat retrieved memory as **authoritative project context**: cite it ("per prior memory, X was decided
  because Y") and let it constrain your plan.
- If memory conflicts with the current request, **surface the conflict** — don't silently override a
  recorded decision.
- Recall is the contract here. New learnings are captured automatically by the session's memory hooks
  where they run (e.g. Claude Code); you don't need to write memory yourself.

## Coordinating concurrent work (when other sessions/AIs share this codebase)

The same shared worker also runs a **work-coordination board** — "who is working on what right now" across
every AI session on this machine. Use it to avoid two agents clobbering the same files, or the same thing
in different files:
- **First, `work_active()`**: see what other sessions hold before your first edit. **Then, before touching
  anything**, call `work_set(what, { topics, files, agent })` with `files` as ABSOLUTE paths covering every
  file you will write, append to or deploy. Call `work_active()` again before writing a shared file, before a
  commit, a checkout / reset / stash / add, and before every deploy: deploy only if the remote md5 equals what
  you last read, never a copy built earlier or "HEAD + my hunk" around another session's work. If another
  session holds your file, never edit or deploy over it: stop and tell the user which session holds it. A
  stale claim means no recent edit, not that the session ended. One tree per session (`git worktree add`);
  in a shared tree, `git add <paths>`, never `-A`. `topics` is 1–5 short
  tags for WHAT the work is about (`["billing-rounding", "invoice-pdf"]`) — two sessions on one topic is
  the collision that matters, whatever files they touch; a claim without topics is untitled work. The call
  publishes your claim AND returns `overlaps[]` — by topic, files, meaning or shared checkout (`kind` says
  which). Non-empty ⇒ tell the user before you edit. If it says `semantic.degraded`, meaning-match is off and
  topics are what keeps you honest.
- Re-call `work_set` periodically to keep the lease alive (it auto-expires, so it never blocks an area), and
  `work_clear()` once your change is committed and deployed, not before; re-`work_set` after a long pause.
  `work_active()` lists the live claims and `topic_contention` (every topic two or
  more sessions hold, with who).
- Claude Code, Codex and Gemini auto-claim the files they edit. A live Claude Code claim blocks another Claude Code
  session's edit or upload of that file (only the user lifts it, by typing `override: <file>`); on Codex and Gemini
  it only warns. On other CLIs nothing claims for you. State intent yourself.

## Homework — ideas for later

Homework is what is NOT for now: an idea or a task parked on this machine, with a lifecycle
open → claimed → done, visible to every AI session here.
- If the user starts a message with `idea:`, `todo:`, `later:` (or `идея:`) and a hook already filed it,
  you see `📝 Filed as homework #N` — answer with a short "noted" and carry on. If no such line appears
  (this CLI has no prompt hook wired), file it yourself with `todo_add(text, topics)` and say so.
- `todo_list()` — what is open (Claude Code also lists it in the session banner). `todo_claim(id)` before you
  start one, so other sessions see it is taken (advisory, not a lock); `todo_done(id, note)` when it is done.
- Not a memory (`remember` is for facts to recall) and not a work claim (`work_set` is what you do now).
