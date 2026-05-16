# Snapshot Efficiency Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface corpus compression ratio, embedder throughput, and dedup hit-rate in the worker `/stats` endpoint and the `/captain-memo:stats` skill.

**Architecture:** A new nullable `stored_tokens` column on the `observations` table is populated at index time (the chunk text is already in hand), so `/stats` computes the compression figure from two O(1) `SUM()` queries instead of tokenizing the corpus on a hot path. Embedder/dedup figures come from in-memory `WorkerMetrics` counters (since worker start). A pure `computeEfficiency()` function owns all ratio/percentage/edge-case math and is exercised by both the worker and unit tests.

**Tech Stack:** TypeScript, Bun runtime, `bun:sqlite`, `bun test`.

**Spec:** `docs/specs/2026-05-16-snapshot-efficiency-stats-design.md`

---

## File Structure

- `src/shared/types.ts` — add `Observation.stored_tokens`.
- `src/worker/observations-store.ts` — migration v3, `setStoredTokens`, `sumWorkTokens`, `sumStoredTokens`, hydrate `stored_tokens`, `NewObservation` excludes `stored_tokens`.
- `src/worker/metrics.ts` *(new)* — `WorkerMetrics` interface + `createWorkerMetrics`, `recordEmbed`, `recordIndexResult`.
- `src/worker/efficiency.ts` *(new)* — pure `computeEfficiency()` + `EfficiencyReport` / `EfficiencyInput` types.
- `src/worker/ingest.ts` — `onIndexResult` callback so the worker can count dedup skips.
- `src/worker/index.ts` — wire metrics, capture `stored_tokens` at both `chunkObservation` sites, add `efficiency` to `/stats`.
- `src/cli/commands/stats.ts` — `StatsResponse.efficiency`, exported `formatEfficiencyLines()`, "Efficiency" output block.
- `plugin/skills/stats/SKILL.md` — document the new section.
- `src/migration/transform.ts` + `tests/unit/chunkers/observation.test.ts` — add `stored_tokens: null` to the two literal `Observation` values that will otherwise fail to type-check.

---

## Task 1: `stored_tokens` column + ObservationsStore methods

**Files:**
- Modify: `src/shared/types.ts:89-107`
- Modify: `src/worker/observations-store.ts`
- Modify: `src/migration/transform.ts:80-95`
- Test: `tests/unit/observations-store.test.ts`
- Test fixture fix: `tests/unit/chunkers/observation.test.ts:4-22`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/observations-store.test.ts`:

```ts
test('ObservationsStore — stored_tokens defaults to null on insert', () => {
  const id = store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: null,
  });
  expect(store.findById(id)!.stored_tokens).toBeNull();
});

test('ObservationsStore — setStoredTokens roundtrips', () => {
  const id = store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: null,
  });
  store.setStoredTokens(id, 137);
  expect(store.findById(id)!.stored_tokens).toBe(137);
});

test('ObservationsStore — sumWorkTokens / sumStoredTokens ignore NULL rows', () => {
  const mk = (work: number | null) => store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: work,
  });
  const a = mk(100); mk(200); mk(null);   // 3 rows, 2 with work_tokens
  store.setStoredTokens(a, 25);            // 1 row with stored_tokens

  expect(store.sumWorkTokens()).toEqual({ sum: 300, count: 2 });
  expect(store.sumStoredTokens()).toEqual({ sum: 25, count: 1 });
});
```

Then update the existing migration-count test (it currently hard-asserts 2 migrations and will break):

```ts
test('ObservationsStore — schema_versions records migrations 1, 2 and 3 after construction', () => {
  store.close();
  const db = new Database(join(workDir, 'observations.db'), { readonly: true });
  const rows = getAppliedVersions(db);
  db.close();
  expect(rows).toHaveLength(3);
  expect(rows.map(r => r.version)).toEqual([1, 2, 3]);
  expect(rows.map(r => r.name)).toEqual(['add_branch', 'add_work_tokens', 'add_stored_tokens']);
  store = new ObservationsStore(join(workDir, 'observations.db'));
});
```

(Replace the existing `'... migrations 1 and 2 ...'` test body entirely with the above.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/observations-store.test.ts`
Expected: FAIL — `store.setStoredTokens is not a function`, `sumWorkTokens is not a function`, and the migration test mismatch.

