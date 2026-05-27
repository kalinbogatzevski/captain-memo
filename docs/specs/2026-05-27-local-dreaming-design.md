# Captain Memo — Local Dreaming Design Sketch

**Status:** Draft (pre-data — refine after ≥2 weeks of retrieval-tracking signal)
**Date:** 2026-05-27
**Author:** Kalin Bogatzevski (drafted with Claude during brainstorming session)
**Project home:** `~/projects/captain-memo/`

---

## TL;DR

"Local Dreaming" is the captain-memo equivalent of Anthropic's [Dreams](https://platform.claude.com/docs/en/managed-agents/dreams) — a periodic offline job that reads accumulated observations and produces a **smaller, higher-level corpus** (themes + archived originals). It addresses the linear-growth problem: at the current pace (~17k observations after a few months of use) flat retrieval starts to degrade because related-but-stale memories crowd out the genuinely-fresh hits.

Unlike Anthropic's Dreams (managed-agents API, async job, reviewed-before-adopt), the local variant runs on **your machine, on your schedule, against your local corpus, with your local Haiku transport (claude-oauth)**. It writes to the same `observations.db` rather than a separate store.

The key design move is to **cluster by co-retrieval, not just by semantic similarity** — using the `retrieval_count` / `last_retrieved_at` signal that v0.1.11 started collecting. Without that signal, clustering reverts to "groups that share vocabulary," which is the trap Dreams' design specifically warns against.

This sketch is intentionally pre-data. It will be refined once there are ≥2 weeks of usage data to validate the clustering hypothesis against real workflows.

---

## Goals

- **G1 — Cap observation growth.** Without intervention, observations grow linearly with usage; in 6 months we'd have ~50k. Reduce the *effective* corpus size that semantic retrieval operates over without losing access to the originals.
- **G2 — Surface higher-level patterns.** Many sessions contribute to a single ongoing project ("cashbox supervisor dashboard" over 3 months = ~50 observations). A theme-level observation captures the multi-session story in one chunk.
- **G3 — Use co-retrieval, not just embedding similarity.** Two observations the user keeps recalling together are a stronger cluster signal than two observations that share words.
- **G4 — Reversible.** No destructive operations. Originals are archived, not deleted; themes are additive; rollback is a single SQL `UPDATE archived = FALSE`.
- **G5 — Local, on-your-schedule.** Runs as a systemd-timer-scheduled CLI command (`captain-memo dream`). Not a hot-path hook. No platform dependency.

## Non-Goals

- **No multi-agent orchestration.** Anthropic's managed-agents Dreams sits in a larger lifecycle (input store → dream job → output store → human review → adopt). The local version doesn't need that ceremony; it's a single-user tool.
- **No real-time consolidation.** Dreaming runs cold (weekly or on-demand), not in the prompt path.
- **No cross-project federation in v1.** Per-project; cross-project clustering is a v2.

---

## How Dreams (Anthropic) works — relevant bits

