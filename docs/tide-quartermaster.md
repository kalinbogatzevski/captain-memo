# Tide & Quartermaster — Memory Lifecycle for captain-memo

> Design note · 2026-06-05 · federation-private roadmap (Track A7). The capability itself is
> federation-free — a local memory-quality feature — and public-shippable when built. Synthesized
> from research on Generative Agents (Park et al., UIST 2023), FSRS/Ebbinghaus spaced-repetition,
> and the artel prior art, then adversarially reviewed against this codebase's invariants.

## Motivation

captain-memo's observation channel grows without bound — today's corpus already holds tens of thousands of auto-captured chunks, and the summarizer keeps that flow cheap (`stored_tokens << work_tokens`) but never sheds anything. Every chunk competes equally in retrieval forever, so stale context dilutes the hybrid ranker and a genuinely fresh, frequently-recalled fact carries no more weight than a dead one captured once a year ago. Prior art has two answers. **artel** computes `heat = read_count × 0.9^(weeks_since_read)`, heat-protects some entries, and runs a background "archivist" LLM. **Generative Agents** (Park et al., UIST 2023) ranks each memory by `recency × importance × relevance` with recency on an exponential decay reset on every access. Both are good ideas built for the wrong substrate: artel's heat multiplies count and decay with no notion of a memory *getting more durable* each time it's recalled, and Generative Agents resets recency on *every* access — fatal here, where the bulk of accesses are noisy `source=auto` co-occurrence bumps.

We differentiate on three things this codebase already gives us. First, retrieval is **hybrid RRF** (dense KNN + BM25 fused by Reciprocal Rank Fusion) — relevance is sacred and Tide must never weaken it, so buoyancy is a *bounded post-fusion re-rank multiplier*, never an input to the fusion math. Second, we are **loopback-only** (the worker binds `localhost:39888`); buoyancy is derived from *this node's* recall behaviour and is meaningless on a peer, so it never crosses federation. Third — and this is the lever — captain-memo **already increments a per-row retrieval counter with a source** (`from_auto`/`from_search`/`from_drill`) plus a `last_surfaced_at` stamp on every hit. The entire lifecycle model can be built on columns we already write, adding nothing to the metered (embedding) path. This note specifies **the Tide** (the lifecycle model) and **the Quartermaster** (the crew-process that drives it and curates the corpus).

---

## The Tide

### Model

Tide is a per-row, **query-independent** lifecycle signal. It answers "how afloat is this memory in its own right?" — separately from "how relevant is it to *this* query?", which stays entirely inside RRF. A memory's **buoyancy** = `f(recall recency, recall frequency)`. Disused memories **ebb**: they sink in ranking, then transition to a dormant state, then to an archived state — but are *never auto-deleted*. A recall makes a memory **surface** again. Pinned directives and the curated `memory`/`skill` channels are **anchored** — they never ebb. Stable, repeatedly-recalled clusters get promoted by the Quartermaster to a **chart** entry.

The core upgrade over both prior-art systems is the **two-component (DSR / Ebbinghaus–FSRS) split**: we store a slow-moving **stability** `S` (resistance to forgetting; *only ever increases*, only on recall) separately from the fast **buoyancy** (current retrievability; decays with time). This is what makes "one recall fully surfaces a long-dormant memory" work cleanly — the row's `S` survived the dormancy, so a single hit lifts it right back up. artel's flat heat cannot express this; Generative Agents' recency-only term cannot either.

### Buoyancy formula

All inputs already exist on the `observations` row. Let `age_days = (now − last_surfaced_at) / 86400` (fall back to `created_at_epoch` when `last_surfaced_at IS NULL`), and `S = stability_days` (when `NULL`, seed from the channel default below).

**Observation channel — FSRS power-law** (fat tail, so ancient context sinks but never underflows to 0, keeping a drill able to resurface it):

```
buoyancy = (1 + W20 · age_days / S) ^ (−1)        # W20 ≈ 0.15
```

**memory / skill** — these are anchored in practice, but if ever un-anchored use the simple exponential `exp(−ln2 · age_days / S)`.

**Per-channel initial stability `S0` (days):** observation `7`, memory `60`, skill `180`, pinned-directive `+∞`. (Calibration anchors: Generative Agents' `0.995^hours ≈ exp(−t/S)` with `S ≈ 8.3d` ≈ our observation `S0=7`; artel's weekly `0.9` ≈ daily `0.985`.)