- [ ] **Step 3: Add `stored_tokens` to the `Observation` type**

In `src/shared/types.ts`, inside `interface Observation`, immediately after the `work_tokens` field (line 106):

```ts
  /** Token count of the observation's rendered chunk text — the cost paid in
   *  the corpus to store it. Populated at index time; null until then and for
   *  observations indexed before v0.1.9. */
  stored_tokens: number | null;
```

- [ ] **Step 4: Exclude `stored_tokens` from `NewObservation` and add the migration + methods**

In `src/worker/observations-store.ts`:

Change the `NewObservation` type (it currently is `Omit<Observation, 'id'>`) so callers of `insert()` need not supply the post-insert field:

```ts
export type NewObservation = Omit<Observation, 'id' | 'stored_tokens'>;
```

Append migration v3 to `OBSERVATIONS_STORE_MIGRATIONS` (after the v2 entry):

```ts
  {
    version: 3,
    name: 'add_stored_tokens',
    up: (db) => db.exec('ALTER TABLE observations ADD COLUMN stored_tokens INTEGER'),
  },
```

In `hydrate()`, add the field to the returned object (after `work_tokens`):

```ts
      stored_tokens: typeof row.stored_tokens === 'number' ? row.stored_tokens : null,
```

Add three methods to the `ObservationsStore` class (before `close()`):

```ts
  setStoredTokens(id: number, tokens: number): void {
    this.db
      .query('UPDATE observations SET stored_tokens = ? WHERE id = ?')
      .run(tokens, id);
  }

  sumWorkTokens(): { sum: number; count: number } {
    const r = this.db
      .query('SELECT COALESCE(SUM(work_tokens), 0) AS s, COUNT(work_tokens) AS c FROM observations')
      .get() as { s: number; c: number };
    return { sum: r.s, count: r.c };
  }

  sumStoredTokens(): { sum: number; count: number } {
    const r = this.db
      .query('SELECT COALESCE(SUM(stored_tokens), 0) AS s, COUNT(stored_tokens) AS c FROM observations')
      .get() as { s: number; c: number };
    return { sum: r.s, count: r.c };
  }
```

- [ ] **Step 5: Fix the two literal `Observation` values that now fail to type-check**

In `src/migration/transform.ts`, in the `obsLike: Observation` literal (~line 80), add after `work_tokens: ...`:

```ts
    stored_tokens: null,
```

In `tests/unit/chunkers/observation.test.ts`, in the `observation` literal (~line 21), add after `work_tokens: null,`:

```ts
  stored_tokens: null,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/unit/observations-store.test.ts tests/unit/chunkers/observation.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/worker/observations-store.ts src/migration/transform.ts tests/unit/observations-store.test.ts tests/unit/chunkers/observation.test.ts
git commit -m "feat(observations): stored_tokens column + sum helpers"
```

---

## Task 2: WorkerMetrics counters module

**Files:**
- Create: `src/worker/metrics.ts`
- Test: `tests/unit/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/metrics.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { createWorkerMetrics, recordEmbed, recordIndexResult } from '../../src/worker/metrics.ts';

test('createWorkerMetrics — starts all counters at zero', () => {
  const m = createWorkerMetrics();
  expect(m).toEqual({
    embedCalls: 0, embedTokens: 0, embedMs: 0,
    docsSeen: 0, docsSkippedUnchanged: 0,
  });
});

test('recordEmbed — accumulates calls, tokens and ms', () => {
  const m = createWorkerMetrics();
  recordEmbed(m, 1200, 80);
  recordEmbed(m, 800, 40);
  expect(m.embedCalls).toBe(2);
  expect(m.embedTokens).toBe(2000);
  expect(m.embedMs).toBe(120);
});

test('recordIndexResult — counts every doc, skips separately', () => {
  const m = createWorkerMetrics();
  recordIndexResult(m, 'indexed');
  recordIndexResult(m, 'skipped');
  recordIndexResult(m, 'skipped');
  expect(m.docsSeen).toBe(3);
  expect(m.docsSkippedUnchanged).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/metrics.test.ts`