From the API docs and the [blog post](https://claude.com/blog/new-in-claude-managed-agents):

1. **Input**: existing memory store + session transcripts (1-100 sessions).
2. **Output**: a *separate* memory store with merged/deduped/reorganized entries plus *new insights* surfaced from patterns.
3. **Lifecycle**: input store is never modified; you review the output and decide whether to adopt or discard.
4. **Cost**: minutes to tens of minutes async work; not free.

The two non-obvious things the API gets right:

- **Dual signal**: explicit deduplication (memory-vs-memory similarity) PLUS pattern surfacing (cross-session inference). The first is mechanical; the second is the magic.
- **Reviewable**: the user sees the output store before swapping it in, so a bad Dreams job is reversible by simply not adopting.

Local Dreaming should mirror both: dual signal + reviewable.

---

## How Local Dreaming should work

### Inputs

- **Observations table** at v4+ schema (every row has `retrieval_count`, `last_retrieved_at`, `archived` boolean from v5 of this spec).
- **Optional**: `recall-audit.jsonl` if `CAPTAIN_MEMO_RECALL_AUDIT=1` was on during the period — gives query text alongside hits, useful for naming clusters.

### Clustering signal — three layers

In *increasing* order of authority:

1. **Semantic embedding similarity** (always available, weak signal alone).
2. **Temporal proximity** (created within N days of each other → likely about the same project).
3. **Co-retrieval frequency** (returned in the same `/inject/context` response, OR retrieved within the same session window → strongest signal — these are observations you literally treat as "the same topic").

Weight: `0.2 * cosine_similarity + 0.3 * temporal_overlap + 0.5 * co_retrieval_score`.

The co-retrieval score is what `retrieval_count` + the audit log unlock. Without them, you fall back to embedding-only, which is the failure mode we want to avoid.

### Clustering algorithm — v1 sketch

DBSCAN-style density clustering on the weighted distance:
- `eps = 0.35` (tunable post-data).
- `minPts = 3` (a theme needs ≥3 observations to be worth summarizing).
- Singletons stay as-is (no forced merging).

### Per-cluster summarization

For each cluster of N observations:
1. Concatenate titles + narratives (token-bounded).
2. Send to Haiku via `claude-oauth` with a prompt like *"Summarize these N related notes into one consolidated story. Preserve concrete identifiers (issue numbers, file paths, customer names). Output: type, title, narrative, facts[], concepts[]."*
3. Insert as a new observation with `type='theme'` and `theme_member_ids: number[]` (JSON).
4. Mark members as `archived = TRUE` and `archived_into_theme_id: number` (foreign key).

### Retrieval behavior with archived observations

- **Default search**: skip `archived = TRUE` rows. Themes (`type='theme'`) and live observations come back.
- **`?include_archived=1`**: archived rows are searchable for historical questions.
- The theme observation's chunk carries the same `observation_id` field but also `theme_member_ids` in metadata, so retrieval-tracking bumps on a theme also bump retrievals on its members (transitive recall signal).

### Schema additions (proposed v5 migration)

```sql
ALTER TABLE observations ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE observations ADD COLUMN archived_into_theme_id INTEGER;
ALTER TABLE observations ADD COLUMN theme_member_ids TEXT;  -- JSON array, NULL unless type='theme'
CREATE INDEX idx_obs_archived ON observations(archived) WHERE archived = TRUE;
```

Plus extend the `type` enum from `bugfix | feature | refactor | discovery | decision | change` to add `theme`.

### Scheduling

- New CLI command: `captain-memo dream [--dry-run] [--since 14d] [--cluster-eps 0.35]`.
- Systemd-timer install path: `captain-memo install --schedule-dreams=weekly` adds a `captain-memo-dream.timer` that fires every Sunday 03:00.
- First run requires `--confirm` flag — Haiku cost preview shown, user accepts before any writes.

---

## Open questions (must be answered post-data)

1. **How sparse is the co-retrieval signal in practice?** If users typically don't recall multiple observations per prompt, the co-retrieval signal is weak and we fall back to semantic+temporal. **Validate after 2 weeks of audit-log data.**

2. **Theme labeling.** Haiku can write a title, but should the user be able to rename / merge / split themes via CLI? Likely v2.

3. **Idempotence under re-runs.** If a theme already exists for a cluster, the next Dreams run should detect "this cluster is already themed, just append new members" — not create a duplicate theme. Needs a stable cluster fingerprint.

4. **Privacy.** Dreams sends concatenated observation bodies to Haiku. If observations contain sensitive content, opt-out per-project? Or per-observation? Likely a `dream_eligible: BOOLEAN DEFAULT TRUE` column.

5. **Cross-tenant pollution.** Captain Memo currently siloes by `project_id`. Dreams should respect that — never cluster across projects.

---

## What to build vs. what to wait on

### Ship now (data-independent)

- **Spec finalization** (this doc).
- **Schema scaffolding**: migration v5 with `archived`, `archived_into_theme_id`, `theme_member_ids`. Cheap, reversible. — *Optional — could also wait until after the design is validated.*
- **`captain-memo dream --dry-run`**: the clustering pipeline without the Haiku call or any writes. Reports "would create N themes, would archive M observations." Lets you tune eps/minPts against real data when it arrives, without spending Haiku tokens.

### Ship after 2 weeks of data

- **Cluster validation.** Run dry-run; eyeball whether the clusters match your mental model of "things I keep coming back to together." Tune weights.
- **Haiku summarization step.** Real cost; only worth paying once we know the clusters are sensible.
- **The actual `captain-memo dream` command** (writes observations + archives).
- **Systemd-timer install path.**

### Defer to v2

- Cross-project clustering.
- Theme split/merge CLI.
- Recall-audit-driven *query* clustering (group themes by what kind of question they get retrieved for).

---

## Worked example (illustrative — pre-data)

A plausible cluster from this very session's accumulated observations:

| Member | Type | Title (truncated) |
|---|---|---|
| 16776 | discovery | Team filter implementation in calendar UI |
| 16786 | discovery | Map calendar RPC endpoint team filter dropdown structure |
| 16848 | discovery | Calendar team-filter dropdown renders division-prefixed |
| (~6 more from the same arc) | … | … |

**Co-retrieval signal**: all hit by the same `/inject/context` calls during the session. **Semantic**: high. **Temporal**: all created within 2 hours. Strong cluster.

**Output theme** (illustrative Haiku output):

```
type: theme
title: "Schedule Calendar — team-filter dropdown disambiguation + 3-path matching"
narrative: "Over a single session, the Schedule Calendar's team filter
            was diagnosed and fixed: duplicate short names (KZN/Cabling
            vs CPT/Cabling) caused user confusion (now prefixed by
            division), and the team_ids match was broadened from
            note_assigned_units only to include note_agents and
            note_officer team membership — mirroring dispatch_in_scope_note."
facts:
  - "Two teams literally named 'Cabling' (id_org_unit 3 and 14) in different divisions"
  - "team_ids now CONCAT_WS of 3 correlated subqueries"
  - "MySQL 5.x can't correlate through nested UNIONs — CONCAT_WS chosen for that reason"
concepts: ["calendar", "team-filter", "hr_org_units", "note_assigned_units", "dispatch parity"]
theme_member_ids: [16776, 16786, 16848, ...]
```

Result: 9 observations collapse to 1 theme + 9 archived originals. The theme is what comes back on future searches; the originals stay archived but searchable on demand.

---

## Next session

- **Wait for ≥2 weeks of retrieval-tracking data** (started 2026-05-27 with v0.1.11 + `CAPTAIN_MEMO_RECALL_AUDIT=1`).
- **Then**: build `captain-memo dream --dry-run` against real data, validate clusters, tune weights.
- **Then**: real Dreams pass with Haiku, schema v5 migration, systemd timer.

This doc gets updated when the data arrives. Sections marked "tunable post-data" are the ones expected to change.
