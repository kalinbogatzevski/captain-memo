---
name: observations
description: List recent captured session observations (the Haiku-summarized voyage logs). Use when the user wants to see what Captain Memo has logged from past sessions.
---

# Captain Memo — recent observations

When the user invokes this skill, they want a quick view of recent session observations — the structured "voyage logs" the Stop hook produces.

## What to do

1. Parse the user's argument as `--limit N` (default 20). If they typed `/captain-memo:observations 50`, treat 50 as the limit.
2. Run:

```bash
curl -s "http://127.0.0.1:39888/observations/recent?limit=<LIMIT>" | jq '.'
```

3. The response is `{ items: [{id, session_id, prompt_number, type, title, created_at_epoch}] }`.

## Output format

```
Recent observations (N total):

  2026-05-07 14:32  [bugfix    ]  Fix off-by-one in billing pro-ration loop
                    session=ses_..._abc123 · prompt#1 · id=42

  2026-05-07 14:18  [feature   ]  Add NetLine SPM rule 75 for Pernik discount
                    session=ses_..._xyz890 · prompt#3 · id=41

  …
```

Format `created_at_epoch` as a UTC date in the user's timezone. Pad `[type]` to 10 chars for alignment.

## If empty

Say something like:
> "No observations yet. Captain Memo's `Stop` hook summarises sessions when they end — make sure you've actually closed (`/exit`) at least one Claude Code session since installing, and that `ANTHROPIC_API_KEY` or `claude-code` summarizer is configured. Run `captain-memo doctor` to verify."