Expected: FAIL — `Cannot find module '../../src/worker/metrics.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/worker/metrics.ts`:

```ts
/**
 * In-process counters for worker efficiency stats. Reset on every worker
 * restart — the figures are deliberately "since worker start", not lifetime
 * (lifetime recall savings is a separate sub-project). Plain mutable struct;
 * the worker owns one instance and the /stats handler reads it.
 */
export interface WorkerMetrics {
  embedCalls: number;            // number of embedder.embed() calls during indexing
  embedTokens: number;           // total tokens submitted across those calls
  embedMs: number;               // total wall-clock ms spent in those calls
  docsSeen: number;              // file-based documents the indexer considered
  docsSkippedUnchanged: number;  // of those, how many were skipped (sha unchanged)
}

export function createWorkerMetrics(): WorkerMetrics {
  return { embedCalls: 0, embedTokens: 0, embedMs: 0, docsSeen: 0, docsSkippedUnchanged: 0 };
}

export function recordEmbed(m: WorkerMetrics, tokens: number, ms: number): void {
  m.embedCalls += 1;
  m.embedTokens += tokens;
  m.embedMs += ms;
}

export function recordIndexResult(m: WorkerMetrics, result: 'indexed' | 'skipped'): void {
  m.docsSeen += 1;
  if (result === 'skipped') m.docsSkippedUnchanged += 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/metrics.ts tests/unit/metrics.test.ts
git commit -m "feat(worker): WorkerMetrics in-memory counters"
```

---

## Task 3: Pure `computeEfficiency()` formatter

**Files:**
- Create: `src/worker/efficiency.ts`
- Test: `tests/unit/efficiency.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/efficiency.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { computeEfficiency } from '../../src/worker/efficiency.ts';
import { createWorkerMetrics, recordEmbed, recordIndexResult } from '../../src/worker/metrics.ts';

test('computeEfficiency — normal corpus produces ratio and saved_pct', () => {
  const r = computeEfficiency({
    workSum: 160000, workCount: 300,
    storedSum: 10000, storedCount: 300,
    totalObservations: 320,
    metrics: createWorkerMetrics(),
  });
  expect(r.corpus.ratio).toBe(16);
  expect(r.corpus.saved_pct).toBe(94);
  expect(r.corpus.coverage).toEqual({ with_data: 300, total: 320 });
});

test('computeEfficiency — zero coverage yields null ratio (no misleading number)', () => {
  const r = computeEfficiency({
    workSum: 0, workCount: 0,
    storedSum: 0, storedCount: 0,
    totalObservations: 40,
    metrics: createWorkerMetrics(),
  });
  expect(r.corpus.ratio).toBeNull();
  expect(r.corpus.saved_pct).toBeNull();
  expect(r.corpus.coverage).toEqual({ with_data: 0, total: 40 });
});

test('computeEfficiency — stored larger than work clamps saved_pct to 0', () => {
  const r = computeEfficiency({
    workSum: 100, workCount: 1,
    storedSum: 250, storedCount: 1,
    totalObservations: 1,
    metrics: createWorkerMetrics(),
  });
  expect(r.corpus.saved_pct).toBe(0);
  expect(r.corpus.ratio).toBe(0.4);
});

test('computeEfficiency — embedder + dedup derived from metrics', () => {
  const m = createWorkerMetrics();
  recordEmbed(m, 8000, 2000);     // 8000 tokens in 2000 ms
  recordEmbed(m, 2000, 500);      // total 10000 tokens, 2500 ms, 2 calls
  recordIndexResult(m, 'indexed');
  recordIndexResult(m, 'skipped');
  recordIndexResult(m, 'skipped');
  recordIndexResult(m, 'skipped');

  const r = computeEfficiency({
    workSum: 0, workCount: 0, storedSum: 0, storedCount: 0,
    totalObservations: 0, metrics: m,
  });
  expect(r.embedder).toEqual({ calls: 2, avg_latency_ms: 1250, tokens_per_s: 4000 });
  expect(r.dedup).toEqual({ docs_seen: 4, skipped_unchanged: 3, skip_pct: 75 });
});

test('computeEfficiency — zero embedder/dedup activity does not divide by zero', () => {
  const r = computeEfficiency({
    workSum: 0, workCount: 0, storedSum: 0, storedCount: 0,
    totalObservations: 0, metrics: createWorkerMetrics(),
  });
  expect(r.embedder).toEqual({ calls: 0, avg_latency_ms: 0, tokens_per_s: 0 });
  expect(r.dedup).toEqual({ docs_seen: 0, skipped_unchanged: 0, skip_pct: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/efficiency.test.ts`
