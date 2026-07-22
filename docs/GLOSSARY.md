# Captain Memo — stats glossary

Every term shown by `captain-memo stats` and the live `captain-memo top` dashboard,
grouped by the section it appears in. Each definition is what the code actually
computes — not a paraphrase.

> Quick mental model: Captain Memo turns your coding sessions into short **observations**,
> embeds them into a searchable index, and re-ranks what it surfaces by how **useful** and
> how **durable** each memory has proven to be. The stats below measure each of those steps.

---

## Corpus

The size of the searchable index, in **chunks** (embedding-sized pieces of text).

| Term | Meaning |
|---|---|
| **memory** | Chunks from the `memory` channel — things you explicitly `remember`ed, plus promoted facts. |
| **observation** | Chunks from **observations** — the summarizer-distilled summaries of past sessions (Claude Code + captured cross-AI tools). |
| **Total** | Total chunks in the vector index across all channels. |

## Efficiency

How economical the pipeline is — how much raw material is compressed, and how much
re-work is avoided.

| Term | Meaning |
|---|---|
| **Compression** | `raw session tokens ÷ stored observation tokens`. `7.7×` means the stored memory is 7.7× smaller than the material it was distilled from. |
| **distilled A → B tok** | The raw work tokens (`A`) the summarizer read, versus the tokens (`B`) it actually stored. The `saved %` is `1 − B/A`. |
| **Embedder** | Embedding-API activity since the worker started: number of calls, average latency, throughput (tokens/sec). |
| **Dedup** | Share of documents skipped on re-index because their content hash was **unchanged** — i.e. work avoided. `42%  8 / 19 unchanged` = 8 of 19 re-seen docs needed no re-embed. |

## AI sources

One bar per originating tool, showing **which AI authored each observation**:
`claude-code`, `codex`, `agy`, `gemini`, `kimi`, `opencode`. Observations from before
cross-AI capture existed (no recorded origin) are attributed to `claude-code`.

## Recall — *how memory actually gets used*

The payoff metrics: of everything stored, how much is actually being pulled back into
sessions, and how strongly.

| Term | Meaning |
|---|---|
| **Surfaced** | An observation was **shown to Claude** by any path (see *auto / search / drill*). Counted per observation. |
| **Recalled** | Its **full text was opened** (a drill). The strongest "this was actually useful" signal — a surfaced snippet that earned a full read. |
| **Drill-in rate** | `Recalled ÷ Surfaced` — of what got shown, how often it was worth opening in full. |
| **Last surfaced** | The single most-recently-surfaced observation (the live pulse), with the path that surfaced it. |
| **Top surfaced / Top recalled** | The observations with the highest surface / recall counts. |
| **Recently surfaced** | The most recent surfacing events, newest first. |
| **auto** | Surfaced automatically by the prompt hook (injected context). |
| **search** | Surfaced by an explicit `/search`. |
| **drill** | Opened in full via `get_full` (or **Enter** in `top`). |
| **(+N)** | `N` near-duplicate observations were collapsed into this one row. |

## Tide — *memory lifecycle: recency × stability re-rank*

Tide re-ranks retrieval so that memories which have proven **durable** (repeatedly useful
over time) outrank one-off noise, and lets idle memories fade.

| Term | Meaning |
|---|---|
| **Status** | Whether Tide re-ranking is `on`. |
| **floor** | Relevance floor — the minimum relevance a hit must clear to survive the re-rank (the one bounded knob). |
| **tiering** | Phase-2 auto-tiering: whether idle memories are automatically demoted down tiers over time. |
| **Strengthened** | Observations whose **stability** has grown because a recall reinforced them (a memory earning permanence). |
| **max stability** | The highest stability any single observation has reached, in days. |
| **Tiers** | Lifecycle buckets: **active** (in play) · **dormant** (idle, deprioritised) · **archived** (aged out of normal retrieval). |

## Dream — *data feeding the Dreams pipeline*

Diagnostics for the co-retrieval / "dreaming" layer that finds relationships between
observations.

| Term | Meaning |
|---|---|
| **Audit log** | The `recall-audit.jsonl` write log — records each surfacing event. It feeds co-retrieval; `off` until you set `CAPTAIN_MEMO_RECALL_AUDIT=1` in `worker.env`. |
| **Co-retrieval** | Count of observation **pairs that co-occur** in the same retrievals, plus how many observations that covers. This is the raw signal the Dreams pipeline mines for connections. |

---

## Worker header (top of `stats`)

| Term | Meaning |
|---|---|
| **Worker** | The background service state + uptime. |
| **Indexing** | Index build progress (`done / total`). |
| **Embedder** | The embedding model + endpoint in use. |
| **Disk** | On-disk footprint of the data dir. |
| **Summarizer** | The resolved summarizer provider + model. If this isn't running, **no observations are created and cross-AI capture is disabled** — `doctor` will flag it red. |

*Seeing something not listed here? Open an issue — the glossary should cover every term on screen.*
