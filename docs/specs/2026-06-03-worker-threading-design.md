# Captain Memo — Worker Threading: a non-starvable HTTP/health front

- **Date:** 2026-06-03
- **Target:** next release; lands behind a flag, default-off, then default-on once proven
- **Status:** Approved design → implementation
- **Author:** Kalin Bogatzevski (design assisted)
- **Spec references:** `docs/specs/2026-05-31-worker-auto-recovery-design.md` (the recovery layer this correction makes largely unnecessary)

## 1. Summary

The worker is a single Bun process that runs the HTTP server **and** all heavy work on **one event loop**. Heavy *synchronous* operations — `bun:sqlite` search / ingest / reindex over a real corpus (386 MB vector store, ~25 K observations) — can block that loop long enough that even `GET /health` cannot answer within the self-heal's probe window.

The downstream effect is severe: the `SessionStart` / `UserPromptSubmit` self-heal then misreads a **busy-but-alive** worker as dead and reclaims it; the reclaim is a non-atomic `stop`-then-`start` whose `stop` (SIGTERM → 90 s default → SIGKILL on a busy process) outlives the short-lived hook, so `start` never runs and `Restart=always` does not fire for an intentional stop — leaving the worker **dead for 12–82 minutes** until a later session revives it. Observed in the field: **1,516 hook connect-failures in a single day** under ~4 concurrent sessions.

**Root cause (established via systematic debugging):** event-loop **starvation**. The single thread serves `/health` *and* does the heavy work, so heavy work can starve health. The recovery layer is fragile, but the death **originates here** — fixing recovery alone is a symptom correction.

**The correction:** relocate **all** heavy work onto a dedicated **engine thread**, and keep a **thin main thread** that serves HTTP and answers `/health` instantly. The HTTP/health front can no longer be starved, which severs the death → false-"dead" → restart-thrash → outage chain at its source.

**Single engine thread (not a pool)** — chosen for minimal change and risk. It also sidesteps the hardest sub-problem: with exactly one engine thread, every `bun:sqlite` handle lives and is used *only* on that thread, **never shared**, so there is no cross-thread DB coordination (no WAL multi-connection, no `SQLITE_BUSY`, no write-serialization). The storage/search code is **relocated, not rewritten**.

**Cross-platform by construction.** Bun Worker threads + per-thread `bun:sqlite` behave identically on Linux and Windows; the change is entirely in-process and OS-agnostic. Worker threads open no console, so the v0.2.20 windowless Windows launch is preserved.

## 2. Decisions (locked)

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| 1 | Topology | **Thin HTTP main thread + one dedicated engine thread** | Minimal change; HTTP/health can't be starved; sidesteps cross-thread SQLite. |
| 2 | Boundary | **A small, self-contained request/response message channel** (id-correlated) between main and engine | One contract; the scaling seam (engine → pool, later) hides behind it. No external deps. |
| 3 | `/health` | Answered on **main** from an engine **heartbeat**: fresh → `healthy`; stale → `degraded (engine busy Xs on <op>)` | Non-blocking **and** honest — a genuinely-stuck engine still surfaces; a merely-busy one is never misjudged dead. |
| 4 | SQLite | **All connections owned by the engine thread only; never shared** | Single thread ⇒ no WAL multi-connection / `SQLITE_BUSY` / write-serialization to design. |
| 5 | Crash recovery | Engine `error`/`exit` → main **respawns the engine in-process** (sub-second), fails in-flight with a retriable error; **crash-loop cap** drops `/health` to degraded | Thread-level self-heal; the OS supervisor becomes a rarely-used last resort. |
| 6 | Backpressure | Per-request **deadline**; engine non-reply → fast `503` / empty envelope | A slow engine degrades the *response*, never the *server*; `/inject/context` gets a tight deadline so a prompt never hangs. |
| 7 | Rollout | Behind `CAPTAIN_MEMO_WORKER_THREADED`; **default-off** the release it ships in; the single-thread path stays intact and selected by default | Safe on critical infra; validate on the Linux captain (the thrashing box) then a Windows captain, then flip default-on with `=0` as escape hatch. |
| 8 | Recovery cleanup | Keep **`TimeoutStopSec=10`** + an **atomic `systemctl restart`** path; **drop** the gentler-probe idea | Tiny orthogonal hardening so any *rare* manual restart is fast and can't strand; the gentler probe is moot once `/health` can't be starved. |
| 9 | Instrumentation | The heartbeat **is** the event-loop-lag log: a stall beyond threshold is logged with `op` + duration | Verifies the death is gone *and* finally shows which ops stall (informs a future pool). |
| 10 | Cross-platform | In-process Bun Worker; **no OS-specific threading code**; windowless launch preserved on Windows | Ships to Linux and Windows identically. |

## 3. Architecture

```
   ┌──────────────────────── worker process ────────────────────────┐
   │  MAIN THREAD (thin, never blocks)        ENGINE THREAD (heavy)   │
   │  ┌──────────────────┐    request msg     ┌────────────────────┐  │
   │  │ Bun.serve        │ ─────────────────▶ │ MetaStore (sqlite) │  │
   │  │  GET /health  ◀───── heartbeat ─────── │ VectorStore(sqlite)│  │
   │  │  proxy all else  │ ◀──── reply msg ─── │ Observations/queue │  │
   │  │   → engine       │                     │ search/ingest/watch│  │
   │  └──────────────────┘                     │ observation tick   │  │
   │   answers /health locally                 └────────────────────┘  │
   └─────────────────────────────────────────────────────────────────┘
```

