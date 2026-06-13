# Tide Tiering Implementation Plan (design-note Phase 2)

> Builds on the shipped Tide MVP (read-time buoyancy re-rank, v0.5.3). Adds the
> `active → dormant → archived` lifecycle state machine with drill-protection,
> age gates, and hysteresis — **opt-in** (`CAPTAIN_MEMO_TIDE_TIERING=0` default),
> shadow-tested on the live captain before any default-on.

**Goal:** Idle, low-buoyancy observations auto-demote to `dormant` (excluded from the
default auto-inject set but still searchable), then `archived` — never deleted, always
one recall away from re-surfacing, with a per-row `restore` CLI as the safety net.

**Architecture:** Two cleanly separated mechanisms. (1) **Surface** (dormant/archived →
active) is recall-driven — folded into `bumpRetrieval` (a recall resets age, buoyancy→1).
(2) **Ebb** (active → dormant → archived) is a bounded, heartbeat-safe periodic sweep on
the writer that only moves rows *downward*. Pure tier-decision math lives in `tide.ts`;
persistence in `observations-store.ts`; the sweep in a new `tide-sweep.ts`.

**Non-negotiable guardrails (from the design note's Risks):**
- **Dormant ≠ de-indexed.** Dormant/archived rows stay in FTS5 + sqlite-vec; excluded
  only from the auto-inject default set (`/inject/context`), never from `/search/*`.
  Must NOT route through the existing `dropArchived` (that hard-removes from search).
- **Drill-protection:** any `from_drill > 0` makes a row permanently ineligible for
  auto-ebb. Cheapest, most important gate.
- **Anchored rows** (memory/skill channel, or `is_anchored=1`) never ebb.
- **Heartbeat-safe:** the sweep yields to the event loop between row-units and aborts the
  instant ingest is queued; no beat gap > `freshMs`. Spike-tested.
- **Reversible:** `restore`/`show-archived` CLI ships in this phase. Archive is the worst
  auto outcome; delete stays manual (not in this phase).

---

## Tasks

### T1 — Tiering config + pure `tierDecision` (tide.ts)
- Extend `TideConfig` with `tieringEnabled`, `ebbThreshold` (0.30), `surfaceThreshold`
  (0.70), `archiveThreshold` (0.05), `ageFloorDays` (90), `archiveAgeDays` (180),
  `sweepBatch` (256), `sweepIntervalMs` (60000). Wire into `loadTideConfig` from
  `CAPTAIN_MEMO_TIDE_TIERING`, `_EBB_THRESHOLD`, `_SURFACE_THRESHOLD`,
  `_ARCHIVE_THRESHOLD`, `_AGE_FLOOR_DAYS`, `_ARCHIVE_AGE_DAYS`, `_SWEEP_BATCH`, `_SWEEP_MS`.
- Pure `tierDecision(row, buoyancy, ageDays, cfg): 'active'|'dormant'|'archived'|null`
  (null = no change). Anchored/`from_drill>0` → null. active→dormant when
  `buoyancy<ebb && age>ageFloor`. dormant→archived when `buoyancy<archive && age>archiveAge`.
  Never moves up (surface is recall-driven, handled in the store).
- **Check:** unit tests for each transition + every guard; `loadTideConfig` defaults.

### T2 — Store: tier persistence + surface-on-recall (observations-store.ts)
- `setTideState(id, state, atEpoch)`, `restoreObservation(id, atEpoch)` (→ active, clears
  state), `dormantAmong(ids): Set<number>` (mirrors `archivedAmong`), `tierSweepCandidates(limit)`
  (bounded: `tide_state IN ('active','dormant') AND from_drill=0 AND is_anchored=0` past the
  age floor — returns buoyancy inputs), `listByTideState(state, limit)` for the CLI.
- Fold **surface-on-recall** into `bumpRetrieval`'s enabled branch: add
  `tide_state='active', tide_state_changed_at = CASE WHEN tide_state!='active' THEN ? ELSE tide_state_changed_at END`.
- **Check:** unit tests — surface flips dormant→active on bump; sweep-candidate query
  excludes drilled/anchored; setTideState/restore roundtrip; JS↔SQL parity preserved.

### T3 — Decouple dormant from auto-inject (index.ts)
- Add `dropDormantForAutoInject(items)` (uses `obsStore.dormantAmong`), apply ONLY at
  `/inject/context` (line ~1403) before the slice. Leave all 5 `dropArchived` calls intact.
- **Check:** integration test — a dormant row is absent from `/inject/context` but present
  (down-ranked) in `/search/observations`.

### T4 — Heartbeat-safe ebb sweep (tide-sweep.ts + index.ts tick)
- New `runTideSweepSlice(deps)`: pull `tierSweepCandidates(sweepBatch)`, compute buoyancy
  (reuse tide.ts), apply `tierDecision`, `setTideState` per flip, `await` to the event loop
  between units, abort if `obsQueue.pendingCount() > 0` or a busy signal. Returns counts.
- Wire a `setInterval(sweepIntervalMs)` in the index.ts tick region, gated on
  `!opts.readOnly && tideConfig.tieringEnabled`, with an in-flight guard + `.catch`.
- **Check:** unit test — a slice ebbs eligible rows, skips guarded ones, respects batch.
  Spike test — hammer ingest during a slice; assert no beat gap > `freshMs` (mirror the
  reader-pool spike test).

### T5 — Worker endpoints (index.ts)
- `POST /observation/restore` `{id}` → `obsStore.restoreObservation`; guard `!obsStore`.
- `GET /observations/by-tide-state?state=dormant|archived&limit=` → `listByTideState`.
- **Check:** integration tests for both; readers 503 on restore.

### T6 — CLI: restore + show-archived (src/cli)
- `captain-memo restore <id>` → `workerPost('/observation/restore', {id})`.
- `captain-memo memory --show-archived` / `--ebbed` → `workerGet('/observations/by-tide-state?...)`.
- Register in `src/cli/index.ts`; new `commands/restore.ts`, extend memory/observation cmd.
- **Check:** command dispatch + output smoke tests.

### T7 — Stats: dormant/archived now populate
- `getTideStats` already reports tiers; the panel already renders them. Add a sweep-activity
  line if cheap (last sweep counts). Verify tiers move under tiering.
- **Check:** existing stats tests still green; manual live check shows non-zero dormant.

### T8 — Verify, shadow, release
- Full suite + typecheck green on master.
- Port to federation (cherry-pick), shadow-test on live captain with `CAPTAIN_MEMO_TIDE_TIERING=1`
  on a short age floor; watch rows ebb, confirm restore re-surfaces, heartbeat green.
- Release public **0.5.4** (tiering opt-in) + federation-private **0.5.4**.