**Stability update on recall** (the spaced-repetition strengthening — runs **only on the writer**, folded into the existing `bumpRetrieval` UPDATE so it stays a single statement). Let `R` = the row's buoyancy *just before* this bump:

```
S_new = S · (1 + exp(W6) · fD · fS · fR · g(source))
  fR = exp(W7 · (1 − R))            # desirable difficulty: a recall that rescues a
                                    #   near-dormant row is worth far more than one on a fresh row
  fS = 1 / (1 + exp(W8·(S − W9)))   # saturation: hot rows plateau, can't starve the corpus
  fD = (11 − D) / 10                # difficulty proxy from channel (+penalty if contradiction-flagged)
  g(source) ∈ { auto: 0.5, search: 1.0, drill: 1.5 }   # a deliberate drill strengthens most
```

The source weighting (`g`) is the popularity-loop defence: `auto` is the system's *own output* (auto-injection co-occurrence), so it must not be able to keep a dead row afloat by itself. The desirable-difficulty term `fR` plus saturation `fS` together kill the recency-runaway that artel's count-based heat suffers.

> **Important:** buoyancy is **computed on read**, never materialised as a stale column. Only `stability_days` and `tide_state` persist. Materialising buoyancy would require a writer sweep over the whole corpus every tick (a heartbeat risk) and would drift with wall-clock between sweeps.

### Ebb / surface / anchored / chart semantics

