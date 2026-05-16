# Stats Efficiency Fix + Captain's Log Revamp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the mismatched-population compression ratio, backfill `stored_tokens` for historical observations with no embedding, and revamp `captain-memo stats` into a framed, TTY-aware, nautical-themed panel.

**Architecture:** The ratio fix is one atomic change across `observations-store.ts` → `efficiency.ts` → the `/stats` handler (sum work + stored over the *same* paired rows). The backfill is a background pass on worker startup — pure CPU (`chunkObservation` + `countTokens`), no embedder calls. The display revamp extracts a pure `renderStats()` into a new `stats-render.ts` that uses only the existing TTY-aware `ansi.ts` helpers.

**Tech Stack:** TypeScript, Bun runtime, `bun:sqlite`, `bun test`.

**Spec:** `docs/specs/2026-05-16-stats-captains-log-design.md`

---

## File Structure

- `src/worker/observations-store.ts` — `sumPairedTokens` replaces `sumWorkTokens`/`sumStoredTokens`; add `countMissingStoredTokens`, `listMissingStoredTokens`.
- `src/worker/efficiency.ts` — `EfficiencyInput` reshaped to paired sums.
- `src/worker/index.ts` — `/stats` uses `sumPairedTokens`; background `stored_tokens` backfill pass.
- `src/shared/ansi.ts` — honour the `NO_COLOR` env var.
- `src/cli/stats-render.ts` — *new* — pure `renderStats()`, `bar()`, `fmtCount()`, the moved+exported `StatsResponse` type.
- `src/cli/commands/stats.ts` — slimmed to fetch + `--json` + `renderStats`.
- Tests — `tests/unit/observations-store.test.ts`, `tests/unit/efficiency.test.ts`, `tests/unit/ansi.test.ts` (*new*), `tests/unit/cli/stats-render.test.ts` (*new*, replaces `stats-efficiency.test.ts`), `tests/integration/worker-efficiency.test.ts`.

---

## Task 1: Ratio-correctness fix (paired sums)

This is one atomic change — `observations-store.ts`, `efficiency.ts`, and the `/stats` handler must change together or `index.ts` won't type-check.

**Files:**
- Modify: `src/worker/observations-store.ts`
- Modify: `src/worker/efficiency.ts`
- Modify: `src/worker/index.ts` (`/stats` handler, ~line 743-750)
- Test: `tests/unit/observations-store.test.ts`, `tests/unit/efficiency.test.ts`

- [ ] **Step 1: Rewrite the failing tests**

In `tests/unit/observations-store.test.ts`, REPLACE the test named `'ObservationsStore — sumWorkTokens / sumStoredTokens ignore NULL rows'` (entire test) with:

```ts
test('ObservationsStore — sumPairedTokens sums only rows with BOTH tokens', () => {
  const mk = (work: number | null) => store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: work,
  });
  const a = mk(100);   // will get stored_tokens → paired
  const b = mk(200);   // will get stored_tokens → paired
  mk(300);             // work only, no stored → NOT paired
  const d = mk(null);  // stored only, no work → NOT paired
  store.setStoredTokens(a, 10);
  store.setStoredTokens(b, 20);
  store.setStoredTokens(d, 999);

  expect(store.sumPairedTokens()).toEqual({ work: 300, stored: 30, paired: 2 });
});

test('ObservationsStore — sumPairedTokens is zeroed on an empty corpus', () => {
  expect(store.sumPairedTokens()).toEqual({ work: 0, stored: 0, paired: 0 });
});
```

In `tests/unit/efficiency.test.ts`, REPLACE THE ENTIRE FILE with:

