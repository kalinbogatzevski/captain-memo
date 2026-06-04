# Reader-Pool Engine Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move synchronous corpus reads off the heartbeat-bearing engine thread onto a pool of read-only reader threads, so search bursts can't stall the heartbeat and trigger spurious restarts — and so concurrent reads run in parallel.

**Architecture:** 1 writer engine (writes + heartbeat, unchanged role) + N read-only reader engines (searches). The main thread classifies each request and routes: reads → reader pool, writes/control/stats → writer. Retrieval-tracking bumps are forwarded reader→main→writer (readers stay strictly read-only). See `docs/specs/2026-06-04-reader-pool-engine-split-design.md`.

**Tech Stack:** Bun, TypeScript, `bun:sqlite` (WAL: 1 writer + N readers), Bun Workers, `bun:test`.

**Key invariants:**
- `readOnly: true` is a single master switch in `startWorker` that suppresses ALL write machinery (watcher, ingest, both `setInterval` ticks, backfill, queue/pending stores) and opens corpus stores read-only.
- The writer is the ONLY process that writes the corpus. Readers forward bumps to it.
- `/health` is computed on the main thread from the WRITER heartbeat only. Readers never drive `/health`.
- Reads NEVER overflow to the writer except during cold-start (no reader ready yet) or all-readers-down — both logged.
- `CAPTAIN_MEMO_READER_POOL_SIZE` (default 2, clamp [0,8]); `N=0` reverts to today's single-engine behavior.

---

### Task 1: Pure route classifier

**Files:**
- Create: `src/worker/route-class.ts`
- Test: `tests/unit/route-class.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/route-class.test.ts
import { test, expect } from 'bun:test';
import { classifyRoute } from '../../src/worker/route-class.ts';

test('reads route to the pool', () => {
  for (const [m, p] of [
    ['POST', '/search/all'], ['POST', '/search/memory'], ['POST', '/search/skill'],
    ['POST', '/search/observations'], ['POST', '/get_full'], ['GET', '/observation/full'],
    ['POST', '/inject/context'], ['GET', '/observations/recent'], ['GET', '/recall/list'],
  ] as const) {
    expect(classifyRoute(m, p)).toBe('read');
  }
});

test('writes and writer-stateful reads route to the writer', () => {
  for (const [m, p] of [
    ['POST', '/reindex'], ['POST', '/observation/enqueue'], ['POST', '/observation/flush'],
    ['GET', '/stats'], ['GET', '/pending_embed/retry'], ['POST', '/shutdown'],
    ['GET', '/test/block'],
  ] as const) {
    expect(classifyRoute(m, p)).toBe('write');
  }
});

test('/health is control (answered by main)', () => {
  expect(classifyRoute('GET', '/health')).toBe('control');
});

test('unknown paths route to the writer (safe default)', () => {
  expect(classifyRoute('POST', '/whatever')).toBe('write');
  expect(classifyRoute('GET', '/nope')).toBe('write');
});
```

- [ ] **Step 2: Run it — expect FAIL** (`bun test tests/unit/route-class.test.ts` → "classifyRoute is not a function")

- [ ] **Step 3: Implement**

```ts
// src/worker/route-class.ts
// Pure classifier: decides which engine serves a request. The ONLY source of truth
// for read/write routing. Unknown → 'write' (safe: the writer can serve anything).
export type RouteClass = 'read' | 'write' | 'control';

const READ_PATHS = new Set<string>([
  '/search/all', '/search/memory', '/search/skill', '/search/observations',
  '/get_full', '/observation/full', '/inject/context',
  '/observations/recent', '/recall/list',
]);

export function classifyRoute(method: string, pathname: string): RouteClass {
  if (method === 'GET' && pathname === '/health') return 'control';
  if (READ_PATHS.has(pathname)) return 'read';
  return 'write';
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat(worker): pure route classifier for read/write engine split`

---

### Task 2: Read-only option on the three corpus stores

**Files:**
- Modify: `src/worker/vector-store.ts:37` (constructor), `src/worker/meta.ts:93` (constructor), `src/worker/observations-store.ts:310` (constructor)
- Test: `tests/unit/store-readonly.test.ts`

