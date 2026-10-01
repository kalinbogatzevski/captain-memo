---
name: search
description: Hybrid search across Captain Memo's local memory + skills + observations. Use when the user types /captain-memo:search <query> to retrieve top hits without the model having to decide whether to call search_all on its own.
---

# Captain Memo — direct search

When the user invokes this skill, they want a direct hybrid search against Captain Memo's local index. Don't reason about it — just run it.

## What to do

1. Take the user's argument as the query string (everything after `/captain-memo:search `).
2. Call the captain-memo MCP tool `search_all` with `query` set to that string and `top_k` set to `5`. Show the user the formatted result.

The MCP server talks to the worker and sends the worker's secret for you: there is nothing to quote and no token to handle.

The result is `{ results: [{ score, channel, title, doc_id, snippet, ... }] }`. Show `score` to two decimals and cut each `snippet` to about 200 characters.

## Format the output as

```
3 hits for "the user's query":

[0.94] memory · feedback_no_mocked_db
   doc_id: memory:feedback_no_mocked_db:abc1234
   In this project, do NOT mock the database in integration tests…

[0.87] memory · feedback_use_real_fixtures
   doc_id: memory:feedback_use_real_fixtures:def5678
   …

[0.82] observation · 2026-04-30 · "Fix off-by-one in pagination loop"
   doc_id: observation:1700000000:ghi9012
   …
```

Tip the user: they can run `/captain-memo:recall <doc_id>` to fetch the full content of any hit.

## On error

- The tool errors with 503 or the worker is not reachable: tell the user to run `captain-memo doctor` to diagnose
- The tool errors with 401: the call carried no valid worker secret (a session started before 0.52.0 sends none). Tell the user to restart the AI session; `captain-memo doctor` lists the routes still called without one
- Empty results: say "no hits — try a more specific query, or check `captain-memo stats` to confirm the corpus is indexed"