```ts
import { test, expect } from 'bun:test';
import { computeEfficiency } from '../../src/worker/efficiency.ts';
import { createWorkerMetrics, recordEmbed, recordIndexResult } from '../../src/worker/metrics.ts';

test('computeEfficiency — paired corpus produces ratio and saved_pct', () => {
  const r = computeEfficiency({
    workSum: 160000, storedSum: 10000, pairedCount: 300,
    totalObservations: 320, metrics: createWorkerMetrics(),
  });
  expect(r.corpus.ratio).toBe(16);
  expect(r.corpus.saved_pct).toBe(94);
  expect(r.corpus.coverage).toEqual({ with_data: 300, total: 320 });
});

test('computeEfficiency — zero paired rows yields null ratio (no misleading number)', () => {
  const r = computeEfficiency({
    workSum: 0, storedSum: 0, pairedCount: 0,
    totalObservations: 40, metrics: createWorkerMetrics(),
  });
  expect(r.corpus.ratio).toBeNull();
  expect(r.corpus.saved_pct).toBeNull();
  expect(r.corpus.coverage).toEqual({ with_data: 0, total: 40 });
});

test('computeEfficiency — stored larger than work clamps saved_pct to 0', () => {
  const r = computeEfficiency({
    workSum: 100, storedSum: 250, pairedCount: 1,
    totalObservations: 1, metrics: createWorkerMetrics(),
  });
  expect(r.corpus.saved_pct).toBe(0);
  expect(r.corpus.ratio).toBe(0.4);
});

test('computeEfficiency — embedder + dedup derived from metrics', () => {
  const m = createWorkerMetrics();
  recordEmbed(m, 8000, 2000);
  recordEmbed(m, 2000, 500);
  recordIndexResult(m, 'indexed');
  recordIndexResult(m, 'skipped');
  recordIndexResult(m, 'skipped');
  recordIndexResult(m, 'skipped');

  const r = computeEfficiency({
    workSum: 0, storedSum: 0, pairedCount: 0,
    totalObservations: 0, metrics: m,
  });
  expect(r.embedder).toEqual({ calls: 2, avg_latency_ms: 1250, tokens_per_s: 4000 });
  expect(r.dedup).toEqual({ docs_seen: 4, skipped_unchanged: 3, skip_pct: 75 });
});

test('computeEfficiency — zero embedder/dedup activity does not divide by zero', () => {
  const r = computeEfficiency({
    workSum: 0, storedSum: 0, pairedCount: 0,
    totalObservations: 0, metrics: createWorkerMetrics(),
  });
  expect(r.embedder).toEqual({ calls: 0, avg_latency_ms: 0, tokens_per_s: 0 });
  expect(r.dedup).toEqual({ docs_seen: 0, skipped_unchanged: 0, skip_pct: 0 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/observations-store.test.ts tests/unit/efficiency.test.ts`
Expected: FAIL — `store.sumPairedTokens is not a function`, and `computeEfficiency` type/shape mismatch.

- [ ] **Step 3: Replace the sum methods in `observations-store.ts`**

In `src/worker/observations-store.ts`, DELETE the `sumWorkTokens()` and `sumStoredTokens()` methods and add in their place:

```ts
  /**
   * Sum work_tokens and stored_tokens over the SAME observations — only rows
   * carrying BOTH values. Summing them independently would divide totals
   * describing different populations and yield a meaningless ratio.
   */
  sumPairedTokens(): { work: number; stored: number; paired: number } {
    return this.db
      .query(
        `SELECT COALESCE(SUM(work_tokens), 0)   AS work,
                COALESCE(SUM(stored_tokens), 0) AS stored,
                COUNT(*)                        AS paired
         FROM observations
         WHERE work_tokens IS NOT NULL AND stored_tokens IS NOT NULL`,
      )
      .get() as { work: number; stored: number; paired: number };
  }
```

- [ ] **Step 4: Reshape `efficiency.ts`**

In `src/worker/efficiency.ts`, REPLACE the `EfficiencyInput` interface and the `computeEfficiency` body so it uses paired sums. The new `EfficiencyInput`:

```ts
export interface EfficiencyInput {
  workSum: number;          // SUM(work_tokens)   over paired observations
  storedSum: number;        // SUM(stored_tokens) over the SAME observations
  pairedCount: number;      // observations carrying BOTH values
  totalObservations: number;
  metrics: WorkerMetrics;
}
```

In `computeEfficiency`, change the destructuring and the guard:

