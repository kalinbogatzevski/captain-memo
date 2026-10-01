---
name: observations
description: List recent captured session observations (the summarized voyage logs). Use when the user wants to see what Captain Memo has logged from past sessions.
---

# Captain Memo — recent observations

When the user invokes this skill, they want a quick view of recent session observations — the structured "voyage logs" the Stop hook produces.

## What to do

1. Parse the user's argument as `--limit N` (default 20). If they typed `/captain-memo:observations 50`, treat 50 as the limit.
2. Run:

```bash
captain-memo observation list --limit <LIMIT>
```

The CLI sends the worker's secret for you: there is no token to handle. If `captain-memo` is not on PATH, use the shim and checkout fallbacks described in the `doctor` skill. With no CLI at all (a plugin-only install), call the MCP tool `search_observations` with a query instead; it has no plain "recent" listing.

3. Pass the output back as it is. It is one line per observation, newest first, then a row count.

## Output format

```
Recent observations
---
2026-05-07T14:32:10  [bugfix    ]  Fix off-by-one in pagination loop
2026-05-07T14:18:44  [feature   ]  Add retry to the embed call on HTTP 429
(2 rows)
```

The timestamp is UTC. For a hit worth reading in full, `search_observations` or `search_all` returns its `doc_id` and `get_full` opens it.

## If empty

Say something like:
> "No observations yet. Captain Memo's `Stop` hook summarises sessions when they end — make sure you've actually closed (`/exit`) at least one Claude Code session since installing, and that a summarizer is configured — `captain-memo stats` shows which one is live, `captain-memo doctor` says why it is not."
