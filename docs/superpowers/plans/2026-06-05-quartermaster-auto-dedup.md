# Quartermaster AUTO Dedup Implementation Plan (Release 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the Quartermaster's first AUTO curation job — **mechanical dedup with an in-process cosine ≥0.98 confirm** — on the substrate hardened in v0.5.5. It auto-folds near-identical observations (zero embeddings, fully reversible), **off by default**, shadow-tested on the live captain. Release as public **v0.6.0**, then federation-private v0.6.0.

**Architecture:** A writer-only, heartbeat-safe dedup slice (`src/worker/quartermaster.ts`) mirrors the proven `tide-sweep.ts` pattern: bounded candidate window, yield-per-merge, abort-on-ingest. It reuses the hardened `findDuplicateGroups` (project-scoped + negation/identifier guard) for candidates, then gates each fold behind a **triple lock** — title-Jaccard ≥0.5 **AND** cosine ≥0.98 **AND** the guard passes — computing cosine from vectors **already in sqlite-vec** (new `vector-store.getEmbedding` + pure `cosine()` + per-observation centroid). Folds go through the reversible `merge_events` ledger. A `qm_runs` audit table (migration v10) records every run for shadow observability. The existing Tide-pass timer is **left untouched** (the dedup job is a sibling timer). `qm_dirty` and Phase-4 CONFIRM jobs (charts, contradictions) are out of scope.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, sqlite-vec (vec0), `bun test`, `tsc --noEmit`. Config via a new `loadQmConfig` mirroring `loadTideConfig`. Timer wiring mirrors `index.ts:723-748`.

---

## Safety model (why auto-merge is acceptable here)
- **Triple lock**: Jaccard ≥`0.5` AND cosine ≥`0.98` AND the S3 negation/identifier guard passes. Cosine 0.98 is near-identical; this folds restatements, not nuance (spec Risk 188/190).
- **Drill-protection sticky** (spec Risk 192): folding a `from_drill>0`/`is_anchored` member sets a *durable* `is_anchored=1` on the **survivor**, and the survivor's tier transition is deferred one tick — so auto-dedup can't quietly ebb away a protected memory.
- **Reversible**: `merge_events` ledger + `dedup --undo` + `restore <id>` (all hardened in v0.5.5).
- **Heartbeat-safe**: reuse the `tide-sweep` yield-per-unit + abort-on-ingest; `QM_SLICE_MS≈150`; `qm_runs.aborted_for_ingest` audits it; spike-test asserts no beat gap > `freshMs`.
- **Bounded**: a recency/buoyancy-limited candidate window, never a whole-corpus scan (spec Risk 195).
- **Off by default** (`CAPTAIN_MEMO_QM_DEDUP=0`), shadow-tested live before any default-on.
- **No-cosine ⇒ no-merge**: if either row lacks vectors (pending embed), the fold is skipped (fail-closed).

