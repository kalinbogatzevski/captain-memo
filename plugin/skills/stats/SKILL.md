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

The response includes: `total_chunks`, `by_channel`, `observations` (total/queue_pending/queue_processing), `indexing` (status/done/total/percent/elapsed_s/errors/last_error), `project_id`, `embedder` (model/endpoint), `efficiency`, and `worker` (`started_at_epoch`, `uptime_s`).

A successful `/stats` response means the **backend worker is ONLINE** — lead with that
and its uptime. Format `worker.uptime_s` compactly: `45s` / `12m` / `2h 13m` / `3d 4h`.
If the `curl` fails / connection refused, the worker is **OFFLINE** — say so and point
the user at `captain-memo doctor` (see "On error").

## Output format

```
Captain Memo — corpus statistics
────────────────────────────────
  Worker:         ● online · up 2h 13m
  Project:        <project_id>
  Indexing:       ready (or "indexing 47/275 (17%) ETA=3m 12s")
  Total chunks:   <total>
  By channel:
    memory          <count>
    skill           <count>
    observation     <count>
  Observations:   <total> · <pending> pending · <processing> processing
  Embedder:       <model> @ <endpoint>

Efficiency
──────────
  Compression:    16.4× — distilled 184,320 tokens of work into 11,240 stored
                  (94% saved · based on 312/340 observations)
  Embedder:       47 calls · ~690 ms avg · 4,100 tok/s   (since worker start)
  Dedup:          95% of docs skipped re-embed (488/512 unchanged)
```

The `efficiency` block reports corpus compression (summed observation
`work_tokens` vs `stored_tokens`), embedder throughput, and dedup hit-rate.
If compression shows "— (run 'captain-memo reindex' …)", the corpus has no
`work_tokens` data yet — reindex to populate it.

If `indexing.status === "indexing"`, show the progress in yellow with rate and ETA. If `"ready"`, show in green with "indexed N/N in M". If `"error"`, show the last_error in red.

## On error

Worker unreachable → tell the user `captain-memo doctor` to check.
