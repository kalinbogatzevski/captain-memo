# Reader-Pool Engine Split — Design Spec

**Date:** 2026-06-04
**Status:** Approved for implementation
**Scope:** `core` worker threading model.

## 1. Problem & root cause (measured)

The threaded worker runs all corpus state on a **single ENGINE thread** (`src/worker/engine.ts` → `startWorker({ noServe: true })`). Search executes a **synchronous** `bun:sqlite` sqlite-vec KNN scan (`VectorStore.query`, `vector-store.ts:102`) plus a synchronous FTS keyword scan. `bun:sqlite` has no async query API — `.all()` blocks the JS event loop for the query's entire duration.

Measured on the live corpus (2026-06-04):

| Metric | Value |
|---|---|
| vec_chunks (embeddings.db) | **93,734** (408 MB) |
| Isolated sqlite-vec KNN scan | **~290 ms, synchronous** |
| Query embed (Voyage hosted) | ~286 ms, **async** (yields) |
| End-to-end `/search/*` | 0.59–0.97 s |
| Worker restarts in the prior hour | **4** (hook-triggered) |

The engine posts a 1 s heartbeat; the main thread's `/health` flips to `degraded` when the beat is stale > `freshMs = 5000` (`health-heartbeat.ts:7`). A single ~290 ms scan is survivable, but **recall fires on every prompt across multiple sessions**, so bursts pile up > 5 s of synchronous blocking → stale beat → `/health` degraded → `user-prompt-submit`/`session-start` hooks restart the worker. The cost is **O(N) in corpus size** (brute-force KNN), so it worsens as the captain grows.

**The embed is not the blocker** (async network I/O). The blocker is synchronous sqlite work on the heartbeat-bearing thread.

## 2. Approaches considered

- **(A) Read/write engine split with a reader pool — CHOSEN.** One writer engine (writes + heartbeat) + N read-only reader engines (searches). Main thread routes by request class. Stops restarts (heavy reads leave the heartbeat thread) **and** adds throughput (concurrent reads on separate event loops/cores). WAL already permits one writer + many readers.
- **(B) Offload only the KNN call to query workers.** Narrower, but the engine still serves FTS, `getChunk` boosts, `/stats`, `get_full` synchronously — those still block the heartbeat. Converges toward (A) once you offload all reads. Rejected as incomplete.
- **(C) Make sqlite calls async in-thread.** Not possible — `bun:sqlite` is synchronous; the only way to yield is to move the work to another thread (that *is* (A)/(B)).
- **(D) ANN index to shrink the scan.** sqlite-vec is brute-force only; ANN means a different vector backend — a much larger, separate project. Complementary future work; does not fix "concurrent reads block each other." Noted in §10.

## 3. Architecture

```
                  ┌────────────────────────────────────────────┐
   HTTP :39888 →  │  MAIN THREAD (threaded-main.ts)             │
                  │  • Bun.serve (loopback only)                │
                  │  • /health answered locally from WRITER beat│
                  │  • classify(method,path) → route:           │
                  │      write/control/stats → WRITER           │
                  │      corpus reads          → READER POOL     │
                  │  • relay reader bump notifications → WRITER  │
                  │  • supervise: respawn a reader/writer on err │
                  └───────────┬───────────────┬────────────────┘
                              │               │ (N reader channels)
                  ┌───────────▼──────┐  ┌──────▼───────────────────────┐
                  │ WRITER ENGINE    │  │ READER ENGINE  × N            │
                  │ engine.ts        │  │ engine-reader path            │
                  │ startWorker()    │  │ startWorker({readOnly:true})  │
                  │ • all writes     │  │ • VectorStore  (readonly)     │
                  │ • watcher+ticks  │  │ • MetaStore    (readonly)     │
                  │ • obs/queue      │  │ • ObservationsStore (readonly)│
                  │ • 1s HEARTBEAT   │  │ • HybridSearcher + handler    │
                  │ • serves writes  │  │ • NO watcher/ticks/queues     │
                  │ • applies bumps  │  │ • forwards retrieval bumps    │
                  └──────────────────┘  └───────────────────────────────┘
```