- **Main thread** = thin HTTP front. `Bun.serve` parses each request, forwards `{id, op, payload}` to the engine, awaits `{id, result|error}`, writes the HTTP response. The only thing it computes locally is `GET /health`.
- **Engine thread** = essentially today's entire `startWorker()` logic, **relocated unchanged** — all stores, search, ingest, the file watcher, and the observation/embed ticks.
- Today there is one engine; the boundary is designed so it can later become a **pool** (parallel search for higher concurrent throughput) without changing the HTTP layer. Out of scope now.

## 4. Boundary — the main↔engine channel

A self-contained helper (≈ the discipline of any id-correlated RPC, implemented standalone, **no external module dependency**):

- Main keeps a pending-map `id → resolver`. `request(op, payload)` posts a message and returns a Promise resolved when `{id, result}` arrives, rejected on `{id, error}` or deadline.
- Engine's message handler dispatches on `op` to the relevant store/pipeline call and posts the reply.
- `op` is an open verb set mirroring today's endpoints: `search_all`, `search_memory|skill|observations`, `inject`, `get_full`, `reindex`, `stats`, `observation_enqueue|flush`, `pending_embed_retry`. Adding a new request type later is one `op` + one dispatch arm.
- What crosses the boundary is small: query strings + ingest payloads in, hit arrays / envelopes / stats out. **Embeddings never cross** — the engine embeds and searches internally, so a slow Voyage roundtrip is awaited *on the engine* (async, yielding to other engine ops) and is invisible to the main thread. Structured-clone cost is bounded and far cheaper than the work it guards.

## 5. `/health` — honest and non-blocking

- The engine posts a heartbeat `{ts, busy_op?}` on a ~1 s timer **and** after each op completes.
- Main tracks `lastBeat`. `GET /health` returns `{healthy:true}` if `now - lastBeat < FRESH_MS` (e.g. 5 s), else `{healthy:false, degraded:'engine busy <busy_op> for <age>ms'}`.
- This distinguishes three states the old `/health` could not: **alive+idle**, **alive+busy/stuck** (stale beat), **main dead** (no response). A busy engine is never killed for being slow; a truly wedged engine still surfaces (and the crash-loop/last-resort path can act).
- The stale-beat event is logged (`[worker] engine stalled <op> <age>ms`) — this is the verification instrumentation, built in.

## 6. Crash recovery + what this retires

- Main listens for the engine Worker's `error`/`exit`/`messageerror`. On unexpected death: log, reject in-flight requests (retriable), **respawn a fresh engine** (re-opens WAL stores; recovery is automatic), reconnect the channel. Sub-second; no process exit.
- **Crash-loop guard:** cap respawns per rolling window; beyond the cap, hold `/health` degraded so the OS supervisor (systemd `Restart=always` / Windows Scheduled-Task) is the *last* resort.
- **Net effect on the existing recovery layer:** once `/health` can't be starved, the false-"dead" verdicts vanish → the self-heal stops reclaiming busy workers → the thrash and 12–82 min outages disappear at the source. We keep two cheap orthogonal items (`TimeoutStopSec=10`, atomic restart) and drop the rest.

## 7. Rollout

- Flag `CAPTAIN_MEMO_WORKER_THREADED` selects the engine-thread path; **default-off** the release it ships in. The single-threaded `startWorker` path is unchanged and remains the default, so existing installs are byte-for-byte unaffected until the flag flips.
- Validate on **this Linux captain** (the exact box that thrashed) under real multi-session load, then on a **Windows captain**, then flip the default-on in a subsequent release.

## 8. Testing (TDD)

1. **Spike (first task, both OSes):** prove `bun:sqlite` opens + queries inside a Bun Worker thread and a `postMessage` round-trip works — on Linux and Windows — before the refactor.
2. **Unit:** channel correlation/timeout/reject-on-engine-death (injectable transport); heartbeat→health policy with an injectable clock (fresh/stale/degraded); respawn + crash-loop-cap policy.
3. **Headline property test:** with the engine deliberately blocked for 5 s (a test `op` that spins), assert `GET /health` answers in **< 100 ms throughout** and reports `degraded` — i.e. prove starvation is impossible.
4. **Crash test:** kill the engine mid-flight; assert auto-respawn, in-flight requests reject retriably, the next request succeeds.
5. **Regression:** the entire existing worker test suite passes with `CAPTAIN_MEMO_WORKER_THREADED=1` (engine logic is unchanged).

## 9. Scope

**In:** thin HTTP main thread; one engine thread; the message channel; heartbeat `/health`; per-request deadlines; engine crash auto-respawn; the flag + dual-path selection; the two retained recovery items (`TimeoutStopSec`, atomic restart); cross-platform spike; the test set above.

**Out (explicitly not now):** an engine **pool** / per-op parallelism (the boundary is built to allow it later); any change to the search/ingest/embedding logic itself (it is relocated, not modified); any change to the OS service-manager layer beyond items #8.

## 10. Cross-platform notes

- The threading is in-process; the OS service manager (systemd unit / Windows Scheduled Task + wscript launcher) only ever launches the worker process and is unaware it uses threads. No service-manager change is required for threading.
- Worker threads spawn no console window → the v0.2.20 hidden/windowless Windows launch is preserved.
- The spike (Task 1) runs on both Linux and Windows to confirm `bun:sqlite` + Worker parity before the refactor proceeds.