## File Structure
- **Create** `src/shared/vector-math.ts` — pure `cosine(a, b)` + `centroid(vectors)`. No I/O.
- **Create** `src/worker/qm.ts` — `QmConfig`, `DEFAULT_QM_CONFIG`, `loadQmConfig(env)` (mirrors `tide.ts`).
- **Create** `src/worker/quartermaster.ts` — `runQmDedupSlice(deps)`, pure orchestration over injected deps (unit-testable, no worker/DB).
- **Create** `tests/unit/shared/vector-math.test.ts`, `tests/unit/worker/qm.test.ts`, `tests/unit/quartermaster.test.ts`, `tests/integration/qm-dedup.test.ts`, `tests/integration/qm-dedup-spike.test.ts`.
- **Modify** `src/worker/vector-store.ts` — add `getEmbedding(chunkId): Float32Array | null`.
- **Modify** `src/worker/observations-store.ts` — migration v10 (`qm_runs`); `dedupCandidateWindow(titleThreshold, windowLimit)`; `markAnchored(id)`; `recordQmRun(...)` + `latestQmRuns(n)`.
- **Modify** `src/worker/index.ts` — wire the dedup timer (gated, off-by-default), build the cosine/vector deps, in-flight guard, `qm_runs` recording, clear in `stop()`, `/stats` QM block.
- **Modify** `package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `CHANGELOG.md` — v0.6.0.

---

## Task 1: Pure vector math (`cosine`, `centroid`)

**Files:** Create `src/shared/vector-math.ts`, `tests/unit/shared/vector-math.test.ts`.

- [ ] **Step 1: Failing tests**
```ts
import { test, expect } from 'bun:test';
import { cosine, centroid } from '../../../src/shared/vector-math.ts';
test('cosine of identical vectors is 1', () => { expect(cosine([1,2,3],[1,2,3])).toBeCloseTo(1, 6); });
test('cosine of orthogonal vectors is 0', () => { expect(cosine([1,0],[0,1])).toBeCloseTo(0, 6); });
test('cosine is scale-invariant', () => { expect(cosine([1,2,3],[2,4,6])).toBeCloseTo(1, 6); });
test('zero vector yields 0 (no NaN)', () => { expect(cosine([0,0],[1,1])).toBe(0); });
test('centroid averages componentwise', () => { expect(centroid([[1,1],[3,3]])).toEqual([2,2]); });
test('centroid of empty is null', () => { expect(centroid([])).toBeNull(); });
```
- [ ] **Step 2: Run → fail** (`bun test tests/unit/shared/vector-math.test.ts`).
- [ ] **Step 3: Implement** — accept `number[] | Float32Array`; guard zero-norm → return 0 (never NaN); `centroid` returns `number[] | null`.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `feat(qm): pure cosine/centroid vector math`.

---

## Task 2: Read a stored vector by chunk id (`vector-store.getEmbedding`)

**Files:** Modify `src/worker/vector-store.ts`; extend `tests/integration/vector-store.test.ts`.

Embeddings are stored as `new Uint8Array(new Float32Array(embedding).buffer)` (vector-store.ts:77). The decode must round-trip. **sqlite-vec caveat:** selecting a vec0 `embedding` column may return a raw blob — verify the exact decode with a round-trip test (add a known vector, read it back, assert `cosine(read, original) ≈ 1`); if a bare `SELECT embedding` doesn't return the blob, use sqlite-vec's accessor — let the test drive it.

- [ ] **Step 1: Failing round-trip test** in `vector-store.test.ts`: `add` a known 1024-dim (or test-dim) vector, `getEmbedding(chunkId)` → assert length === dimension and `cosine(read, original) > 0.999`; `getEmbedding('missing')` → null.
- [ ] **Step 2: Run → fail** (method missing).
- [ ] **Step 3: Implement**
```ts
getEmbedding(chunkId: string): Float32Array | null {
  const row = this.db.query('SELECT embedding FROM vec_chunks WHERE chunk_id = ?').get(chunkId) as
    { embedding: Uint8Array } | undefined;
  if (!row) return null;
  const buf = row.embedding;                    // raw float32 bytes
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
```
(If the round-trip fails, adjust per the sqlite-vec read shape the test reveals — the invariant is "decoded vector ≈ what was added".)
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `feat(qm): vector-store.getEmbedding — read a stored vector by chunk id`.

---

## Task 3: QM config (`qm.ts`)

**Files:** Create `src/worker/qm.ts`, `tests/unit/worker/qm.test.ts`.

- [ ] **Step 1: Failing tests** — defaults + env overrides:
```ts
import { DEFAULT_QM_CONFIG, loadQmConfig } from '../../../src/worker/qm.ts';
test('defaults: enabled true, dedup OFF', () => {
  expect(DEFAULT_QM_CONFIG.enabled).toBe(true);
  expect(DEFAULT_QM_CONFIG.dedupEnabled).toBe(false);
  expect(DEFAULT_QM_CONFIG.dedupCosineThreshold).toBe(0.98);
});
test('loadQmConfig honours env', () => {
  const c = loadQmConfig({ CAPTAIN_MEMO_QM_DEDUP: '1', CAPTAIN_MEMO_QM_DEDUP_COSINE: '0.95' } as any);
  expect(c.dedupEnabled).toBe(true);
  expect(c.dedupCosineThreshold).toBe(0.95);
});
test('master kill switch', () => { expect(loadQmConfig({ CAPTAIN_MEMO_QM_ENABLED: '0' } as any).enabled).toBe(false); });
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `QmConfig` { `enabled`, `dedupEnabled`, `sliceMs` (150), `dedupIntervalMs` (3_600_000), `dedupTitleThreshold` (0.5), `dedupCosineThreshold` (0.98), `dedupWindow` (500) }. `loadQmConfig`: `enabled: env.CAPTAIN_MEMO_QM_ENABLED !== '0'`; `dedupEnabled: env.CAPTAIN_MEMO_QM_DEDUP === '1'`; numeric envs parsed with the defaults as fallback (mirror `loadTideConfig`'s parsing). Reuse `DEFAULT_SIMILARITY_THRESHOLD` for the title default.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `feat(qm): QmConfig + loadQmConfig (dedup off by default)`.

---

## Task 4: Store — `qm_runs` (v10), candidate window, sticky anchor

**Files:** Modify `src/worker/observations-store.ts`; extend `tests/unit/observations-store.test.ts`.

- [ ] **Step 1: Failing tests**
  - migration v10 created `qm_runs` (mirror the v8/v9 column-assert test style).
  - `dedupCandidateWindow(0.5, 100)` returns project-scoped, guard-clean `DuplicateGroup[]` over only the most-recent `windowLimit` surfaced rows (seed >limit rows, assert the window bounds it).
  - `markAnchored(id)` flips `is_anchored` to 1.
  - `recordQmRun({...})` then `latestQmRuns(5)` round-trips the row.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement**
  - **Migration v10** appended to `OBSERVATIONS_STORE_MIGRATIONS`:
```ts
{
  version: 10,
  name: 'add_qm_runs',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS qm_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        finished_at_epoch INTEGER,
        rows_scanned INTEGER NOT NULL DEFAULT 0,
        merges INTEGER NOT NULL DEFAULT 0,
        aborted_for_ingest INTEGER NOT NULL DEFAULT 0
      )
    `);
  },
},
```
  - **`dedupCandidateWindow(titleThreshold, windowLimit)`** — like `findDuplicateGroups` but the candidate `SELECT` is bounded: `... WHERE archived = 0 AND (from_auto+from_search+from_drill) > 0 ORDER BY COALESCE(last_surfaced_at, created_at_epoch) DESC LIMIT ?` (the recent/active window), THEN the same partition-by-`(project_id,branch)` + `groupBySimilarity(..., mergeBlocked)` as `findDuplicateGroups`. Factor the shared grouping so the two methods don't duplicate it (DRY).
  - **`markAnchored(id)`** — `UPDATE observations SET is_anchored = 1 WHERE id = ?`.
  - **`recordQmRun(run)` / `latestQmRuns(n)`** — insert/select on `qm_runs`.
- [ ] **Step 4: Run → pass** (`bun test tests/unit/observations-store.test.ts tests/integration/migration-e2e.test.ts`).
- [ ] **Step 5: Commit** — `feat(qm): qm_runs (v10) + bounded dedup candidate window + sticky anchor`.

---

## Task 5: The pure dedup slice (`quartermaster.ts`)

**Files:** Create `src/worker/quartermaster.ts`, `tests/unit/quartermaster.test.ts`.

Mirror `tide-sweep.ts`: pure orchestration over injected deps, unit-testable without a worker.

- [ ] **Step 1: Failing tests** (inject fakes) covering:
  - **cosine gate**: a member with cosine 0.99 to survivor folds; a member with cosine 0.90 does NOT (left live).
  - **fail-closed**: if `representativeVector(member)` returns null, that member is NOT folded.
  - **drill-protection sticky**: folding a member with `from_drill>0` calls `markAnchored(survivorId)`.
  - **abort**: `shouldAbort()` true before a group → no merges, `aborted` true; flipping true mid-iteration stops further folds.
  - **yield**: `yieldToLoop` is awaited between groups.
  - **audit**: returns `{ scanned, merges, aborted }` matching the work done.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement**
```ts
export interface QmDedupDeps {
  candidates: () => DuplicateGroup[];                       // dedupCandidateWindow(cfg.dedupTitleThreshold, cfg.dedupWindow)
  representativeVector: (obsId: number) => Float32Array | null; // centroid of the obs's chunk vectors, or null
  memberIsProtected: (obsId: number) => boolean;            // from_drill>0 || is_anchored
  mergeGroup: (survivorId: number, memberIds: number[], atEpoch: number) => void; // mergeDuplicateGroup
  markAnchored: (survivorId: number) => void;
  shouldAbort: () => boolean;
  cfg: QmConfig;
  now: () => number;
  yieldToLoop: () => Promise<void>;
}
export interface QmDedupResult { scanned: number; merges: number; aborted: boolean; }