State machine `active → ebbing → dormant → archived`, with **hysteresis** (a band, so a single recall doesn't flap a row in and out) and a non-negotiable protection gate. All transitions are **auto and reversible**; only a hard delete crosses the confirm line, and it is never automatic.

- **ebb (active → dormant)** only when *all* hold: `buoyancy < T_ebb` (default `0.30`) **AND** `from_drill = 0` **AND** `age_days > AGE_FLOOR` (default `90`) **AND** not anchored. The `from_drill = 0` clause is the **rare-but-critical-fact gate** — *any* explicit drill (`get_full`) ever recorded makes the row permanently ineligible for auto-dormancy. It costs nothing (the counter already exists) and is the single most important guardrail in the whole design.
- **dormant → archived** only when `buoyancy < T_archive` (default `0.05`) **AND** `age_days > ARCHIVE_AGE` (default `180`) **AND** `from_drill = 0`.
- **surface (dormant/archived → active)** is instant on any matching recall: `bumpRetrieval` advances `last_surfaced_at` → buoyancy jumps → when it crosses `T_surface` (default `0.70`, the hysteresis upper rail) the row flips back to active in the same writer tick.
- **anchored** rows (channel ∈ {memory, skill}, or an observation with `is_anchored = 1`) short-circuit the entire formula: `S = +∞`, `buoyancy = 1`, multiplier `= 1.0`. They never ebb. This is artel's "heat-protected" idea but **declarative** (by channel/pin), so a popularity dip can never erode it.
- **archived → DELETE: never automatic.** Deletion is a CONFIRM-gated CLI op with backup + undo only.

**Critical contract — dormant means demoted, not deindexed.** A dormant or archived row *stays in the FTS5 and sqlite-vec indexes*. It is excluded from the default auto-injection candidate set and multiplied down in explicit `/search` ranking, but a deliberate `/search` or `/get_full` can always hit it, and one hit re-surfaces it. If "dormant" were implemented by dropping the row from the index, the recall-surfaces contract would break — so Tide dormancy must **not** route through the existing `dropArchived` filter (see Risks).

### Exact RRF integration (bounded boost, never overrides relevance)

Today, `searchWithRecency` (index.ts:809) runs `applyRecencyDecay` (index.ts:787), which multiplies the fused score by `exp(−ln2 · age / 90d)` for observation rows only. Tide **replaces that one function** with the same multiply-the-fused-score shape, generalised:

```
final = rrf_fused_score · (B0 + (1 − B0) · buoyancy)     # B0 (relevance floor) default 0.30
```

Anchored rows multiply by `1.0`. The multiplier is bounded to `[B0, 1] = [0.30, 1.0]`. Consequence: a top-relevance but stale hit (`buoyancy ≈ 0`) is multiplied by `0.30` — it drops, but **cannot be buried under a fresh-but-irrelevant hit** unless that hit's raw RRF score is within ~3.3× of it. Relevance always dominates; Tide only breaks ties and demotes stale-equivalents. Today's flat decay is the special case `B0 = 0, S = 90d, no stability` — Tide generalises it and *raises the floor* so relevance can never be zeroed.

It composes multiplicatively and order-independently with the existing identifier/branch boosts in `rerank.ts`: `final = rrf · idBoost · branchBoost · tideMultiplier`. The dense KNN distance, the BM25 score, and the RRF `k`-fusion are **byte-for-byte untouched** — and nothing is re-embedded.

**Two integration gotchas that must be fixed when wiring this (both verified in the current code):**

1. **Cross-store join.** `applyRecencyDecay` today reads `created_at_epoch` from the *meta chunk* (meta.sqlite3), and performs **zero** reads against `observations.db`. But buoyancy needs `last_surfaced_at`, `stability_days`, `from_*`, `tide_state`, `is_anchored` — which live *only* in `observations.db`. The reranker must call one **batched** accessor `tideRowsAmong(ids)` (a single `WHERE id IN (…)`, exactly like the existing `archivedAmong` at observations-store.ts:586), compute buoyancy in JS over the returned map, and short-circuit memory/skill to `1.0` before the join so anchored channels incur zero lookups. Per-hit `findById` on the hot path would be N round-trips inside the ~2s hook budget — do not do that.

2. **Truncation order.** `HybridSearcher.search()` already does `fused.slice(0, topK)` *internally* (search.ts:108/111) **before** `applyRecencyDecay` runs. So today's decay re-ranks an already-truncated list — and a near-dormant but exactly-relevant row a drill should rescue can be cut at the fusion `slice` before Tide ever sees it, silently breaking the resurface contract. **Apply the Tide multiplier to the full fused pool *before* truncation** (`searchByChannel` already pulls `candidatePool = max(topK·20, 200)`; move the multiply inside `search()` right after `applyBoosts` and truncate after, or return the untruncated reranked list and truncate in the index layer).

### Data model (migration v8 — additive, idempotent-recoverable, readers never mutate)

Mirrors the existing v1–v7 ALTER pattern; partial index follows the v6 `idx_obs_archived … WHERE archived = 1` trick so the default (`tide_state = 'active'`) path stays index-free.

| Column / object | Definition | Purpose |
|---|---|---|
| `stability_days REAL` | nullable; `NULL` ⇒ use channel `S0` | DSR stability; recall-only-up; written only on writer inside `bumpRetrieval` |
| `tide_state TEXT NOT NULL DEFAULT 'active'` | one of `active` \| `dormant` \| `archived` | Lifecycle tier — **separate from** the v6 `archived` dedup flag |
| `tide_state_changed_at INTEGER` | epoch seconds | Audit trail + hysteresis dwell-time |
| `is_anchored INTEGER NOT NULL DEFAULT 0` | `1` only for a pinned/directive *observation* | Channel-derived anchoring (memory/skill) needs no column |
| `CREATE INDEX idx_obs_tide_state … WHERE tide_state != 'active'` | partial index | Keeps the dormant/archived minority cheap to scan |

**Reused, no new column:** `last_surfaced_at` (v5) is the recency stamp; `from_auto/from_search/from_drill` (v5) are the frequency + source signal; `last_surfaced_source` (v7) names the most-recent path for `g(source)`; `created_at_epoch` (v1) is the age-floor input.

### Config (env vars + defaults)

| Var | Default | Meaning |
|---|---|---|
| `CAPTAIN_MEMO_TIDE_ENABLED` | `0` (dark-launch) | Master switch; `0` falls back to today's flat `applyRecencyDecay` |
| `CAPTAIN_MEMO_TIDE_RELEVANCE_FLOOR` | `0.30` | `B0` — higher ⇒ Tide matters less, relevance even more dominant |
| `CAPTAIN_MEMO_TIDE_S0_OBSERVATION_DAYS` / `_MEMORY_DAYS` / `_SKILL_DAYS` | `7` / `60` / `180` | Per-channel initial stability |
| `CAPTAIN_MEMO_TIDE_W20` | `0.15` | FSRS power-law shape |
| `CAPTAIN_MEMO_TIDE_SRC_AUTO` / `_SEARCH` / `_DRILL` | `0.5` / `1.0` / `1.5` | `g(source)` — popularity-loop defence |
| `CAPTAIN_MEMO_TIDE_STAB_W6..W9` | FSRS-6 seeds | Strengthening coefficients (re-tunable, never magic constants) |
| `CAPTAIN_MEMO_TIDE_EBB_THRESHOLD` / `_SURFACE_THRESHOLD` / `_ARCHIVE_THRESHOLD` | `0.30` / `0.70` / `0.05` | Hysteresis band + archive floor |
| `CAPTAIN_MEMO_TIDE_AGE_FLOOR_DAYS` / `_ARCHIVE_AGE_DAYS` | `90` / `180` | Belt-and-braces age gates |
| `CAPTAIN_MEMO_TIDE_PROTECT_DRILLED` | `1` | The `from_drill > 0` ⇒ never-ebb hard gate (recommend hard-coding the floor) |
| `CAPTAIN_MEMO_TIDE_FAST_TICK_BATCH` | `256` | Max rows reprocessed per writer fast-tick slice |
| `CAPTAIN_MEMO_TIDE_FEDERATION` | `0` | Buoyancy/stability/tide_state never shared with or read from peers |

Every threshold is config-driven on purpose — a salience cutoff that worked last quarter fails after a scoring-model change, so none of them may be a code constant.

### Phased rollout (Tide only)

1. **Shadow / ranking-only.** Ship with `TIDE_ENABLED=0`. Add columns (migration v8). Compute buoyancy and *log what would ebb*, but keep applying today's flat decay. Validate the ebb/archive thresholds against the existing retrieval-bump logs + `recall-audit.jsonl` — confirm nothing that later got drilled would have been sunk.
2. **Ranking multiplier on.** Flip `TIDE_ENABLED=1`. Tide now re-ranks (bounded multiplier), but **no auto state transitions** yet. Zero data movement, instantly revertible.
3. **Auto tiering on.** Enable `active→dormant→archived` flips, with the drill-protection + age gates live. Archive remains the worst auto outcome; delete stays manual.

---

## The Quartermaster

### Responsibilities

The Quartermaster is a **writer-only, cooperative, time-boxed** crew-process that drives the Tide and curates the corpus in four jobs, built directly on the existing substrate (`archived` soft-delete + `mergeDuplicateGroup`/`unmergeDuplicateGroup`, the per-source bump counters, and the DBSCAN/`distance.ts` co-retrieval pipeline):

1. **Tide pass** (AUTO, zero API) — recompute buoyancy for *touched* rows, apply pending stability updates, flip tiers. Pure SQLite arithmetic.
2. **Mechanical dedup** (AUTO, zero API) — fold near-identical memories via title-Jaccard + a cheap cosine confirm over vectors *already in sqlite-vec*. No embeddings.
3. **Chart consolidation** (CONFIRM-gated, the *only* metered job) — fuse a co-retrieved, time-replayed cluster into one synthesized `type='theme'` entry. Exactly **one** Voyage embed per chart.
4. **Contradiction flagging** (CONFIRM-gated) — enqueue conflicting facts for human review; invalidate-not-delete via a `superseded_by` pointer. Never auto-resolve.

### Heartbeat-safe scheduling

The writer is a **single-threaded JS event loop** that emits the 1s `beat` (engine.ts:79) *and* serves ingest. `busyOp` (engine.ts:58) only guards *incoming* http ops — it does **not** protect the beat from a long synchronous slice. So the Quartermaster must yield, not just check a flag:

- **Tick model:** a `setInterval`-driven tick. If ingest/embed work is queued or `busyOp != null`, **return immediately** — ingest and the heartbeat always preempt. Otherwise run one slice budgeted to `QM_SLICE_MS ≈ 150ms` (30× under the `freshMs=5000` liveness window).
- **Every sub-unit yields.** Between each row's UPDATE, `await` back to the event loop (e.g. `await new Promise(r => setImmediate(r))`) and **re-check `busyOp` *after* each yield**, not only at slice start — so an ingest arriving 10ms into a slice can preempt mid-slice. Each mutation is its own small single-tx (`mergeDuplicateGroup` already has this shape). **Strongly preferred:** run the heavy nightly consolidate pass as its own short-lived Worker (or a scheduled timer job), keeping only the FAST Tide slices inline. A regression test (mirroring the reader-pool spike test) must hammer ingest during a slice and assert no beat gap exceeds `freshMs`.
- **Three cadences (sleep-stage analogy):** FAST (between beats) = Tide pass over `qm_dirty` rows only, O(touched) never O(corpus); HOURLY = bounded-window dedup-detect + cluster-detect (recent + high-buoyancy window, **never a whole-corpus DBSCAN**); NIGHTLY/idle = consolidate confirmed clusters + run the contradiction checker, budget-capped. Also event-driven: a running activity-sum of newly-ingested observations crossing `QM_CONSOLIDATE_TRIGGER` (default `150`, the Generative-Agents threshold) early-queues a cluster pass, so curation bursts with real activity and idles otherwise.

### The AUTO-vs-CONFIRM boundary (idiot-proof)

| AUTO (reversible, non-destructive, no human in loop) | CONFIRM (CLI, cost preview, backup + undo) |
|---|---|
| Recompute buoyancy; ebb `active→dormant→archived`; surface on recall | Hard delete of any archived row |
| Exact-duplicate merge: title-Jaccard ≥ `0.5` **AND** cosine ≥ `0.98` **AND** identifiers match | Cluster → chart consolidation (archives sources behind a theme) |
| | Superseding a fact (contradiction resolution) |
| | Lowering the drill-protection / age-floor gates |

Worst auto outcome is the **dormant/archived tier** — still indexed, one recall away from surfacing. Nothing in the Quartermaster ever destroys data automatically.

### Data model

- **v9 supersede:** `superseded_by INTEGER`, `supersedes INTEGER` (both nullable) — Zep/Graphiti invalidate-not-delete. A superseded row is demoted + dormant but stays queryable; reversal clears both pointers.
- **`merge_events(id, survivor_id, member_id, summed_auto, summed_search, summed_drill, merged_at, job, undone DEFAULT 0)`** — an **append-only, one-row-per-member** merge ledger written in the *same* transaction as `mergeDuplicateGroup`. This replaces the single overwrite-prone `theme_member_ids` JSON cell as the reversal record, so a second merge into the same survivor can never clobber the first's member list. Unmerge reads `WHERE survivor_id=? AND undone=0`. (See Risks — this is the fix for the nested-merge clobber.)
- **`chart_entries(id, theme_obs_id, project_id, cluster_fingerprint, member_ids JSON, created_at_epoch, embedded DEFAULT 0, confirmed_by)`** — consolidation provenance ledger, distinct from the `type='theme'` observation row holding the visible text. `cluster_fingerprint` keyed on a **centroid-vector signature or a stable seed-member subset** (not `hash(all member_ids)`, which churns the moment a member joins) so re-runs *append* members with zero re-embed; `embedded=1` is a hard NOOP guard against re-billing.
- **`contradiction_queue(id, project_id, older_id, newer_id, cosine, llm_confidence, shared_identifiers JSON, status, created_at_epoch, resolved_at_epoch, resolution)`** — the review queue, restricted **by construction to same `project_id` (+branch)**, never cross-project.
- **`qm_runs(id, started/finished_at_epoch, job, rows_touched, merges, charts, embeds_spent, aborted_for_ingest, budget_remaining)`** — run ledger for `/stats` observability and idempotence.

No new vector columns: dedup and cohesion read **existing** sqlite-vec vectors; re-embedding happens **only** for a new chart's theme text (one call per chart).

### Config

| Var | Default | Meaning |
|---|---|---|
| `CAPTAIN_MEMO_QM_ENABLED` | `1` | Master switch for all four jobs |
| `CAPTAIN_MEMO_QM_SLICE_MS` | `150` | Wall-clock budget per cooperative slice |
| `CAPTAIN_MEMO_QM_TIDE_BATCH` | `200` | Max dirty rows per Tide slice |
| `CAPTAIN_MEMO_QM_DEDUP_INTERVAL_S` / `_CONSOLIDATE_INTERVAL_S` | `3600` / `86400` | Hourly dedup, nightly consolidate |
| `CAPTAIN_MEMO_QM_CONSOLIDATE_TRIGGER` | `150` | Activity-sum that early-queues a cluster pass |
| `CAPTAIN_MEMO_QM_DEDUP_TITLE` / `_DEDUP_COSINE` / `_DEDUP_REVIEW_LO` | `0.5` / `0.98` / `0.85` | Auto-merge floors; `[0.85, 0.98)` → confirm band |
| `CAPTAIN_MEMO_QM_EPS` / `_MIN_PTS` | `0.35` / `3` | DBSCAN cluster gates |
| `CAPTAIN_MEMO_QM_PROMOTE_RECALLS` / `_PROMOTE_MIN_SESSIONS` / `_COHESION` | `5` / `2` / `0.9` | Chart-promotion gates (replayed across time, not one burst) |
| `CAPTAIN_MEMO_QM_CONTRADICTION_CONF` | `0.8` | LLM confidence floor; below ⇒ link-as-related, not supersede |
| `CAPTAIN_MEMO_QM_EMBED_BUDGET` | `200` | Voyage calls per nightly run, drained biggest-dedup-win-first |
| `CAPTAIN_MEMO_QM_REQUIRE_CONFIRM` | `1` | First consolidate/supersede shows cost preview, requires `--confirm` |

---

## Risks & Guardrails

| Risk | Severity | Guardrail |
|---|---|---|
| **Nested-merge clobber:** `theme_member_ids` is a single JSON cell; a second merge into a hot survivor overwrites the first member list, stranding real memories with no back-reference and no undo path. | High | Append-only `merge_events` ledger (one row per member, same tx); unmerge reads `WHERE survivor_id=? AND undone=0`. Keep `theme_member_ids` for display only. |
| **Blanket-only undo:** the only reversal is `dedup --undo`, which unmerges *every* survivor corpus-wide. No per-row restore exists. | High | Ship `captain-memo restore <id>` + `memory --show-archived [--ebbed] [--folded]` *before* any auto-archival is enabled; restore one row in one UPDATE, subtract only that member's counts via the ledger. |
| **"Archived = searchable" is false in practice:** `dropArchived` removes `archived=1` rows from every `/search` channel before a doc_id reaches the agent; `/observation/full` hard-404s them. A chart-folded member becomes unreachable, breaking the surface contract. | High | Tide dormancy must **not** route through `dropArchived`. Post-filter dormant rows from the *default auto-inject set only*, keep them in `/search` with a floored score, add `?include_dormant=1`. Never set `archived=1` on a consolidated member unless byte-identical to the survivor — use `tide_state='dormant'`. |
| **Auto-merge destroys nuance/provenance:** cosine 0.95 routinely conflates "timeout=30s tenant A" vs "5s tenant B"; the survivor's text wins and the loser's identifier is evicted. | High | Auto-merge only at cosine ≥ `0.98` **AND** matching extracted identifiers (file paths/issue numbers/entity tokens); any mismatch → confirm queue. Union the member's distinct facts/files onto the survivor so no load-bearing identifier is lost. |
| **Cross-project bad merges:** `findDuplicateGroups`/`mergeDuplicateGroup` group on title-Jaccard ≥ 0.5 with **no project scope** — verified to fold rows across different projects on the live corpus, corrupting both sides' counters. | High | Scope all dedup/cluster/merge SQL by `(project_id, branch)`; assert all member `project_id`s match the survivor inside `mergeDuplicateGroup` (throw + skip otherwise). Land before any QM auto-merge. |
| **Dedup folds genuine contradictions as duplicates:** title-Jaccard can't tell "present" from "missing"; the contradiction job races behind dedup. | High | Negation/antonym + identifier guard before any auto-fold (missing/present, fixed/broken, added/removed); failing pairs drop to the confirm contradiction queue instead of folding. |
| **`--force` reindex is delete-then-rebuild, non-atomic:** an embed failure after vector deletes leaves rows with no vector — invisible to dense KNN until a re-run. | High | Embed-then-swap per observation: `vector.add` the new ids and upsert the doc *before* deleting old chunk_ids; never leave deletes committed on embed failure. Verify `reindex --force` preserves `tide_state`/`stability_days`/`superseded_by`. |
| **Drill-protection checked on the wrong row:** a drilled member auto-merged as a "duplicate" becomes `archived` (Tide skips it) and its protection rides only as a counter sum the survivor could later ebb away. | High | When folding a member with `from_drill>0` or `is_anchored`, set a sticky `is_anchored`/`drill_protected=1` on the **survivor** (durable flag, not a fragile sum). Defer a row's tier transition one full tick after any merge touches it. |
| **Heartbeat stall:** a synchronous `K=256`/`200`-row slice on the writer's event loop is uninterruptible; an overrun trips `freshMs=5000` and main respawns a *busy* writer; `busyOp` is only checked at slice start. | High | Yield to the event loop between every sub-unit and re-check `busyOp` *after* each yield; prefer running heavy consolidate off-thread (short-lived Worker / scheduled timer). Spike-test asserts no beat gap > `freshMs`. |
| **Migration race on readers:** readers open `observations.db` read-only and **cannot** apply v8; if a reader boots before the writer migrates, `SELECT stability_days` errors and it can't self-heal. | High | Writer posts `{kind:'schema_ready', version:8}`; readers aren't marked pickable until then. Defensive fallback: `pragma_table_info` capability check at reader boot → behave as `TIDE_ENABLED=0` (flat decay) if columns absent. `TIDE_ENABLED=0` default makes first deploy safe. |
| **Whole-corpus DBSCAN doesn't scale:** `cluster.ts` is O(n²) ("adapted for sub-1000"); the observation channel is ~100× that, blowing the 150ms slice and producing non-deterministic clusters. | High | Never cluster the whole corpus. Seed a sparse candidate graph from each dirty row's top-K sqlite-vec neighbours *within its project*, run DBSCAN on that sparse graph — O(n·K). |
| **Cohesion gate is unbuilt:** the shipped pipeline runs `semantic=null` (temporal + co-retrieval only), so a "cluster" is just "co-surfaced ≤7d" — exactly the auto-inject popularity loop's output; Haiku then fuses unrelated rows into a hallucinated theme. | High | Wire the mean-pairwise-cosine cohesion gate (over existing vectors, zero embeds) and hard-reject clusters below `0.9` and below `PROMOTE_MIN_SESSIONS` distinct days. Co-retrieval-only clusters are detect-only, never auto-promoted. |
| **Embedding-cost blowup from fingerprint instability:** `hash(member_ids)` changes when any member joins → a new fingerprint → a new embed every night, draining the budget on near-identical themes. | High | Key chart identity on a centroid-vector signature / stable seed-member subset; match by centroid cosine ≥ `0.97` to append with zero re-embed; `embedded=1` is a hard NOOP. |
| **Unbounded audit-log read:** `loadDreamInputs` reads all of `recall-audit.jsonl` with `fs.readFile` + `split('\n')` — a GC/latency spike adjacent to the heartbeat as the file grows. | Med | Stream the file gated by a persisted since-offset (in `qm_runs`); rotate on a size cap; process only the delta. |
| **False contradiction flags:** context-scoped facts ("true on tenant A, false on tenant B") look contradictory; Zep ships no confidence threshold. | Med | Require LLM confidence ≥ `0.8` **AND** identifier overlap, restricted to same `project_id`(+branch); below floor → link-as-related. Resolution is human-confirmed `supersede` (reversible), never auto-delete. |
| **Federation score leak:** inbound peer hits returned by `localSearchAll` carry a Tide-weighted score the requesting peer can't normalise away. | Med | Strip Tide from the exported score: return peer hits ranked by **raw RRF** (or carry raw `rrf_score` in a separate field); enforce `CAPTAIN_MEMO_TIDE_FEDERATION=0` at the `localSearchAll` return seam, not just the column layer. |
| **Calibration drift / recency runaway:** `S0`/`W6–W9`/`W20` are flashcard-tuned; one accidental drill on a folded junk row can over-strengthen it via `fR·g(drill)`. | Med | Ship shadow-mode first; cap `S_new ≤ S·1.5` per recall and require `from_drill ≥ 2` distinct sessions before the desirable-difficulty boost applies; all thresholds in config, validated against real bump logs before enabling auto-archive. |
| **Operator confusion:** v6 `archived` (dedup "folded") vs `tide_state='archived'` (lifecycle "sunk") in `/stats`/TUI. | Low | Distinct labels — **folded** (dedup) vs **sunk/dormant** (Tide). |

---

## Interactions

**Retrieval (RRF).** Tide is a single bounded post-fusion multiplier `final = rrf · (B0 + (1−B0)·buoyancy)` with `B0=0.30`, replacing the current `applyRecencyDecay`. The dense KNN distance, BM25 score, and RRF `k`-fusion are never mutated — the "never weaken hybrid RRF" constraint holds, and zero re-embedding is incurred. The multiplier must be applied to the **full fused pool before `slice(0, topK)`** and must read its inputs via one batched `tideRowsAmong(ids)` join across `observations.db` (the data is *not* on the meta chunk the current decay reads).

**Channels.** The observation channel (the bulk) is the only one that ebbs — it gets the full power-law Tide. `memory` and `skill` are **anchored** (`S=∞`, multiplier `1.0`), formalising the existing `channel !== 'observation'` carve-out in `applyRecencyDecay` and making it declarative. Chart entries are written as `type='theme'` observations in the observation channel, so they ride the same search path and are anchored.

**Reader-pool — where state is computed vs mutated.** Buoyancy is **computed on read** from stored columns, so *any* engine — including the N read-only readers — can rank with Tide *without writing* (pure arithmetic over `last_surfaced_at`/`stability_days`/`from_*`). Readers **never** persist stability or flip a tier (they're read-only); they relay bumps reader→main→writer via the existing `{kind:'bump'}` channel, and those bumps set `qm_dirty` so the next Tide slice re-strengthens the row on the writer. This split — *compute anywhere, mutate only on the writer* — is precisely why stability/tier are the only persisted bits.

**Writer heartbeat.** Both write sides live on the writer and are heartbeat-safe by construction. (1) Stability-update-on-recall is a small extension of the existing single-statement `bumpRetrieval`. (2) Tier flips run in bounded `qm_dirty` slices that yield between the 1s beats and abort the instant ingest is queued — O(touched), never a corpus sweep. `qm_runs.aborted_for_ingest` makes the yield behaviour auditable; `healthFromHeartbeat freshMs=5000` must stay green throughout, verified by a spike test.

**Federation — buoyancy and charts are strictly LOCAL; default OFF.** No federation code exists today, and when it ships Tide stays local: buoyancy, `stability_days`, and `tide_state` are never replicated to or read from peers, and the exported score on the inbound-peer path is stripped back to raw RRF. **Justification:** buoyancy is *this node's own recall behaviour*. A memory a peer recalls hourly is, to us, something we've never touched — ranking it by the peer's heat would import a foreign popularity signal we can't normalise and would defeat the loopback-only, locally-grounded design. A peer's row surfaced locally is ranked by *our* recall (starting at `S0`, climbing only as *we* recall it). `CAPTAIN_MEMO_TIDE_FEDERATION=0` enforces this at the column layer *and* the export seam.

---

## Phased Delivery

**MVP — read-time buoyancy boost only (smallest shippable).**
- Migration v8 (the Tide columns), behind `CAPTAIN_MEMO_TIDE_ENABLED=0`.
- Add the batched `tideRowsAmong(ids)` accessor; replace `applyRecencyDecay` with the bounded Tide multiplier, applied to the **full pool before truncation**.
- Stability-update-on-recall folded into `bumpRetrieval`.
- **No state transitions, no Quartermaster.** Buoyancy only re-ranks. Reader fallback (`pragma_table_info` capability check) and the schema-ready boot barrier land here. Ship shadow → ranking-on. Fully revertible by flipping one env var.

**Phase 2 — Tide tiering.**
- Enable `active→dormant→archived` flips with drill-protection + age gates and hysteresis.
- Ship the per-row `restore`/`show-archived` CLI *first*; decouple dormant from `dropArchived` (dormant stays searchable).

**Phase 3 — Quartermaster, AUTO jobs.**
- The Tide-pass scheduler (yielding slices, `qm_dirty`) and mechanical dedup — but with the substrate fixes mandatory: project-scoped merges, the append-only `merge_events` ledger, the negation/identifier guard, cosine `0.98`+identifier auto-floor, crash-safe `reindex`.

**Phase 4 — Quartermaster, CONFIRM jobs.**
- Chart consolidation (project-scoped ANN-seeded clustering, cohesion gate wired, centroid-stable fingerprint, one embed per chart, budget cap) and the contradiction queue (invalidate-not-delete, `review` CLI). All behind `--confirm` with cost preview, dry-run default, backup, and a working per-op undo.

---

## Glossary

| Our term | Prior-art term | Note |
|---|---|---|
| **Tide** | decay (Generative Agents recency; artel heat-decay) | Two-component lifecycle, not a single decay term |
| **buoyancy** | heat (artel); recency×importance (Generative Agents) | Additive-in-spirit, source-weighted, recall-strengthened; never multiplicative-zeroing |
| **ebb / surface** | aging / re-access | Reversible tier transition + recall reset, never a delete |
| **anchored** | heat-protected (artel); high-importance (Generative Agents) | Declarative by channel/pin, not an emergent threshold |
| **chart** | doc-promotion (artel); reflection (Generative Agents) | Consolidated `type='theme'` entry, one embed per cluster |
| **Quartermaster** | archivist (artel); reflection trigger (Generative Agents) | Writer-only, yielding, AUTO-vs-CONFIRM split |
| **dormant / sunk** | (no equivalent) | Demoted but still indexed — one recall surfaces it |
| **folded** | merged/deduped | The v6 `archived` dedup state, distinct from Tide's sunk |