Expected: FAIL — `Cannot find module '../../src/worker/efficiency.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/worker/efficiency.ts`:

```ts
import type { WorkerMetrics } from './metrics.ts';

export interface EfficiencyInput {
  workSum: number;          // SUM(work_tokens) over observations
  workCount: number;        // COUNT(work_tokens) — non-null rows
  storedSum: number;        // SUM(stored_tokens)
  storedCount: number;      // COUNT(stored_tokens) — non-null rows
  totalObservations: number;
  metrics: WorkerMetrics;
}

export interface EfficiencyReport {
  corpus: {
    work_tokens: number;
    stored_tokens: number;
    ratio: number | null;        // work / stored, 1 decimal; null when undefined
    saved_pct: number | null;    // 100*(work-stored)/work, clamped [0,100]; null when undefined
    coverage: { with_data: number; total: number };
  };
  embedder: { calls: number; avg_latency_ms: number; tokens_per_s: number };
  dedup: { docs_seen: number; skipped_unchanged: number; skip_pct: number };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function computeEfficiency(input: EfficiencyInput): EfficiencyReport {
  const { workSum, workCount, storedSum, storedCount, totalObservations, metrics } = input;

  // Compression is only meaningful when both halves have data. If no
  // observation carries work_tokens, or nothing has been stored yet, report
  // null so the CLI shows a "run reindex" hint instead of a bogus ratio.
  const hasCorpus = workCount > 0 && workSum > 0 && storedCount > 0 && storedSum > 0;
  const ratio = hasCorpus ? round1(workSum / storedSum) : null;
  const saved_pct = hasCorpus
    ? Math.max(0, Math.min(100, Math.round(((workSum - storedSum) / workSum) * 100)))
    : null;

  const avg_latency_ms = metrics.embedCalls > 0
    ? Math.round(metrics.embedMs / metrics.embedCalls)
    : 0;
  const tokens_per_s = metrics.embedMs > 0
    ? Math.round(metrics.embedTokens / (metrics.embedMs / 1000))
    : 0;
  const skip_pct = metrics.docsSeen > 0
    ? Math.round((metrics.docsSkippedUnchanged / metrics.docsSeen) * 100)
    : 0;

  return {
    corpus: {
      work_tokens: workSum,
      stored_tokens: storedSum,
      ratio,
      saved_pct,
      coverage: { with_data: workCount, total: totalObservations },
    },
    embedder: { calls: metrics.embedCalls, avg_latency_ms, tokens_per_s },
    dedup: {
      docs_seen: metrics.docsSeen,
      skipped_unchanged: metrics.docsSkippedUnchanged,
      skip_pct,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/efficiency.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/worker/efficiency.ts tests/unit/efficiency.test.ts
git commit -m "feat(worker): pure computeEfficiency() formatter"
```

---

## Task 4: IngestPipeline dedup hook

**Files:**
- Modify: `src/worker/ingest.ts:12-43,51-58,103-109`
- Test: `tests/integration/ingest.test.ts`