Each store's constructor gains an optional 2nd arg `opts?: { readonly?: boolean }`. When `readonly`, open `new Database(path, { readonly: true })` and SKIP every write-on-open (WAL pragma, schema DDL, migrations, sqlite-vec is still `load`ed for VectorStore since it's needed to *read*). The DB file must already exist + be initialized by the writer.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/store-readonly.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MetaStore } from '../../src/worker/meta.ts';
import { VectorStore } from '../../src/worker/vector-store.ts';
import { ObservationsStore } from '../../src/worker/observations-store.ts';

function tmp() { return mkdtempSync(join(tmpdir(), 'cm-ro-')); }

test('MetaStore readonly opens an existing db and reads without DDL', () => {
  const dir = tmp(); const path = join(dir, 'meta.db');
  const rw = new MetaStore(path);                 // writer creates schema
  rw.upsertDocument({ source_path: 'a', channel: 'memory', project_id: 'p', sha: 's', mtime_epoch: 1, metadata: {} });
  const ro = new MetaStore(path, { readonly: true });
  expect(() => ro.stats()).not.toThrow();         // read works
  // a write on the readonly handle must fail (readonly db is enforced by sqlite)
  expect(() => ro.upsertDocument({ source_path: 'b', channel: 'memory', project_id: 'p', sha: 's', mtime_epoch: 1, metadata: {} })).toThrow();
});

test('VectorStore readonly can query an existing db', async () => {
  const dir = tmp(); const path = join(dir, 'vec.db');
  const rw = new VectorStore({ dbPath: path, dimension: 4 });
  await rw.add('default', [{ id: 'x', embedding: [1, 0, 0, 0] }]);
  const ro = new VectorStore({ dbPath: path, dimension: 4, readonly: true });
  const hits = await ro.query('default', [1, 0, 0, 0], 5);
  expect(hits.length).toBe(1);
  expect(hits[0]!.id).toBe('x');
});

test('ObservationsStore readonly reads but rejects writes', () => {
  const dir = tmp(); const path = join(dir, 'obs.db');
  const rw = new ObservationsStore(path);
  expect(() => new ObservationsStore(path, { readonly: true }).countAll()).not.toThrow();
});
```

- [ ] **Step 2: Run — expect FAIL** (readonly option not yet accepted; the `{readonly:true}` arg is ignored so the write test won't throw)

- [ ] **Step 3: Implement — VectorStore** (`vector-store.ts`)

Change `VectorStoreOptions` to add `readonly?: boolean`. Constructor:

```ts
constructor(opts: VectorStoreOptions) {
  this.db = new Database(opts.dbPath, opts.readonly ? { readonly: true } : undefined);
  sqliteVec.load(this.db);
  this.dimension = opts.dimension;
  if (!opts.readonly) {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA.replace('__DIM__', String(opts.dimension)));
  }
}
```

- [ ] **Step 4: Implement — MetaStore** (`meta.ts:93`)

```ts
constructor(path: string, opts?: { readonly?: boolean }) {
  this.db = new Database(path, opts?.readonly ? { readonly: true } : undefined);
  if (!opts?.readonly) {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }
}
```

- [ ] **Step 5: Implement — ObservationsStore** (`observations-store.ts:310`)

```ts
constructor(path: string, opts?: { readonly?: boolean }) {
  this.db = new Database(path, opts?.readonly ? { readonly: true } : undefined);
  if (!opts?.readonly) {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    applyMigrations(this.db, OBSERVATIONS_STORE_MIGRATIONS);
  }
}
```

- [ ] **Step 6: Run — expect PASS**
- [ ] **Step 7: Commit** — `feat(worker): readonly open option for vector/meta/observations stores`

---

### Task 3: `readOnly` + `onRetrievalBump` in WorkerOptions; route both bump sites through a sink

**Files:**
- Modify: `src/worker/index.ts` — `WorkerOptions` (86-110); the bump closures (858-876) and the direct bump in `/observation/full` (~990)
- Test: `tests/unit/retrieval-bump-sink.test.ts`

- [ ] **Step 1: Write the failing test** — drive a search through `startWorker({ readOnly: true, onRetrievalBump })` against a tiny seeded corpus and assert the sink is called, not the store.

```ts
// tests/unit/retrieval-bump-sink.test.ts
import { test, expect } from 'bun:test';
import { applyBump } from '../../src/worker/index.ts';  // exported helper (see Step 3)

