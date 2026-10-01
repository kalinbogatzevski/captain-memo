---
name: recall
description: Print the full content of a single Captain Memo hit by its doc_id. Used after /captain-memo:search to expand a snippet into the full source.
---

# Captain Memo — recall full content by doc_id

When the user invokes this skill, they want the *full* text of a previously-found hit, not just a snippet.

## What to do

1. Take the user's argument as the doc_id (e.g. `memory:feedback_no_mocked_db:abc1234`).
2. Call the captain-memo MCP tool `get_full` with `doc_id` set to that value. The MCP server sends the worker's secret for you: there is no token to handle.
3. Format the response. The body is `{ content: "...", metadata: {...} }`.

## Output format

Show the source path from `metadata.source_path` first as a header, then the full `content`, then a small footer with notable metadata (memory_type, created_at_epoch as a date if present, etc.).

```
📄 ~/.claude/projects/.../memory/feedback_no_mocked_db.md
   type: feedback · 2026-04-15

In this project, **do NOT** mock the database in integration tests: they
must run against a real test database.

[…full content…]
```

## On error

- 404 not_found: tell the user "no document with that doc_id — was the search recent? Try `/captain-memo:search` again to get fresh doc_ids"
- 401: the call carried no valid worker secret (a session started before 0.52.0 sends none). Tell the user to restart the AI session; `captain-memo doctor` lists the routes still called without one
- worker unreachable: `captain-memo doctor` to diagnose