`IngestPipeline.indexFile()` already short-circuits on an unchanged sha (`ingest.ts:57-58`). It must report each outcome so the worker can count dedup skips — without IngestPipeline itself depending on `WorkerMetrics`.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/ingest.test.ts`:

```ts
test('IngestPipeline — onIndexResult reports indexed then skipped on unchanged sha', async () => {
  const results: Array<'indexed' | 'skipped'> = [];
  const pipe = new IngestPipeline({
    meta: store,
    embedder: fakeEmbedder,
    vector: fakeVectorStore as any,
    collectionName: 'test_col',
    projectId: 'erp-platform',
    onIndexResult: (r) => results.push(r),
  });
  const filePath = join(workDir, 'feedback_dedup.md');
  writeFileSync(filePath, '---\ntype: feedback\ndescription: d\n---\nBody text here.');

  await pipe.indexFile(filePath, 'memory');   // first pass — content is new
  await pipe.indexFile(filePath, 'memory');   // second pass — sha unchanged

  expect(results).toEqual(['indexed', 'skipped']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/ingest.test.ts`
Expected: FAIL — `onIndexResult` is not a recognised option / `results` is `['indexed', 'indexed']` or empty.

- [ ] **Step 3: Add the `onIndexResult` option**

In `src/worker/ingest.ts`, add to `IngestPipelineOptions` (after `maxInputTokens?`):

```ts
  /**
   * Fired once per indexFile() call: 'indexed' when the file was (re)chunked
   * and embedded, 'skipped' when its content sha was unchanged. Lets the
   * worker track dedup hit-rate without IngestPipeline knowing about
   * WorkerMetrics.
   */
  onIndexResult?: (result: 'indexed' | 'skipped') => void;
```

Add the private field + constructor assignment:

```ts
  private onIndexResult: ((result: 'indexed' | 'skipped') => void) | undefined;
```

```ts
    this.onIndexResult = opts.onIndexResult;
```

- [ ] **Step 4: Fire the callback at both outcomes**

In `indexFile()`, change the unchanged-sha early return (`ingest.ts:57-58`):

```ts
    const existing = this.meta.getDocument(filePath);
    if (existing && existing.sha === sha) {
      this.onIndexResult?.('skipped');
      return;
    }
```

At the end of `indexFile()`, after the `await this.vector.add(...)` call (line 108), add:

```ts
    this.onIndexResult?.('indexed');
```

Also fire `'indexed'` on the empty-file branch — replace the `if (chunks.length === 0) { ... return; }` block body so it ends with the callback:

```ts
    if (chunks.length === 0) {
      // Empty file or all-whitespace — drop the document if it existed
      if (existing) this.meta.deleteDocument(filePath);
      this.onIndexResult?.('indexed');
      return;
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/integration/ingest.test.ts`
Expected: PASS — including the existing tests (the callback is optional, so older `new IngestPipeline(...)` calls are unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/worker/ingest.ts tests/integration/ingest.test.ts
git commit -m "feat(ingest): onIndexResult hook for dedup metrics"
```

---

## Task 5: Wire metrics into the worker + `/stats` efficiency field

**Files:**
- Modify: `src/worker/index.ts` (imports; `metrics` object; `timedEmbed` helper; both `chunkObservation` capture sites; IngestPipeline `onIndexResult`; `/stats` handler)
- Test: `tests/integration/worker-efficiency.test.ts` *(new)*

- [ ] **Step 1: Write the failing test**

Create `tests/integration/worker-efficiency.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { ObservationsStore } from '../../src/worker/observations-store.ts';

const PORT = 39912;
let worker: WorkerHandle;
let workDir: string;
let obsDbPath: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-eff-'));
  obsDbPath = join(workDir, 'obs.db');
  worker = await startWorker({
    port: PORT,
    projectId: 'eff-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: obsDbPath,
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    summarize: async (events) => ({
      type: 'change',
      title: `summary of ${events.length} events`,
      narrative: 'stub narrative for efficiency test',
      facts: events.map(e => `${e.tool_name}: ${e.tool_input_summary}`),
      concepts: ['stub'],
    }),
    observationTickMs: 0,
  });
});

afterEach(async () => {
  await worker.stop();
  rmSync(workDir, { recursive: true, force: true });
});

test('GET /stats — efficiency object has the expected shape', async () => {
  const stats = await (await fetch(`http://localhost:${PORT}/stats`)).json();
  expect(stats.efficiency).toBeDefined();
  expect(stats.efficiency.corpus).toMatchObject({
    work_tokens: expect.any(Number),
    stored_tokens: expect.any(Number),
    coverage: { with_data: expect.any(Number), total: expect.any(Number) },
  });
  expect(stats.efficiency.embedder).toMatchObject({
    calls: expect.any(Number),
    avg_latency_ms: expect.any(Number),
    tokens_per_s: expect.any(Number),
  });
  expect(stats.efficiency.dedup).toMatchObject({
    docs_seen: expect.any(Number),
    skipped_unchanged: expect.any(Number),
    skip_pct: expect.any(Number),
  });
});

test('ingesting an observation populates stored_tokens', async () => {
  await fetch(`http://localhost:${PORT}/observation/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 's-eff', project_id: 'eff-test', prompt_number: 1,
      tool_name: 'Edit', tool_input_summary: 'edit foo.ts',
      tool_result_summary: 'ok', files_read: [], files_modified: ['foo.ts'],
      ts_epoch: 1_700_000_000,
    }),
  });
  await fetch(`http://localhost:${PORT}/observation/flush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's-eff' }),
  });

  // Open a second read connection on the same DB file (WAL allows concurrent
  // readers) and confirm the ingest path wrote stored_tokens.
  const reader = new ObservationsStore(obsDbPath);
  const recent = reader.listRecent(1);
  reader.close();
  expect(recent).toHaveLength(1);
  expect(recent[0]!.stored_tokens).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/worker-efficiency.test.ts`
Expected: FAIL — `stats.efficiency` is `undefined`; `stored_tokens` is `null`.

- [ ] **Step 3: Add imports to `index.ts`**

At the top of `src/worker/index.ts`, alongside the other imports, add:

```ts
import { createWorkerMetrics, recordEmbed, recordIndexResult } from './metrics.ts';
import { computeEfficiency } from './efficiency.ts';
import { countTokens } from '../shared/tokens.ts';
```

(If `countTokens` is already imported, do not duplicate it.)

- [ ] **Step 4: Create the metrics object and `timedEmbed` helper**

In `startWorker()`, immediately before the `const ingest = new IngestPipeline({` declaration (~line 250), add:

```ts
  const metrics = createWorkerMetrics();

  // Single timed wrapper around embedder.embed() for the indexing paths.
  // Token counting here is cheap relative to the embed call it wraps and
  // runs off the /stats hot path.
  async function timedEmbed(texts: string[]): Promise<number[][]> {
    const t0 = performance.now();
    try {
      return await embedder.embed(texts);
    } finally {
      const ms = performance.now() - t0;
      const tokens = texts.reduce((n, t) => n + countTokens(t), 0);
      recordEmbed(metrics, tokens, ms);
    }
  }
```

- [ ] **Step 5: Route the indexing embed calls through `timedEmbed` + add `onIndexResult`**

In the `new IngestPipeline({ ... })` options object, add:

```ts
    onIndexResult: (result) => recordIndexResult(metrics, result),
```

Inside the IngestPipeline `embedder.embed` closure, change `return await embedder.embed(texts);` to:

```ts
          return await timedEmbed(texts);
```

In `ingestObservation()`, change line 402 `embeddings = await embedder.embed(chunksWithIds.map(c => c.text));` to:

```ts
        embeddings = await timedEmbed(chunksWithIds.map(c => c.text));
```

In the reindex batch path, change `flatEmbeddings = await embedder.embed(flatTexts);` (~line 941) to:

```ts
                flatEmbeddings = await timedEmbed(flatTexts);
```

- [ ] **Step 6: Capture `stored_tokens` at both `chunkObservation` sites**

In `ingestObservation()`, immediately after `chunksWithIds` is constructed (~line 388, before the embed block), add:

```ts
    const storedTokens = chunksWithIds.reduce((n, c) => n + countTokens(c.text), 0);
    obsStore.setStoredTokens(obs.id, storedTokens);
```

In the reindex path, inside the `for (const p of prepared)` loop (after `cursor += n;`, ~line 953), add:

```ts
      const pStoredTokens = p.chunksWithIds.reduce((n, c) => n + countTokens(c.text), 0);
      obsStore.setStoredTokens(p.obs.id, pStoredTokens);
```

(Both sites run only when `obsStore` is non-null — `ingestObservation` and the reindex handler are already inside that guard.)

- [ ] **Step 7: Add `efficiency` to the `/stats` response**

In the `/stats` handler (`index.ts:714-741`), after the `const diskBytes = ...` line and before `return Response.json({`, add:

```ts
        const workTok = obsStore ? obsStore.sumWorkTokens() : { sum: 0, count: 0 };
        const storedTok = obsStore ? obsStore.sumStoredTokens() : { sum: 0, count: 0 };
        const efficiency = computeEfficiency({
          workSum: workTok.sum, workCount: workTok.count,
          storedSum: storedTok.sum, storedCount: storedTok.count,
          totalObservations: obsTotal,
          metrics,
        });
```

Then add `efficiency,` as a field in the `Response.json({ ... })` object (e.g. right after `disk: { ... },`).

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test tests/integration/worker-efficiency.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 9: Run the full worker integration suite to check nothing regressed**

Run: `bun test tests/integration/`
Expected: PASS — no regressions.

- [ ] **Step 10: Commit**

```bash
git add src/worker/index.ts tests/integration/worker-efficiency.test.ts
git commit -m "feat(worker): efficiency field in /stats + metrics wiring"
```

---

## Task 6: `stats` CLI output + skill doc

**Files:**
- Modify: `src/cli/commands/stats.ts`
- Modify: `plugin/skills/stats/SKILL.md`
- Test: `tests/unit/cli/stats-efficiency.test.ts` *(new)*

- [ ] **Step 1: Write the failing test**

Create `tests/unit/cli/stats-efficiency.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { formatEfficiencyLines } from '../../../src/cli/commands/stats.ts';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('formatEfficiencyLines — renders compression, embedder and dedup', () => {
  const lines = formatEfficiencyLines({
    corpus: {
      work_tokens: 184320, stored_tokens: 11240,
      ratio: 16.4, saved_pct: 94,
      coverage: { with_data: 312, total: 340 },
    },
    embedder: { calls: 47, avg_latency_ms: 690, tokens_per_s: 4100 },
    dedup: { docs_seen: 512, skipped_unchanged: 488, skip_pct: 95 },
  }).map(stripAnsi);

  expect(lines.some(l => l.includes('16.4×'))).toBe(true);
  expect(lines.some(l => l.includes('94% saved') && l.includes('312/340'))).toBe(true);
  expect(lines.some(l => l.includes('47 calls') && l.includes('690 ms'))).toBe(true);
  expect(lines.some(l => l.includes('95%') && l.includes('488/512'))).toBe(true);
});

test('formatEfficiencyLines — null ratio shows reindex hint', () => {
  const lines = formatEfficiencyLines({
    corpus: {
      work_tokens: 0, stored_tokens: 0, ratio: null, saved_pct: null,
      coverage: { with_data: 0, total: 40 },
    },
    embedder: { calls: 0, avg_latency_ms: 0, tokens_per_s: 0 },
    dedup: { docs_seen: 0, skipped_unchanged: 0, skip_pct: 0 },
  }).map(stripAnsi);

  expect(lines.some(l => l.includes("run 'captain-memo reindex'"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/cli/stats-efficiency.test.ts`
Expected: FAIL — `formatEfficiencyLines` is not exported from `stats.ts`.

- [ ] **Step 3: Add the `efficiency` field to `StatsResponse` and an `EfficiencyReport` import**

In `src/cli/commands/stats.ts`, add to the top imports:

```ts
import type { EfficiencyReport } from '../../worker/efficiency.ts';
```

Add an optional field to the `StatsResponse` interface (so the CLI degrades gracefully against an older worker):

```ts
  efficiency?: EfficiencyReport;
```

- [ ] **Step 4: Add the exported `formatEfficiencyLines` function**

In `src/cli/commands/stats.ts`, add this exported function (above `statsCommand`):

```ts
/**
 * Render the "Efficiency" block for `captain-memo stats`. Returned as an array
 * of lines (already coloured) so it is unit-testable without capturing stdout.
 */
export function formatEfficiencyLines(eff: EfficiencyReport): string[] {
  const lines: string[] = ['Efficiency', '──────────'];

  const c = eff.corpus;
  if (c.ratio === null || c.saved_pct === null) {
    lines.push(`  Compression:    \x1b[33m— (run 'captain-memo reindex' to populate)\x1b[0m`);
  } else {
    lines.push(
      `  Compression:    ${c.ratio}× — distilled ${c.work_tokens.toLocaleString()} tokens ` +
      `of work into ${c.stored_tokens.toLocaleString()} stored`,
    );
    lines.push(
      `                  (${c.saved_pct}% saved · based on ` +
      `${c.coverage.with_data}/${c.coverage.total} observations)`,
    );
  }

  const e = eff.embedder;
  lines.push(e.calls > 0
    ? `  Embedder:       ${e.calls} calls · ~${e.avg_latency_ms} ms avg · ` +
      `${e.tokens_per_s.toLocaleString()} tok/s   (since worker start)`
    : `  Embedder:       — (no embeds since worker start)`);

  const d = eff.dedup;
  lines.push(d.docs_seen > 0
    ? `  Dedup:          ${d.skip_pct}% of docs skipped re-embed ` +
      `(${d.skipped_unchanged}/${d.docs_seen} unchanged)`
    : `  Dedup:          — (no documents indexed since worker start)`);

  return lines;
}
```

- [ ] **Step 5: Print the block from `statsCommand`**

In `statsCommand`, after the `disk` line is printed and before `return 0;`, add:

```ts
  if (stats.efficiency) {
    console.log('');
    for (const line of formatEfficiencyLines(stats.efficiency)) console.log(line);
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/unit/cli/stats-efficiency.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 7: Update the skill doc**

In `plugin/skills/stats/SKILL.md`, in the "Output format" section, append the Efficiency block to the example output and add a sentence describing it. After the existing `Embedder:` line in the fenced block, add:

```
  Embedder:       <model> @ <endpoint>

Efficiency
──────────
  Compression:    16.4× — distilled 184,320 tokens of work into 11,240 stored
                  (94% saved · based on 312/340 observations)
  Embedder:       47 calls · ~690 ms avg · 4,100 tok/s   (since worker start)
  Dedup:          95% of docs skipped re-embed (488/512 unchanged)
```

And add a sentence under it:

```
The `efficiency` block reports corpus compression (summed observation
`work_tokens` vs `stored_tokens`), embedder throughput, and dedup hit-rate.
If compression shows "— (run 'captain-memo reindex' …)", the corpus has no
`work_tokens` data yet — reindex to populate it.
```

Also extend the "The response includes:" sentence near the top to mention `efficiency`.

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/stats.ts plugin/skills/stats/SKILL.md tests/unit/cli/stats-efficiency.test.ts
git commit -m "feat(stats): Efficiency block in stats CLI + skill doc"
```

---

## Task 7: Release v0.1.9

**Files:**
- Modify: `package.json:2` (version)

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS — all unit, integration and hook tests green. If anything fails, fix before continuing.

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: no type errors.

- [ ] **Step 3: Bump the version**

In `package.json`, change `"version": "0.1.8"` to `"version": "0.1.9"`.

(Leave `plugin/.claude-plugin/plugin.json` at its current `0.1.0` — it tracks the plugin manifest separately and is not part of this release bump, consistent with the v0.1.8 release.)

- [ ] **Step 4: Commit the release**

```bash
git add package.json
git commit -m "chore: release v0.1.9

Snapshot efficiency stats: /stats and captain-memo stats now report
corpus compression (work_tokens distilled vs stored_tokens paid),
embedder throughput, and dedup hit-rate.

A new nullable observations.stored_tokens column is captured at index
time, so /stats stays O(1) on the session-start hot path. Older
observations backfill on the next reindex/upgrade."
```

---

## Self-Review Notes

- **Spec coverage:** migration v3 + `stored_tokens` (Task 1) ✓; capture at both ingest sites (Task 5 Step 6) ✓; `WorkerMetrics` (Task 2) ✓; `/stats` `efficiency` field (Task 5) ✓; pure `computeEfficiency()` (Task 3) ✓; coverage disclosure + null-ratio edge cases (Task 3 tests) ✓; CLI block + SKILL.md (Task 6) ✓; embedder + dedup instrumentation (Tasks 4 & 5) ✓; tests at unit + integration level (every task) ✓.
- **Type consistency:** `WorkerMetrics` shape is defined once in Task 2 and consumed unchanged in Tasks 3 & 5; `EfficiencyReport` is defined in Task 3 and consumed unchanged in Task 6; `NewObservation` is narrowed in Task 1 so no `insert()` caller needs `stored_tokens`.
- **Backfill:** no separate script — the reindex capture site (Task 5 Step 6) means `captain-memo reindex` / `upgrade` repopulate `stored_tokens` for pre-v0.1.9 observations.