```ts
  const { workSum, storedSum, pairedCount, totalObservations, metrics } = input;

  // Compression is only meaningful when work and stored are summed over the
  // same observations. pairedCount is the count of rows with BOTH values.
  const hasCorpus = pairedCount > 0 && workSum > 0 && storedSum > 0;
```

And change the `coverage` field in the returned object to:

```ts
      coverage: { with_data: pairedCount, total: totalObservations },
```

Leave `EfficiencyReport`, `ratio`, `saved_pct`, `embedder`, and `dedup` exactly as they are.

- [ ] **Step 5: Update the `/stats` handler in `index.ts`**

In `src/worker/index.ts`, in the `/stats` handler, REPLACE these lines:

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

with:

```ts
        const paired = obsStore
          ? obsStore.sumPairedTokens()
          : { work: 0, stored: 0, paired: 0 };
        const efficiency = computeEfficiency({
          workSum: paired.work, storedSum: paired.stored, pairedCount: paired.paired,
          totalObservations: obsTotal,
          metrics,
        });
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test tests/unit/observations-store.test.ts tests/unit/efficiency.test.ts`
Expected: PASS.
Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/worker/observations-store.ts src/worker/efficiency.ts src/worker/index.ts tests/unit/observations-store.test.ts tests/unit/efficiency.test.ts
git commit -m "fix(efficiency): compute compression ratio over paired rows only"
```

---

## Task 2: `stored_tokens` backfill on worker startup

**Files:**
- Modify: `src/worker/observations-store.ts`
- Modify: `src/worker/index.ts`
- Test: `tests/unit/observations-store.test.ts`, `tests/integration/worker-efficiency.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Append to `tests/unit/observations-store.test.ts`:

```ts
test('ObservationsStore — countMissingStoredTokens / listMissingStoredTokens', () => {
  const mk = () => store.insert({
    session_id: 's1', project_id: 'p1', prompt_number: 1,
    type: 'feature', title: 't', narrative: '', facts: [], concepts: [],
    files_read: [], files_modified: [], created_at_epoch: 100,
    branch: null, work_tokens: null,
  });
  const a = mk(); const b = mk(); mk();   // 3 rows, all stored_tokens NULL
  store.setStoredTokens(a, 5);            // a no longer missing

  expect(store.countMissingStoredTokens()).toBe(2);

  const missing = store.listMissingStoredTokens(10);
  expect(missing.map(o => o.id)).toEqual([b, b + 1]);

  expect(store.listMissingStoredTokens(1)).toHaveLength(1);   // respects limit
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/observations-store.test.ts`
Expected: FAIL — `countMissingStoredTokens is not a function`.

- [ ] **Step 3: Add the two query methods**

In `src/worker/observations-store.ts`, add after `sumPairedTokens()`:

```ts
  /** Count observations whose stored_tokens has not been captured yet. */
  countMissingStoredTokens(): number {
    return (this.db
      .query('SELECT COUNT(*) AS n FROM observations WHERE stored_tokens IS NULL')
      .get() as { n: number }).n;
  }

  /** Oldest-first batch of observations still missing stored_tokens. */
  listMissingStoredTokens(limit: number): Observation[] {
    const rows = this.db
      .query('SELECT * FROM observations WHERE stored_tokens IS NULL ORDER BY id ASC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => this.hydrate(r));
  }
```

- [ ] **Step 4: Run unit test to verify it passes**