The MAIN and WRITER threads keep their **current** roles unchanged except for routing and bump relay. Readers are new.

## 4. Request classification (the routing crux)

A pure function `classifyRoute(method, pathname): 'read' | 'write' | 'control'` drives routing. Classification (from the route-table audit):

| Route | Class | Route to |
|---|---|---|
| `GET /health` | control | main (local heartbeat) |
| `POST /shutdown`, `GET /test/block` | control | writer |
| `GET /stats` | write* | **writer** (needs writer-local indexing/queue/metrics state) |
| `POST /search/all`, `/search/memory`, `/search/skill`, `/search/observations` | read | **reader pool** |
| `POST /get_full`, `GET /observation/full` | read | **reader pool** |
| `POST /inject/context` | read | **reader pool** |
| `GET /observations/recent`, `GET /recall/list` | read | **reader pool** |
| `GET /pending_embed/retry` | read | writer (counts writer queue) |
| `POST /reindex`, `/observation/enqueue`, `/observation/flush` | write | writer |

`*` `/stats` is corpus-read-only but reports the writer's in-memory `indexingState`/`metrics`/queue counts, so it must run on the writer. It is rare (not the hot path) and short (< ~200 ms), well under the 5 s heartbeat threshold.

**Saturation policy:** when all readers are busy, reads **queue** for the next free reader. Reads NEVER overflow to the writer — that would re-introduce blocking on the heartbeat thread. Slow-but-alive beats fast-but-crashing.

## 5. Read-only engine mode

New `WorkerOptions.readOnly?: boolean`. When set, `startWorker`:

1. Opens **VectorStore** and **MetaStore** with `readonly: true` (skip `CREATE TABLE` DDL, skip `PRAGMA journal_mode=WAL` — WAL is a persistent DB property the writer already set; readers just respect it). Skip migrations.
2. Opens **ObservationsStore** with `readonly: true` + skip migrations/DDL (needed for `dropArchived` + recency reads during search).
3. **Skips** entirely: IngestPipeline, FileWatcher + initial-index pass, stored_tokens backfill, ObservationQueue, PendingEmbedQueue, the summarizer wiring, and **both** `setInterval` ticks (obs-summarize, pending-embed-retry). Mechanically: a reader omits `watchPaths`, `summarize`, `observationQueueDbPath`, `pendingEmbedDbPath`, and the `readOnly` flag additionally suppresses the backfill (`if (obsStore && !readOnly)`).
4. Retrieval bumps: instead of `obsStore.bumpRetrieval(...)` (would throw on a readonly handle), the handler calls an injected sink `WorkerOptions.onRetrievalBump?(ids, source)`. Readers wire this to forward the bump to the writer (§6). When `onRetrievalBump` is absent (normal/writer mode), the handler bumps `obsStore` directly as today.

Store constructors gain a `readonly?: boolean` option that opens `new Database(path, { readonly: true })` and skips all write-on-open work (DDL, WAL pragma, migrations, queue-reset). Read methods are unchanged.

**Startup ordering:** spawn the writer first and await its `ready` (schema created/migrated). Only then spawn the N readers (each opens readonly against the now-initialized files) and await their `ready`. Health is reported as soon as the writer is ready; readers joining is non-blocking (reads 503 `engine_unavailable` only if zero readers are up yet — main may briefly serve reads from the writer ONLY during the cold-start window before any reader is ready, then stop once a reader is up; this is the single, bounded exception to "never read on the writer").

## 6. Retrieval-bump forwarding (fire-and-forget side channel)

Bumps are tiny `UPDATE` counters, already failure-tolerant (logged no-op on error). To keep readers strictly read-only (idiot-proof: a reader physically cannot corrupt the corpus), bumps are **forwarded to the writer**, not written by readers:

1. Reader handler computes results, then calls `onRetrievalBump(ids, source)`.
2. The reader's engine wiring posts a kind-tagged message to main: `{ kind: 'bump', ids, source }` (same mechanism as the existing `beat`/`ready`/`fatal` messages — NOT a request/response frame, so no correlation/await).
3. Main receives it from that reader's port and forwards `{ kind: 'bump', ids, source }` to the **writer** port.
4. The writer engine handles the `bump` message by calling `obsStore.bumpRetrieval(ids, source)` on its single read-write connection.