export async function runQmDedupSlice(deps: QmDedupDeps): Promise<QmDedupResult> {
  const res: QmDedupResult = { scanned: 0, merges: 0, aborted: false };
  if (!deps.cfg.enabled || !deps.cfg.dedupEnabled) return res;
  const atEpoch = deps.now();
  for (const group of deps.candidates()) {
    if (deps.shouldAbort()) { res.aborted = true; return res; }
    res.scanned++;
    const survVec = deps.representativeVector(group.survivor.id);
    if (!survVec) { await deps.yieldToLoop(); continue; }    // no cosine ⇒ no merge
    const foldable: number[] = [];
    let anyProtected = false;
    for (const m of group.members) {
      const mVec = deps.representativeVector(m.id);
      if (!mVec) continue;                                   // fail-closed
      if (cosine(survVec, mVec) < deps.cfg.dedupCosineThreshold) continue;
      foldable.push(m.id);
      if (deps.memberIsProtected(m.id)) anyProtected = true;
    }
    if (foldable.length > 0) {
      deps.mergeGroup(group.survivor.id, foldable, atEpoch);
      if (anyProtected) deps.markAnchored(group.survivor.id); // sticky drill-protection on survivor
      res.merges += foldable.length;
    }
    await deps.yieldToLoop();                                // heartbeat breathes; abort re-checked next group
  }
  return res;
}
```
(import `cosine` from `../shared/vector-math.ts`; `DuplicateGroup`/`QmConfig` types from their modules. The candidates already passed the S3 guard inside `dedupCandidateWindow`, so the guard is implicit — cosine + fail-closed are the added AUTO locks.)
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `feat(qm): runQmDedupSlice — cosine-gated, fail-closed, drill-protected auto-fold`.

---

## Task 6: Wire into the worker + `/stats`

**Files:** Modify `src/worker/index.ts`; add `tests/integration/qm-dedup.test.ts` + `tests/integration/qm-dedup-spike.test.ts`.

- [ ] **Step 1: Failing integration tests**
  - **end-to-end fold**: boot a worker (real embed or a deterministic stub) with `CAPTAIN_MEMO_QM_DEDUP=1`, a short `dedupIntervalMs`; seed two same-project near-identical observations with near-identical vectors; after a slice, assert one is `archived=1` folded into the other and a `qm_runs` row exists. Seed a third with a *different* vector and assert it stays live (cosine gate).
  - **off by default**: same seed with `CAPTAIN_MEMO_QM_DEDUP` unset → no folds.
  - **spike** (`qm-dedup-spike.test.ts`, mirror `worker-thread-spike.test.ts`): hammer ingest during a dedup slice; assert the heartbeat stays fresh (no beat gap > `freshMs`) and the run reports `aborted_for_ingest`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — load `qmConfig = loadQmConfig(process.env)`; after the `tideSweepTimer` block (index.ts ~748), add a sibling `qmDedupTimer`/`qmDedupPromise` gated on `!opts.readOnly && obsStore && vector && meta && qmConfig.enabled && qmConfig.dedupEnabled`:
```ts
let qmDedupTimer: ReturnType<typeof setInterval> | null = null;
let qmDedupPromise: Promise<unknown> | null = null;
if (!opts.readOnly && obsStore && qmConfig.enabled && qmConfig.dedupEnabled) {
  const qmStore = obsStore;
  const repVec = (obsId: number): Float32Array | null => {
    const doc = meta.getDocument(`observation:${opts.projectId}:${obsId}`);
    if (!doc) return null;
    const vecs = meta.getChunksForDocument(doc.id)
      .map(c => vector.getEmbedding(c.chunk_id)).filter(Boolean) as Float32Array[];
    const c = centroid(vecs.map(v => Array.from(v)));
    return c ? Float32Array.from(c) : null;
  };
  qmDedupTimer = setInterval(() => {
    if (qmDedupPromise) return;
    const startedAt = Math.floor(Date.now() / 1000);
    qmDedupPromise = runQmDedupSlice({
      candidates: () => qmStore.dedupCandidateWindow(qmConfig.dedupTitleThreshold, qmConfig.dedupWindow),
      representativeVector: repVec,
      memberIsProtected: (id) => qmStore.isProtected(id),     // from_drill>0 || is_anchored (add accessor)
      mergeGroup: (s, m, at) => qmStore.mergeDuplicateGroup(s, m, at),
      markAnchored: (id) => qmStore.markAnchored(id),
      shouldAbort: () => processBatchPromise != null || (obsQueue?.pendingCount() ?? 0) > 0,
      cfg: qmConfig, now: () => Math.floor(Date.now() / 1000),
      yieldToLoop: () => new Promise<void>(r => setImmediate(r)),
    })
      .then(r => qmStore.recordQmRun({ job: 'dedup', startedAt, finishedAt: Math.floor(Date.now()/1000),
        rowsScanned: r.scanned, merges: r.merges, abortedForIngest: r.aborted }))
      .catch(err => console.error('[qm-dedup] ERROR', err))
      .finally(() => { qmDedupPromise = null; });
  }, qmConfig.dedupIntervalMs);
}
```
  Clear `qmDedupTimer` in `stop()` next to `tideSweepTimer` (index.ts ~1606). Add a `qm` block to `/stats` (`enabled`, `dedup_enabled`, `cosine_threshold`, last run from `latestQmRuns(1)`). Add the small `isProtected(id)` accessor to the store if not present.
- [ ] **Step 4: Run → pass** (the two new integration tests + `bun test tests/integration/worker-http.test.ts`).
- [ ] **Step 5: Commit** — `feat(qm): wire cosine-gated auto-dedup timer + /stats (off by default)`.

---

## Task 7: Verify, release v0.6.0 (HOLD push), shadow plan

- [ ] **Step 1:** `bun test && bun run typecheck` — all green.
- [ ] **Step 2:** Bump `0.6.0` in `package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`; `bun run build:plugin`.
- [ ] **Step 3:** CHANGELOG `[0.6.0]` — "Quartermaster: automatic near-duplicate merging (opt-in, off by default)", with the triple-lock + reversibility + heartbeat-safety + `qm_runs` observability called out.
- [ ] **Step 4:** Local commit `release: 0.6.0 — Quartermaster AUTO dedup (opt-in)`. **HOLD push + GitHub release + federation port until the user says "ship 0.6.0"** (and only after a live shadow).
- [ ] **Step 5 (shadow, when the user enables it):** on the live captain set `CAPTAIN_MEMO_QM_DEDUP=1` with a short interval; watch `qm_runs` + `/stats`; confirm it folds only true dupes (spot-check via `dedup --undo`-ability and `restore`); confirm heartbeat stays green. Only then consider default-on (likely stays opt-in like tiering).

---

## Self-Review
- **Spec coverage:** Tide pass (reused, untouched) ✓; mechanical dedup AUTO with cosine confirm over existing vectors ✓ (Risk 188); project scope + guard (inherited from v0.5.5) ✓ (Risk 189/190); drill-protection sticky on survivor ✓ (Risk 192); heartbeat-safe yield/abort + spike test ✓ (Risk 193); bounded window ✓ (Risk 195); `qm_runs` audit ✓; off-by-default + shadow ✓ (Risk 201). Deferred & noted: `qm_dirty`, charts, contradictions, the `[0.85,0.98)` confirm band.
- **Type/signature consistency:** `runQmDedupSlice(deps)` mirrors `runTideSweepSlice(deps)`; `mergeDuplicateGroup(survivorId, memberIds, atEpoch)` matches the v0.5.5 signature; `getEmbedding` returns `Float32Array | null`; `cosine` accepts `number[] | Float32Array`.
- **Risks:** (a) the sqlite-vec `getEmbedding` decode shape is the one real unknown — Task 2's round-trip test is the gate; (b) `repVec` does N `getEmbedding` reads per candidate — bounded by `dedupWindow`, and the slice yields between groups, so it stays heartbeat-safe; (c) multi-chunk observations use a centroid — acceptable for near-identical (0.98) detection.

## Execution Handoff
Recommended: **superpowers:subagent-driven-development** — fresh implementer per task (Tasks 4 and 6 touch `observations-store.ts`/`index.ts` and must run sequentially), spec-then-quality review between, plus a final adversarial pass (correctness + silent-failure) before the release commit, as in v0.5.5.