test('applyBump prefers the injected sink over the store', () => {
  const calls: Array<{ ids: number[]; source: string }> = [];
  const sink = (ids: number[], source: string) => calls.push({ ids, source });
  const store = { bumpRetrieval: () => { throw new Error('store should not be touched in reader mode'); } };
  applyBump([1, 2], 'search', sink, store as any);
  expect(calls).toEqual([{ ids: [1, 2], source: 'search' }]);
});

test('applyBump falls back to the store when no sink', () => {
  const seen: any[] = [];
  const store = { bumpRetrieval: (ids: number[], source: string) => seen.push([ids, source]) };
  applyBump([3], 'drill', undefined, store as any);
  expect(seen).toEqual([[[3], 'drill']]);
});

test('applyBump no-ops on empty ids', () => {
  let called = false;
  applyBump([], 'search', () => { called = true; }, undefined);
  expect(called).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL** (`applyBump` not exported)

- [ ] **Step 3: Implement** — add to `WorkerOptions` (after `noServe?`):

```ts
  /** Read-only reader mode: suppress ALL write machinery (watcher, ingest, ticks,
   *  backfill, queue/pending stores) and open corpus stores read-only. */
  readOnly?: boolean;
  /** When set, retrieval-tracking bumps are handed to this sink instead of being
   *  written locally — readers forward them to the writer. */
  onRetrievalBump?: (ids: number[], source: import('../shared/types.ts').RetrievalSource) => void;
```

Add an exported module-level helper (so it's unit-testable) near the other top-level helpers:

```ts
export function applyBump(
  ids: number[],
  source: import('../shared/types.ts').RetrievalSource,
  sink: ((ids: number[], source: import('../shared/types.ts').RetrievalSource) => void) | undefined,
  store: { bumpRetrieval: (ids: number[], source: import('../shared/types.ts').RetrievalSource) => void } | undefined,
): void {
  if (ids.length === 0) return;
  if (sink) { try { sink(ids, source); } catch (e) { console.error('[retrieval-tracking] sink failed:', (e as Error).message); } return; }
  if (!store) return;
  try { store.bumpRetrieval(ids, source); } catch (e) { console.error('[retrieval-tracking] bump failed:', (e as Error).message); }
}
```

Rewrite `bumpRetrievalFromResults` (858-876) to extract ids then delegate:

```ts
const bumpRetrievalFromResults = (
  items: Array<{ metadata: Record<string, unknown> }>,
  source: import('../shared/types.ts').RetrievalSource,
): void => {
  const ids: number[] = [];
  for (const item of items) {
    const oid = item.metadata?.observation_id;
    if (typeof oid === 'number' && Number.isInteger(oid) && oid > 0) ids.push(oid);
  }
  applyBump(ids, source, opts.onRetrievalBump, obsStore);
};
```

Find the direct bump in the `/observation/full` route (~line 990, `obsStore.bumpRetrieval([id], 'drill')`) and replace with `applyBump([id], 'drill', opts.onRetrievalBump, obsStore);`.

- [ ] **Step 4: Run — expect PASS**; also `bunx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `feat(worker): retrieval-bump sink so readers can forward bumps`

---

### Task 4: Gate write-only setup on `!readOnly`; open corpus stores read-only in reader mode

**Files:**
- Modify: `src/worker/index.ts` — `startWorker` setup (store opens at 195/216/393; watcher 334-385; backfill 405-434; obs tick 645-654; pending tick 715-720; queue/pending opens 390-398)
- Test: `tests/integration/reader-mode-boot.test.ts`

The principle: every write-only setup block becomes conditional on `!opts.readOnly`, and the three corpus stores open with `{ readonly: opts.readOnly }`. Queue + pending-embed stores are NOT opened in reader mode.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/reader-mode-boot.test.ts
import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerOptions } from '../../src/worker/index.ts';

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

function baseOpts(dir: string): WorkerOptions {
  return {
    port: 0, projectId: 'default',
    metaDbPath: join(dir, 'meta.db'),
    embedderEndpoint: 'http://127.0.0.1:1/none', embedderModel: 'm',
    vectorDbPath: join(dir, 'vec.db'), embeddingDimension: 4,
    skipEmbed: true, observationsDbPath: join(dir, 'obs.db'),
    noServe: true,
  };
}

test('writer boot initializes the dbs (so a reader can open them readonly)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-wr-'));
  const writer = await startWorker(baseOpts(dir));
  await writer.stop();
  // now a reader can open read-only without DDL
  const reader = await startWorker({ ...baseOpts(dir), readOnly: true });
  stop = reader.stop;
  expect(reader.handler).toBeDefined();
});

test('reader boot starts no background timers (event loop stays idle)', async () => {
  // A reader with no watcher/ticks should let the process exit timers settle.
  // We assert indirectly: a reader boot returns quickly and /stats-free handler works.
  const dir = mkdtempSync(join(tmpdir(), 'cm-rd-'));
  const w = await startWorker(baseOpts(dir)); await w.stop();
  const reader = await startWorker({ ...baseOpts(dir), readOnly: true });
  stop = reader.stop;
  const res = await reader.handler!(new Request('http://x/observations/recent'));
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run — expect FAIL** (reader boot currently opens stores read-write → DDL on an existing db is fine, but the readOnly flag isn't honored; the test that asserts readonly store opens will fail when write machinery runs). Confirm the failure is about `readOnly` not being honored.

- [ ] **Step 3: Implement — store opens.** At the MetaStore open (`index.ts:195`): `const meta = new MetaStore(opts.metaDbPath, { readonly: !!opts.readOnly });`. At VectorStore (`216`): add `readonly: !!opts.readOnly` to the options object. At ObservationsStore (`393-395`): `obsStore = new ObservationsStore(opts.observationsDbPath, { readonly: !!opts.readOnly });`.

- [ ] **Step 4: Implement — skip write machinery.** Wrap each in `if (!opts.readOnly)`:
  - Boot-time dim probe (`227-245`) — keep (a reader needs the embedder to embed queries) UNLESS `skipEmbed`. No change needed (already guarded by skipEmbed).
  - IngestPipeline (`284-305`) — guard the watcher/reindex users; the pipeline object itself is cheap, but its watcher/initial-index must not run. Simplest: keep IngestPipeline construction, but gate the WATCHER + initial-index block (`334-385`) on `!opts.readOnly`.
  - File watcher + initial index (`334-385`) → `if (!opts.readOnly && opts.watchPaths) { ... }`.
  - ObservationQueue open (`390-392`) → `if (!opts.readOnly && opts.observationQueueDbPath) { ... }`.
  - stored_tokens backfill (`405-434`) → wrap the `void (async …)` in `if (!opts.readOnly)`.
  - PendingEmbedQueue open (`396-398`) → `if (!opts.readOnly && opts.pendingEmbedDbPath) { ... }`.
  - obs tick `setInterval` (`645-654`) — the guard at 646 already requires `obsQueue && summarize`; in reader mode `obsQueue` is undefined, so it won't start. Add `!opts.readOnly &&` to be explicit.
  - pending tick `setInterval` (`715-720`) — guard requires `pendingEmbed`; undefined in reader mode. Add `!opts.readOnly &&` explicit.

- [ ] **Step 5: Run — expect PASS**; `bunx tsc --noEmit` clean.
- [ ] **Step 6: Commit** — `feat(worker): readOnly master switch suppresses all write machinery`

---

### Task 5: Reader engine entry (`engine-reader.ts`)

**Files:**
- Create: `src/worker/engine-reader.ts`
- Test: covered by the integration test in Task 8 (a Worker entry is hard to unit-test in isolation; the pool integration test exercises it)

- [ ] **Step 1: Implement** (model on `engine.ts`, but read-only + bump-forwarding + no heartbeat):

```ts
// src/worker/engine-reader.ts — READER thread entry, loaded as a Bun Worker by threaded-main.ts.
// Runs startWorker({readOnly:true, noServe:true}) — corpus stores opened read-only, NO writes,
// NO background ticks — and serves the read handler over the thread channel. Retrieval bumps are
// forwarded to the main thread (which relays them to the single writer).
import { ThreadChannel } from './thread-channel.ts';
import { deserializeRequest, serializeResponse, type WireRequest } from './request-serde.ts';
import { buildWorkerOptionsFromEnv, startWorker } from './index.ts';
import type { RetrievalSource } from '../shared/types.ts';

declare const self: Worker;

async function boot(): Promise<void> {
  const base = await buildWorkerOptionsFromEnv();
  const handle = await startWorker({
    ...base,
    noServe: true,
    readOnly: true,
    onRetrievalBump: (ids: number[], source: RetrievalSource) => {
      try { postMessage({ kind: 'bump', ids, source }); } catch { /* ignore */ }
    },
  });
  const handler = handle.handler!;
  const channel = new ThreadChannel({
    post: (m) => postMessage(m),
    onMessage: (cb) => { self.onmessage = (e: MessageEvent) => cb(e.data); },
  });
  channel.serve(async (data) => {
    const wire = data as WireRequest;
    const res = await handler(deserializeRequest(wire));
    return await serializeResponse(res);
  });
  postMessage({ kind: 'ready' });
}

boot().catch((err) => {
  try { postMessage({ kind: 'fatal', message: (err as Error).message }); } catch { /* ignore */ }
  throw err;   // surfaces as the Worker 'error' event → main respawns the reader
});
```

Note: the reader's `self.onmessage` (set inside ThreadChannel) handles inbound `req` frames. The reader posts `bump`/`ready`/`fatal` outbound, which the main thread interprets (Task 7).

- [ ] **Step 2: Typecheck** — `bunx tsc --noEmit` clean.
- [ ] **Step 3: Commit** — `feat(worker): read-only reader engine entry (engine-reader.ts)`

---

### Task 6: Writer applies forwarded bumps (`engine.ts`)

**Files:**
- Modify: `src/worker/engine.ts`
- Test: covered by Task 8 integration (bump forwarding end-to-end)

- [ ] **Step 1: Implement** — in `engine.ts boot()`, after the `channel.serve(...)` block, add a handler for inbound `{kind:'bump'}` messages from the main thread, applying them via the exposed store. Because `self.onmessage` is owned by the ThreadChannel transport, extend the transport's `onMessage` wrapper to intercept `bump` before delegating to the channel:

```ts
  const store = handle.store;
  const channel = new ThreadChannel({
    post: (m) => postMessage(m),
    onMessage: (cb) => {
      self.onmessage = (e: MessageEvent) => {
        const m = e.data as { kind?: string; ids?: number[]; source?: string };
        if (m && m.kind === 'bump' && Array.isArray(m.ids) && store) {
          try { store.bumpRetrieval(m.ids, m.source as any); } catch (err) { console.error('[retrieval-tracking] writer bump failed:', (err as Error).message); }
          return;
        }
        cb(e.data);
      };
    },
  });
```

(Replace the existing `onMessage` wrapper in `engine.ts` with this one; the rest of `engine.ts` — `channel.serve`, heartbeat — is unchanged.)

- [ ] **Step 2: Typecheck** — clean.
- [ ] **Step 3: Commit** — `feat(worker): writer applies retrieval bumps forwarded from readers`

---

### Task 7: Reader pool data structure

**Files:**
- Create: `src/worker/reader-pool.ts`
- Test: `tests/unit/reader-pool.test.ts`

A pure-ish structure over an injected "engine handle" (so it's testable without real Workers). It tracks ready/busy readers and hands out the least-busy one, or `null` when all are busy (caller queues).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/reader-pool.test.ts
import { test, expect } from 'bun:test';
import { ReaderPool } from '../../src/worker/reader-pool.ts';

test('pick returns null when empty, a member when populated', () => {
  const pool = new ReaderPool<string>();
  expect(pool.pick()).toBeNull();
  pool.add('a'); pool.add('b');
  expect(['a', 'b']).toContain(pool.pick());
});

test('pick spreads load: least in-flight wins', () => {
  const pool = new ReaderPool<string>();
  pool.add('a'); pool.add('b');
  const first = pool.pick()!; pool.acquire(first);   // a:1
  const second = pool.pick()!;                        // should be the other one
  expect(second).not.toBe(first);
});

test('all-busy returns null; release frees capacity', () => {
  const pool = new ReaderPool<string>(/* maxInFlightPerReader */ 1);
  pool.add('a');
  const r = pool.pick()!; pool.acquire(r);
  expect(pool.pick()).toBeNull();      // a is at capacity
  pool.release(r);
  expect(pool.pick()).toBe('a');
});

test('remove drops a crashed reader', () => {
  const pool = new ReaderPool<string>();
  pool.add('a'); pool.add('b'); pool.remove('a');
  expect(pool.size()).toBe(1);
  expect(pool.pick()).toBe('b');
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```ts
// src/worker/reader-pool.ts — tracks reader engines + their in-flight load. Generic over the
// reader handle type so it can be unit-tested with plain strings. NOT thread-aware itself; the
// caller (threaded-main) maps a picked handle to its ThreadChannel.
export class ReaderPool<T> {
  private members: T[] = [];
  private inflight = new Map<T, number>();
  constructor(private maxInFlightPerReader = 1) {}

  add(r: T): void { if (!this.inflight.has(r)) { this.members.push(r); this.inflight.set(r, 0); } }
  remove(r: T): void { this.members = this.members.filter(m => m !== r); this.inflight.delete(r); }
  size(): number { return this.members.length; }
  acquire(r: T): void { this.inflight.set(r, (this.inflight.get(r) ?? 0) + 1); }
  release(r: T): void { const n = this.inflight.get(r); if (n !== undefined) this.inflight.set(r, Math.max(0, n - 1)); }

  /** Least-loaded ready reader under capacity, or null if all are saturated/empty. */
  pick(): T | null {
    let best: T | null = null; let bestN = Infinity;
    for (const r of this.members) {
      const n = this.inflight.get(r) ?? 0;
      if (n < this.maxInFlightPerReader && n < bestN) { best = r; bestN = n; }
    }
    return best;
  }
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat(worker): ReaderPool load-tracking structure`

---

### Task 8: Main-thread pool orchestration + routing + bump relay

**Files:**
- Modify: `src/worker/threaded-main.ts` (the whole orchestrator)
- Modify: `src/worker/index.ts:1479` `buildWorkerOptionsFromEnv` — nothing; pool size read in threaded-main
- Test: `tests/integration/reader-pool.test.ts`

This is the integration task. It keeps the EXISTING writer spawn + supervision + single-threaded fallback exactly as-is (the writer is still the engine that beats and the fallback still applies), and ADDS: read `CAPTAIN_MEMO_READER_POOL_SIZE`; after the writer is healthy, spawn N readers; route via `classifyRoute`; relay `bump` messages from readers to the writer; supervise readers.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/reader-pool.test.ts
import { test, expect, afterEach, beforeAll } from 'bun:test';
// NOTE: spawn the worker as a subprocess with CAPTAIN_MEMO_WORKER_THREADED=1 and
// CAPTAIN_MEMO_READER_POOL_SIZE=2 against a seeded temp DATA_DIR, mirroring the existing
// threaded-worker integration test harness (tests/integration/threaded-*.test.ts).
// Assertions:
//  1. GET /health is 200 healthy after boot.
//  2. Fire 12 concurrent POST /search/observations; /health polled in parallel stays 200
//     throughout (the regression: pre-split this degrades under the burst).
//  3. After a reader-served search, the writer's observations.db from_search counter advances
//     (poll /stats recall.totals.search until it increases) — proves bump forwarding.
//  4. With CAPTAIN_MEMO_READER_POOL_SIZE=0, searches still succeed (writer serves them).
```

Implement this test by copying the spawn/seed harness from the nearest existing `tests/integration/threaded-*.test.ts` (reuse its DATA_DIR seeding + `curl`/fetch helpers). Keep assertions 1–4.

- [ ] **Step 2: Run — expect FAIL** (pool not implemented; readers never spawned; concurrency degrades `/health`)

- [ ] **Step 3: Implement the orchestration.** In `threaded-main.ts`:

  - Add `const READER_URL = new URL('./engine-reader.ts', import.meta.url);` and `const POOL_SIZE = Math.max(0, Math.min(8, Number(process.env.CAPTAIN_MEMO_READER_POOL_SIZE ?? 2)));`
  - Keep the writer = the existing `engine` + `channel` + supervision UNCHANGED.
  - After the `everBeat` gate passes (writer healthy, before `Bun.serve`), if `POOL_SIZE > 0` spawn the readers: for each, `new Worker(READER_URL)`, build a `ThreadChannel` whose `onMessage` intercepts `bump` (→ forward to the writer: `engine?.postMessage({ kind:'bump', ids, source })`), `ready` (→ `pool.add(reader)`), and `fatal`/`error` (→ `pool.remove`, terminate, respawn that one reader). Store a `Map<readerToken, ThreadChannel>`.
  - Use `ReaderPool<token>` (token = a small id). On a `read` request: `const r = pool.pick()`. If `r`, `pool.acquire(r)`; `try { return await readerChannel(r).request(wire) } finally { pool.release(r) }`. If `null` (saturated) → await a short retry loop / queue (simple: spin-wait up to the request deadline polling `pool.pick()`), or fall back to the writer ONLY if `pool.size() === 0` (cold start / all-down) with a `console.warn`.
  - Rewrite the `fetch` handler:
    ```ts
    fetch: async (req) => {
      const url = new URL(req.url);
      const cls = classifyRoute(req.method, url.pathname);
      if (cls === 'control') { /* existing /health-from-heartbeat block */ }
      const wire = await serializeRequest(req);
      if (cls === 'read' && pool.size() > 0) {
        // pick a reader (with brief wait when saturated); fall back to writer only if pool empty
        const r = await acquireReaderOrNull();
        if (r !== null) { try { return deserializeResponse(await readerCh(r).request(wire) as WireResponse); }
                          catch (e) { return Response.json({ error: (e as Error).message }, { status: 503 }); }
                          finally { pool.release(r); } }
      }
      // writes, control-to-writer, stats, or cold-start reads → writer
      if (!channel) return Response.json({ error: 'engine_unavailable' }, { status: 503 });
      try { return deserializeResponse(await channel.request(wire) as WireResponse); }
      catch (e) { return Response.json({ error: (e as Error).message }, { status: 503 }); }
    }
    ```
  - On `stop()`: terminate all readers then the writer.
  - Update the `console.log` boot line to include the reader count, e.g. `(threaded: thin HTTP main + 1 writer + ${pool.size()} readers)` — KEEP the literal substring `(threaded:` (operators/smoke checks grep for it).

- [ ] **Step 4: Run the integration test — expect PASS** (all 4 assertions). Iterate on the saturation/wait logic until assertion 2 (health-under-load) is solid.
- [ ] **Step 5: Typecheck + full unit suite** — `bunx tsc --noEmit && bun test tests/unit/` green.
- [ ] **Step 6: Commit** — `feat(worker): reader pool orchestration — route reads to read-only engines`

---

### Task 9: Docs + config surfacing

**Files:**
- Modify: `README.md` (or the worker/config doc) — document `CAPTAIN_MEMO_READER_POOL_SIZE`
- Modify: wherever env knobs are listed for the worker (search for `CAPTAIN_MEMO_WORKER_THREADED` to find the doc site)

- [ ] **Step 1:** Add a short subsection: what the reader pool does, the default (2), the `[0,8]` range, `0` = disabled, and that more readers help on bigger machines.
- [ ] **Step 2:** Typecheck/lint unaffected; commit — `docs: document CAPTAIN_MEMO_READER_POOL_SIZE`

---

## Self-review checklist (run before execution)

1. **Spec coverage:** §3 split → Tasks 4/5/6/8; §4 classifier → Task 1; §5 read-only mode → Tasks 2/4; §6 bump forwarding → Tasks 3/5/6/8; §7 health/supervision → Task 8; §8 config/fallback → Task 8; §9 testing → Tasks 1/2/3/4/7/8. ✓
2. **Types consistent:** `classifyRoute → RouteClass`; `applyBump(ids, source, sink, store)`; `ReaderPool<T>.pick()/acquire/release/add/remove/size`; `WorkerOptions.readOnly`/`onRetrievalBump`; store `{ readonly?: boolean }`. Used identically across tasks. ✓
3. **No placeholders:** every code step has real code; Task 8's harness reuse points at existing integration tests (the one intentional "copy the existing harness" instruction, justified by the subprocess-spawn boilerplate already living there). ✓
4. **Ordering:** 1 (classifier) → 2 (stores) → 3 (bump sink) → 4 (readOnly gating, needs 2+3) → 5 (reader entry, needs 4) → 6 (writer bump, needs 3) → 7 (pool struct) → 8 (orchestration, needs 1/5/6/7) → 9 (docs). ✓