This adds no latency to the search response (fire-and-forget) and keeps a single writer of record for `observations.db`. A dropped bump under shutdown is acceptable (counter is approximate).

## 7. Health, supervision, lifecycle

- **Liveness:** unchanged — `/health` is computed on the main thread from the **writer's** heartbeat. A busy reader is normal, not unhealthy, and does not affect `/health`.
- **Reader supervision:** main attaches a Worker `error`/`fatal` handler per reader (mirroring the existing engine-supervisor). On reader crash, main removes it from the pool, respawns it, and continues routing to the survivors. A crash of the **writer** behaves exactly as today (respawn; `/health` degraded meanwhile).
- **Routing during a reader respawn:** the crashed reader is removed from the ready set; in-flight requests to it reject with `engine_unavailable` (the existing 503 path) and may be retried by the caller. No request is silently dropped.
- **Shutdown:** main stops all readers then the writer (or vice-versa); each engine's `stop()` clears timers and closes stores.

## 8. Configuration & safety fallback

- `CAPTAIN_MEMO_READER_POOL_SIZE` — integer N, **default `2`**. Clamped to `[0, 8]`.
- `N = 0` → **no readers**; main routes everything to the writer (exactly today's behavior). This is the safety escape hatch: if the reader path ever misbehaves, set `0` to revert without a redeploy.
- The pool is only active in threaded mode (`CAPTAIN_MEMO_WORKER_THREADED=1`); the non-threaded single-process worker is unchanged.
- If a reader fails to boot (e.g., readonly open before the writer initialized the file), main logs it and proceeds with fewer readers; if **all** readers are down, reads fall back to the writer with a logged warning (degraded but functional) until a reader recovers.

## 9. Testing strategy

**Unit (pure, fast):**
- `classifyRoute(method, path)` — table-driven: every route maps to the expected class.
- Pool selection — least-busy/round-robin picks a free reader; queues when all busy; never returns the writer for a `read` when ≥1 reader is ready.
- Store `readonly` opens — a readonly VectorStore/MetaStore/ObservationsStore can `query`/read but throws on write; does not run DDL/migrations.

**Integration (threaded, real Bun Workers):**
- Boot writer + 2 readers against a seeded temp corpus; assert searches return correct hits from a reader.
- **Heartbeat-under-load (the regression test):** fire K concurrent `/search/*` while polling `/health`; assert `/health` stays `healthy` throughout (the writer beat never goes stale), where the pre-fix single-engine worker would degrade. Use the existing `/test/block`-style harness pattern.
- Bump forwarding: a reader-served search increments `from_search` on the writer's `observations.db` (poll until applied).
- Cold start: reads issued before any reader is ready are served by the writer, then move to readers once ready.
- `N=0` fallback: everything routes to the writer; behavior identical to the non-pool worker.

## 10. Out of scope (future)

- **ANN vector index** to cut the O(N) scan (different backend; complementary).
- **Per-reader warm caches** / query-result caching.
- Routing of any additional read-serving extension points to the pool (handled where those features live).

## 11. Files touched (anticipated)

- `src/shared/worker-env.ts` (or wherever env→options happens) — read `CAPTAIN_MEMO_READER_POOL_SIZE`.
- `src/worker/index.ts` — `WorkerOptions.readOnly` + `onRetrievalBump`; gate write-only setup on `!readOnly`; bump closures use the injected sink.
- `src/worker/vector-store.ts`, `meta.ts`, `observations-store.ts` — `readonly` constructor option.
- `src/worker/engine.ts` — reader vs writer boot; reader posts `bump`; writer handles `bump`.
- `src/worker/threaded-main.ts` — spawn writer + N readers; `classifyRoute` routing; bump relay; reader supervision.
- New: `src/worker/route-class.ts` (pure classifier), `src/worker/reader-pool.ts` (pool/selection logic) — kept as small pure-ish units for testability.
- Tests under `tests/unit/` and `tests/integration/`.