Run: `bun test tests/unit/observations-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing integration test**

Append to `tests/integration/worker-efficiency.test.ts` (the file already imports `startWorker`, `WorkerHandle`, `ObservationsStore`, `mkdtempSync`, `rmSync`, `join`, `tmpdir`):

```ts
test('worker startup backfills stored_tokens for pre-existing observations', async () => {
  // Pre-seed an observations DB with rows that have work_tokens but NO
  // stored_tokens — the pre-v0.1.9 state.
  const seedDir = mkdtempSync(join(tmpdir(), 'captain-memo-eff-seed-'));
  const seedDbPath = join(seedDir, 'obs.db');
  const seed = new ObservationsStore(seedDbPath);
  for (let i = 0; i < 3; i++) {
    seed.insert({
      session_id: 's-seed', project_id: 'eff-test', prompt_number: i,
      type: 'feature', title: `seeded observation ${i}`,
      narrative: 'a narrative long enough to chunk into real tokens',
      facts: ['fact one', 'fact two'], concepts: ['c'],
      files_read: [], files_modified: [], created_at_epoch: 1_700_000_000 + i,
      branch: null, work_tokens: 5000,
    });
  }
  seed.close();

  const seedWorker = await startWorker({
    port: 39913,
    projectId: 'eff-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(seedDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    observationQueueDbPath: join(seedDir, 'queue.db'),
    observationsDbPath: seedDbPath,
    pendingEmbedDbPath: join(seedDir, 'pending.db'),
    summarize: async () => ({ type: 'change', title: 't', narrative: '', facts: [], concepts: [] }),
    observationTickMs: 0,
  });

  // Poll /stats until the background backfill has populated all 3 rows.
  let corpus: any = null;
  for (let i = 0; i < 50; i++) {
    const s = await (await fetch('http://localhost:39913/stats')).json();
    corpus = s.efficiency.corpus;
    if (corpus.coverage.with_data === 3) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await seedWorker.stop();

  const reader = new ObservationsStore(seedDbPath);
  const all = reader.listRecent(10);
  reader.close();
  rmSync(seedDir, { recursive: true, force: true });

  expect(all.every(o => typeof o.stored_tokens === 'number' && o.stored_tokens! > 0)).toBe(true);
  expect(corpus.coverage.with_data).toBe(3);
  expect(corpus.ratio).toBeGreaterThan(0);
});
```

Run: `bun test tests/integration/worker-efficiency.test.ts`
Expected: FAIL — `coverage.with_data` never reaches 3 (no backfill yet).

- [ ] **Step 6: Add the background backfill pass to `startWorker()`**

In `src/worker/index.ts`, locate the end of the `if (opts.watchPaths && opts.watchPaths.length > 0 && opts.watchChannel) { ... }` block (the initial-indexing/watcher block). Immediately AFTER that block closes, add:

```ts
  // One-time stored_tokens backfill. The column is captured at index time, so
  // observations indexed before v0.1.9 have it NULL. Pure CPU — chunk + count
  // tokens, NO embedder calls. Backgrounded so the HTTP server is up
  // immediately; resumable + idempotent (a later boot with nothing missing is
  // a no-op). Batched so a setStoredTokens write never races a live cursor.
  if (obsStore) {
    const missingStored = obsStore.countMissingStoredTokens();
    if (missingStored > 0) {
      console.error(`[worker] stored_tokens backfill: ${missingStored} observations`);
      const store = obsStore;
      void (async () => {
        const BACKFILL_BATCH = 200;
        let done = 0;
        for (;;) {
          const batch = store.listMissingStoredTokens(BACKFILL_BATCH);
          if (batch.length === 0) break;
          for (const obs of batch) {
            const rawChunks = chunkObservation(obs);
            const chunks = rawChunks.length > 0
              ? splitForEmbed(rawChunks, effectiveMaxInputTokens)
              : [];
            const tokens = chunks.reduce((n, c) => n + countTokens(c.text), 0);
            store.setStoredTokens(obs.id, tokens);
            done++;
          }
        }
        console.error(`[worker] stored_tokens backfill complete: ${done} observations`);
      })();
    }
  }
```

`chunkObservation`, `splitForEmbed`, `countTokens`, and `effectiveMaxInputTokens` are all already in scope in `startWorker()`. The `const store = obsStore;` capture narrows the type to non-null inside the async closure. An observation whose chunker yields nothing is set to `stored_tokens = 0` (it occupies no corpus space) — this also clears it from the `IS NULL` set so the loop terminates.

- [ ] **Step 7: Run tests + typecheck**

Run: `bun test tests/integration/worker-efficiency.test.ts tests/unit/observations-store.test.ts`
Expected: PASS.
Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/worker/observations-store.ts src/worker/index.ts tests/unit/observations-store.test.ts tests/integration/worker-efficiency.test.ts
git commit -m "feat(worker): background stored_tokens backfill on startup"
```

---

## Task 3: `NO_COLOR` support in `ansi.ts`

**Files:**
- Modify: `src/shared/ansi.ts`
- Test: `tests/unit/ansi.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ansi.test.ts`:

```ts
import { test, expect, afterEach } from 'bun:test';
import { cyan } from '../../src/shared/ansi.ts';

afterEach(() => { delete process.env.NO_COLOR; });

test('ansi — NO_COLOR strips colour even when stdout is a TTY', () => {
  const originalIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    process.env.NO_COLOR = '1';
    expect(cyan('hello')).toBe('hello');           // no escape codes
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  }
});

test('ansi — empty NO_COLOR value still disables colour (presence is the signal)', () => {
  const originalIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    process.env.NO_COLOR = '';
    expect(cyan('hello')).toBe('hello');
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/ansi.test.ts`
Expected: FAIL — `cyan('hello')` still returns escape-wrapped text under a faked TTY.

- [ ] **Step 3: Honour `NO_COLOR` in `ansi.ts`**

In `src/shared/ansi.ts`, change the `isTTY` export so the standard `NO_COLOR` convention disables colour. The convention: colour is disabled when the env var is **present**, regardless of its value (see no-color.org).

```ts
// TTY-aware ANSI helpers. When stdout is a pipe/file, codes drop out so log
// captures stay readable. The standard NO_COLOR env var (no-color.org) also
// force-disables colour — presence of the var is the signal, any value.
const RESET = '\x1b[0m';

export const isTTY = (): boolean =>
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
```

Leave `wrap` and every colour helper unchanged — they already route through `isTTY()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/ansi.test.ts`
Expected: PASS.
Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ansi.ts tests/unit/ansi.test.ts
git commit -m "feat(ansi): honour the NO_COLOR env var"
```

---

## Task 4: `stats-render.ts` — framed Captain's Log renderer

**Files:**
- Create: `src/cli/stats-render.ts`
- Create: `tests/unit/cli/stats-render.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/cli/stats-render.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { bar, renderStats, type StatsResponse } from '../../../src/cli/stats-render.ts';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const SAMPLE: StatsResponse = {
  total_chunks: 24551,
  by_channel: { memory: 279, observation: 24272 },
  observations: { total: 10593, queue_pending: 0, queue_processing: 3 },
  indexing: {
    status: 'ready', total: 279, done: 279, errors: 0,
    started_at_epoch: 0, finished_at_epoch: 0, last_error: null,
    elapsed_s: 0, percent: 100,
  },
  project_id: 'default',
  version: '0.1.10',
  embedder: { model: 'voyage-4-lite', endpoint: 'https://api.voyageai.com/v1/embeddings' },
  disk: { bytes: 515_000_000, path: '/home/k/.captain-memo' },
  efficiency: {
    corpus: { work_tokens: 9_300_000, stored_tokens: 710_000, ratio: 13.1, saved_pct: 92,
              coverage: { with_data: 10593, total: 10593 } },
    embedder: { calls: 47, avg_latency_ms: 690, tokens_per_s: 4100 },
    dedup: { docs_seen: 10870, skipped_unchanged: 10870, skip_pct: 100 },
  },
};

test('bar — fills proportionally and clamps out-of-range fractions', () => {
  expect(bar(0, 10)).toBe('▕░░░░░░░░░░▏');
  expect(bar(1, 10)).toBe('▕██████████▏');
  expect(bar(0.5, 10)).toBe('▕█████░░░░░▏');
  expect(bar(-1, 4)).toBe('▕░░░░▏');         // clamped low
  expect(bar(2, 4)).toBe('▕████▏');          // clamped high
});

test('renderStats — renders the framed panel with all sections', () => {
  const lines = renderStats(SAMPLE).map(stripAnsi);
  const text = lines.join('\n');
  expect(text).toContain('CAPTAIN MEMO');
  expect(text).toContain('CORPUS');
  expect(text).toContain('EFFICIENCY');
  expect(text).toContain('observation');
  expect(text).toContain('13.1×');
  expect(text).toContain('92%');
  expect(text).toContain('47 calls');
  // header panel: top and bottom borders are equal width
  const top = lines.find(l => l.startsWith('╭'))!;
  const bot = lines.find(l => l.startsWith('╰'))!;
  expect(top.length).toBe(bot.length);
});

test('renderStats — null ratio shows the populating hint, no bar', () => {
  const noRatio: StatsResponse = {
    ...SAMPLE,
    efficiency: {
      ...SAMPLE.efficiency!,
      corpus: { work_tokens: 0, stored_tokens: 0, ratio: null, saved_pct: null,
                coverage: { with_data: 0, total: 40 } },
    },
  };
  const text = renderStats(noRatio).map(stripAnsi).join('\n');
  expect(text).toContain('populating');
  expect(text).not.toContain('×');
});

test('renderStats — tolerates a worker with no efficiency field', () => {
  const noEff: StatsResponse = { ...SAMPLE, efficiency: undefined };
  const text = renderStats(noEff).map(stripAnsi).join('\n');
  expect(text).toContain('CORPUS');
  expect(text).not.toContain('EFFICIENCY');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/cli/stats-render.test.ts`
Expected: FAIL — `Cannot find module '.../stats-render.ts'`.

- [ ] **Step 3: Create `src/cli/stats-render.ts`**

```ts
import { bold, cyanBold, dim, gold, goldBold, green, red, yellow } from '../shared/ansi.ts';
import { fmtBytes, fmtElapsed } from '../shared/format.ts';
import type { EfficiencyReport } from '../worker/efficiency.ts';

export interface StatsResponse {
  total_chunks: number;
  by_channel: Record<string, number>;
  observations: { total: number; queue_pending: number; queue_processing: number };
  indexing: {
    status: 'idle' | 'indexing' | 'ready' | 'error';
    total: number;
    done: number;
    errors: number;
    started_at_epoch: number;
    finished_at_epoch: number;
    last_error: string | null;
    elapsed_s: number;
    percent: number;
  };
  project_id: string;
  version?: string;
  embedder: { model: string; endpoint: string };
  disk?: { bytes: number; path: string };
  efficiency?: EfficiencyReport;
}

const PANEL_WIDTH = 57;
const BAR_WIDTH = 20;

/** A proportional bar: ▕████░░▏. `fraction` is clamped to [0,1]. */
export function bar(fraction: number, width: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return '▕' + '█'.repeat(filled) + '░'.repeat(width - filled) + '▏';
}

/** Thousands grouping with a plain space separator: 24272 → "24 272". */
function fmtCount(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}

/** "  TITLE ──────…" drawn to PANEL_WIDTH. */
function sectionRule(title: string): string {
  const prefix = `  ${title} `;
  const dashes = '─'.repeat(Math.max(0, PANEL_WIDTH - prefix.length));
  return `  ${cyanBold(title)} ${dim(dashes)}`;
}

/** The status dot, coloured by indexing state. */
function statusDot(status: StatsResponse['indexing']['status']): string {
  if (status === 'ready') return green('●');
  if (status === 'indexing') return yellow('●');
  if (status === 'error') return red('●');
  return dim('●');
}

function indexingText(idx: StatsResponse['indexing']): string {
  if (idx.status === 'idle') return 'idle (no watch paths)';
  if (idx.status === 'indexing') {
    return `indexing · ${idx.done}/${idx.total} (${idx.percent}%)`;
  }
  if (idx.status === 'ready') {
    return `ready · ${idx.done}/${idx.total} in ${fmtElapsed(idx.elapsed_s)}`
      + (idx.errors > 0 ? ` · ${idx.errors} errors` : '');
  }
  return `error · ${idx.last_error ?? 'unknown'}`;
}

function headerPanel(version: string): string[] {
  const inner = PANEL_WIDTH - 2;
  const border = '─'.repeat(inner);
  // ⚓ renders 2 columns but is 1 string char — count one extra display column.
  const plain = `  ⚓  CAPTAIN MEMO        corpus statistics   ·   v${version}`;
  const displayWidth = plain.length + 1;
  const pad = ' '.repeat(Math.max(1, inner - displayWidth));
  const content =
    '  ' + goldBold('⚓  CAPTAIN MEMO')
    + dim('        corpus statistics   ·   ')
    + bold(`v${version}`) + pad;
  return [
    cyanBold('╭' + border + '╮'),
    cyanBold('│') + content + cyanBold('│'),
    cyanBold('╰' + border + '╯'),
  ];
}

export function renderStats(stats: StatsResponse): string[] {
  const out: string[] = [];
  out.push(...headerPanel(stats.version ?? 'unknown'));
  out.push('');
  out.push(`  ${dim('Project'.padEnd(10))} ${stats.project_id}`);
  out.push(`  ${dim('Indexing'.padEnd(10))} ${statusDot(stats.indexing.status)} ${indexingText(stats.indexing)}`);
  out.push(`  ${dim('Embedder'.padEnd(10))} ${stats.embedder.model} ${dim('·')} ${stats.embedder.endpoint}`);
  if (stats.disk) {
    out.push(`  ${dim('Disk'.padEnd(10))} ${fmtBytes(stats.disk.bytes)}`);
  }
  out.push('');

  // CORPUS
  out.push(sectionRule('CORPUS'));
  const channels = Object.entries(stats.by_channel);
  const maxCount = Math.max(1, ...channels.map(([, c]) => c));
  for (const [channel, count] of channels) {
    const b = gold(bar(count / maxCount, BAR_WIDTH));
    out.push(`   ${channel.padEnd(14)}${fmtCount(count).padStart(9)}   ${b}`);
  }
  out.push(`   ${dim('─'.repeat(23))}`);
  out.push(`   ${'Total'.padEnd(14)}${fmtCount(stats.total_chunks).padStart(9)}`
    + `     ${dim(`${fmtCount(stats.observations.total)} observations`)}`);
  out.push('');

  // EFFICIENCY
  if (stats.efficiency) {
    const { corpus, embedder, dedup } = stats.efficiency;
    out.push(sectionRule('EFFICIENCY'));
    if (corpus.ratio === null || corpus.saved_pct === null) {
      out.push(`   ${'Compression'.padEnd(14)}${dim('— populating… (restart worker)')}`);
    } else {
      const b = green(bar(corpus.saved_pct / 100, BAR_WIDTH));
      out.push(`   ${'Compression'.padEnd(14)}${goldBold(`${corpus.ratio}×`).padEnd(8)}  ${b}  ${corpus.saved_pct}%`);
      out.push(`   ${' '.repeat(14)}${dim(`distilled ${fmtCount(corpus.work_tokens)} → ${fmtCount(corpus.stored_tokens)} tokens`
        + ` · ${corpus.coverage.with_data}/${corpus.coverage.total} obs`)}`);
    }
    out.push(`   ${'Embedder'.padEnd(14)}` + (embedder.calls > 0
      ? `${embedder.calls} calls ${dim('·')} ~${embedder.avg_latency_ms} ms ${dim('·')} ${fmtCount(embedder.tokens_per_s)} tok/s`
      : dim('— no embeds since worker start')));
    out.push(`   ${'Dedup'.padEnd(14)}` + (dedup.docs_seen > 0
      ? `${dedup.skip_pct}%   ${dim(`${fmtCount(dedup.skipped_unchanged)} / ${fmtCount(dedup.docs_seen)} unchanged`)}`
      : dim('— no documents indexed since worker start')));
    out.push('');
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/cli/stats-render.test.ts`
Expected: PASS — all 4 tests green.
Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli/stats-render.ts tests/unit/cli/stats-render.test.ts
git commit -m "feat(stats): framed Captain's Log renderer (stats-render.ts)"
```

---

## Task 5: Slim `stats.ts` to use `renderStats`

**Files:**
- Modify: `src/cli/commands/stats.ts`
- Delete: `tests/unit/cli/stats-efficiency.test.ts`

- [ ] **Step 1: Replace the body of `stats.ts`**

REPLACE THE ENTIRE FILE `src/cli/commands/stats.ts` with:

```ts
import { workerGet } from '../client.ts';
import { renderStats, type StatsResponse } from '../stats-render.ts';

export async function statsCommand(args: string[] = []): Promise<number> {
  const stats = await workerGet('/stats') as StatsResponse;
  if (args.includes('--json')) {
    console.log(JSON.stringify(stats));
    return 0;
  }
  for (const line of renderStats(stats)) console.log(line);
  return 0;
}
```

This removes the old `StatsResponse` (now imported from `stats-render.ts`), `indexingLine`, and `formatEfficiencyLines` — all superseded by `stats-render.ts`.

- [ ] **Step 2: Delete the obsolete test**

The old `tests/unit/cli/stats-efficiency.test.ts` imported `formatEfficiencyLines` from `stats.ts`, which no longer exists. Its coverage is replaced by `tests/unit/cli/stats-render.test.ts`.

```bash
git rm tests/unit/cli/stats-efficiency.test.ts
```

- [ ] **Step 3: Check nothing else imports the removed exports**

Run: `grep -rn "formatEfficiencyLines\|from '.*commands/stats" src tests --include='*.ts'`
Expected: no matches except `src/cli/index.ts` (or wherever commands are wired) importing `statsCommand` — that import is unaffected. If any other file imports `formatEfficiencyLines` or `StatsResponse` from `commands/stats.ts`, update it to import from `../stats-render.ts` instead.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test tests/unit/ tests/integration/worker-efficiency.test.ts`
Expected: PASS.
Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/stats.ts tests/unit/cli/stats-efficiency.test.ts
git commit -m "refactor(stats): route stats command through renderStats"
```

---

## Task 6: Release v0.1.10

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: ALL tests pass. If anything fails, STOP and report BLOCKED with the output.

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: no errors. If errors, STOP and report BLOCKED.

- [ ] **Step 3: Smoke-test the rendered output**

Run: `bun bin/captain-memo stats`
Expected: the framed Captain's Log panel renders. Then run it piped: `bun bin/captain-memo stats | cat` and confirm NO escape codes appear (TTY-aware — the worker must be running for this; if it is not, the smoke test can be skipped and noted).

- [ ] **Step 4: Bump the version**

In `package.json`, change `"version": "0.1.9"` to `"version": "0.1.10"`. Do NOT touch `plugin/.claude-plugin/plugin.json`.

- [ ] **Step 5: Commit the release**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
chore: release v0.1.10

Fix the compression ratio (sum work/stored over the same paired rows
only — independent sums divided mismatched populations). Backfill
stored_tokens for pre-v0.1.9 observations via a no-embed background
pass on worker startup. Revamp captain-memo stats into a framed,
TTY-aware (NO_COLOR-aware) nautical panel.
EOF
)"
```

- [ ] **Step 6: Report**

Report the test suite totals, typecheck result, the smoke-test outcome, and `git log --oneline -1`.

---

## Self-Review Notes

- **Spec coverage:** Component 1 ratio fix → Task 1 ✓; Component 2 backfill → Task 2 (query methods + startup pass) ✓; Component 3 — `NO_COLOR` → Task 3 ✓, `stats-render.ts`/`bar`/`renderStats` → Task 4 ✓, slimmed `stats.ts` → Task 5 ✓; release → Task 6 ✓. Every spec "Testing" bullet maps to a test step.
- **Green commits:** Task 1 changes `observations-store` + `efficiency` + the `/stats` caller in one commit, so `index.ts` never references a deleted method. Task 4 adds `stats-render.ts` (with its own `StatsResponse`) while `stats.ts` keeps its copy — both compile — and Task 5 switches `stats.ts` over and deletes the obsolete test in the same commit.
- **Type consistency:** `sumPairedTokens()` returns `{work,stored,paired}` (Task 1) and is consumed with those exact keys in the `/stats` handler (Task 1) and the backfill never touches it. `EfficiencyInput` (`workSum,storedSum,pairedCount,totalObservations,metrics`) is defined in Task 1 and used unchanged by the `/stats` handler. `StatsResponse` is defined+exported in `stats-render.ts` (Task 4) and imported by `stats.ts` (Task 5). `bar(fraction,width)` signature is consistent between definition and tests.
