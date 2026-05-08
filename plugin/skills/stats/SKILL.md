---
name: stats
description: Show Captain Memo's corpus statistics (chunks per channel, observation counts, indexing progress, embedder info). Use when the user types /captain-memo:stats.
---

# Captain Memo — corpus stats

When invoked, fetch the worker's `/stats` endpoint and present it readably.

## What to do

```bash
curl -s http://127.0.0.1:39888/stats
```

The response includes: `total_chunks`, `by_channel`, `observations` (total/queue_pending/queue_processing), `indexing` (status/done/total/percent/elapsed_s/errors/last_error), `project_id`, `embedder` (model/endpoint).

## Output format

```
Captain Memo — corpus statistics
────────────────────────────────
  Project:        <project_id>
  Indexing:       ready (or "indexing 47/275 (17%) ETA=3m 12s")
  Total chunks:   <total>
  By channel:
    memory          <count>
    skill           <count>
    observation     <count>
  Observations:   <total> · <pending> pending · <processing> processing
  Embedder:       <model> @ <endpoint>
```

If `indexing.status === "indexing"`, show the progress in yellow with rate and ETA. If `"ready"`, show in green with "indexed N/N in M". If `"error"`, show the last_error in red.

## On error

Worker unreachable → tell the user `captain-memo doctor` to check.
