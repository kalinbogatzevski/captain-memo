# Worker Threading (non-starvable HTTP front) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the worker's HTTP/`/health` front impossible to starve by relocating all heavy work to a dedicated engine thread, behind `CAPTAIN_MEMO_WORKER_THREADED` (default-off), cross-platform, with the existing single-threaded path untouched and default.

**Architecture:** A thin **main thread** runs `Bun.serve` and answers `GET /health` locally from an engine **heartbeat**; everything else is proxied as `{id, request}` messages to an **engine thread** that runs the *existing, unchanged* `startWorker()` handler. One engine thread ⇒ every `bun:sqlite` handle stays on that thread (no cross-thread DB). Engine crash → main respawns it in-process.

**Tech Stack:** Bun (Worker threads, `bun:sqlite`, `Bun.serve`), TypeScript, `bun test`. No new deps.

**Spec:** `docs/specs/2026-06-03-worker-threading-design.md`.

**Release:** lands on `master`; published as a new public version (github + gitlab). `CAPTAIN_MEMO_WORKER_THREADED` default-off in the release; this Linux captain opts in (`=1`) after validation.

---

## File Structure

**New files**
```
src/worker/thread-channel.ts        # id-correlated request/response over a postMessage transport (self-contained, no cross-module dependency)
src/worker/request-serde.ts         # serialize/deserialize Request + Response across the thread boundary
src/worker/health-heartbeat.ts      # pure policy: (lastBeatMs, now, busyOp) -> health verdict
src/worker/engine-supervisor.ts     # pure policy: crash-respawn decision + crash-loop cap
src/worker/engine.ts                # ENGINE Worker entry: startWorker(noServe) + wire handler<->channel + heartbeat
src/worker/threaded-main.ts         # MAIN thread: spawn engine Worker, Bun.serve proxy + local /health, crash-respawn
tests/unit/worker/thread-channel.test.ts
tests/unit/worker/request-serde.test.ts
tests/unit/worker/health-heartbeat.test.ts
tests/unit/worker/engine-supervisor.test.ts
tests/integration/worker-threaded.test.ts   # headline: engine blocked 5s -> /health <100ms; crash -> respawn
```

**Modified files**
```
src/worker/index.ts          # startWorker: opts.noServe -> return handler in WorkerHandle (don't Bun.serve); runWorkerCli: branch on the flag
services/worker/systemd/captain-memo-worker.user.service   # TimeoutStopSec=10 (retained recovery item B)
src/services/service-manager/types.ts + systemd.ts         # add restart() (atomic) — retained recovery item A
```

**Boundary contract (every task codes to this):** main↔engine messages are
`{kind:'req', id, data}` (main→engine), `{kind:'res', id, data}` / `{kind:'err', id, message}` (engine→main), and `{kind:'beat', ts, busy_op}` (engine→main, fire-and-forget). `data` for req/res is the serialized Request/Response from `request-serde.ts`.

---

## Task 1: Spike — `bun:sqlite` + Worker + round-trip (foundation, both OSes)

**Files:**
- Create: `tests/integration/worker-thread-spike.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { test, expect } from 'bun:test';

// Proves the three foundations the design rests on, on whatever OS runs it:
// (1) a Bun Worker thread starts, (2) bun:sqlite opens + queries INSIDE it,
// (3) a postMessage round-trip works. If this fails, stop — the design's premise is wrong.
test('bun:sqlite opens in a Worker thread and round-trips a message', async () => {
  const src = `
    import { Database } from 'bun:sqlite';
    const db = new Database(':memory:');
    db.run('CREATE TABLE t (x INTEGER)');
    db.run('INSERT INTO t (x) VALUES (41)');
    self.onmessage = (e) => {
      const row = db.query('SELECT x+1 AS y FROM t').get();
      postMessage({ echo: e.data, y: row.y });
    };
  `;
  const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
  const w = new Worker(url);
  const reply = await new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('worker timeout')), 5000);
    w.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
    w.onerror = (e) => { clearTimeout(t); reject(new Error(String((e as ErrorEvent).message))); };
    w.postMessage('ping');
  });
  w.terminate();
  expect(reply.echo).toBe('ping');
  expect(reply.y).toBe(42);
});
```

- [ ] **Step 2: Run it**

Run: `bun test tests/integration/worker-thread-spike.test.ts`
Expected: PASS. If FAIL, STOP and report — the threading premise needs revisiting before any refactor. (Re-run this same test on Windows before flipping the default there.)

- [ ] **Step 3: Commit**

```bash
git add tests/integration/worker-thread-spike.test.ts
git commit -m "test(worker): spike — bun:sqlite + Worker thread + message round-trip"
```

---

## Task 2: `ThreadChannel` — id-correlated request/response

**Files:**
- Create: `src/worker/thread-channel.ts`
- Test: `tests/unit/worker/thread-channel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test';
import { ThreadChannel } from '../../../src/worker/thread-channel.ts';

// In-memory transport pair wiring two channels together (no real Worker needed).
function pair() {
  let aRecv!: (m: unknown) => void, bRecv!: (m: unknown) => void;
  const a = new ThreadChannel({ post: (m) => bRecv(m), onMessage: (cb) => { aRecv = cb; } });
  const b = new ThreadChannel({ post: (m) => aRecv(m), onMessage: (cb) => { bRecv = cb; } });
  return { a, b };
}

test('request resolves with the responder result, correlated by id', async () => {
  const { a, b } = pair();
  b.serve(async (data) => ({ ok: true, got: data }));
  const res = await a.request({ q: 'hi' });
  expect(res).toEqual({ ok: true, got: { q: 'hi' } });
});

test('two concurrent requests resolve to their own results', async () => {
  const { a, b } = pair();
  b.serve(async (data: any) => ({ n: data.n * 10 }));
  const [r1, r2] = await Promise.all([a.request({ n: 1 }), a.request({ n: 2 })]);
  expect(r1).toEqual({ n: 10 });
  expect(r2).toEqual({ n: 20 });
});

test('responder error rejects the requester', async () => {
  const { a, b } = pair();
  b.serve(async () => { throw new Error('boom'); });
  await expect(a.request({})).rejects.toThrow('boom');
});

test('request times out when no response arrives', async () => {
  const ch = new ThreadChannel({ post: () => {}, onMessage: () => {} }, 30);
  await expect(ch.request({})).rejects.toThrow('thread_rpc_timeout');
});

test('rejectAll fails in-flight (used on engine crash)', async () => {
  const ch = new ThreadChannel({ post: () => {}, onMessage: () => {} }, 5000);
  const p = ch.request({});
  ch.rejectAll('engine_gone');
  await expect(p).rejects.toThrow('engine_gone');
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test tests/unit/worker/thread-channel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/worker/thread-channel.ts — a tiny, self-contained id-correlated request/response
// helper over a postMessage-style transport. NO external dependency. Used between the
// worker's main thread (requester) and its engine thread (responder); heartbeats ride
// the same transport as a separate {kind:'beat'} message handled outside this class.
let seq = 0;
function nextId(): string { return `r${(seq = (seq + 1) % Number.MAX_SAFE_INTEGER)}`; }

export interface Transport {
  post: (msg: unknown) => void;
  onMessage: (cb: (msg: unknown) => void) => void;
}

type ReqMsg = { kind: 'req'; id: string; data: unknown };
type ResMsg = { kind: 'res'; id: string; data: unknown };
type ErrMsg = { kind: 'err'; id: string; message: string };

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; }

export class ThreadChannel {
  private pending = new Map<string, Pending>();
  private handler: ((data: unknown) => Promise<unknown>) | null = null;

  constructor(private transport: Transport, private timeoutMs = 30_000) {
    transport.onMessage((msg) => { void this.dispatch(msg as ReqMsg | ResMsg | ErrMsg); });
  }

  /** Responder side: register the handler that turns a request into a result. */
  serve(handler: (data: unknown) => Promise<unknown>): void { this.handler = handler; }

  /** Requester side: send a request, resolve with the responder's result. */
  request(data: unknown): Promise<unknown> {
    const id = nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('thread_rpc_timeout')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.post({ kind: 'req', id, data } satisfies ReqMsg);
    });
  }

  private async dispatch(msg: ReqMsg | ResMsg | ErrMsg): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'req') {
      if (!this.handler) { this.transport.post({ kind: 'err', id: msg.id, message: 'no_handler' } satisfies ErrMsg); return; }
      try {
        const data = await this.handler(msg.data);
        this.transport.post({ kind: 'res', id: msg.id, data } satisfies ResMsg);
      } catch (e) {
        this.transport.post({ kind: 'err', id: msg.id, message: (e as Error).message } satisfies ErrMsg);
      }
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;                       // late / unknown id
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.kind === 'res') p.resolve(msg.data);
    else p.reject(new Error(msg.message));
  }

  /** Reject every in-flight request — called when the engine dies. */
  rejectAll(reason: string): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun test tests/unit/worker/thread-channel.test.ts`
Expected: PASS (all five).

- [ ] **Step 5: Commit**

```bash
git add src/worker/thread-channel.ts tests/unit/worker/thread-channel.test.ts
git commit -m "feat(worker): ThreadChannel — id-correlated request/response for the engine boundary"
```

---

## Task 3: `request-serde` — Request/Response across the boundary

**Files:**
- Create: `src/worker/request-serde.ts`
- Test: `tests/unit/worker/request-serde.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test';
import { serializeRequest, deserializeRequest, serializeResponse, deserializeResponse } from '../../../src/worker/request-serde.ts';

test('GET request round-trips (no body)', async () => {
  const wire = await serializeRequest(new Request('http://localhost:39888/stats', { method: 'GET' }));
  const req = deserializeRequest(wire);
  expect(req.method).toBe('GET');
  expect(new URL(req.url).pathname).toBe('/stats');
});

test('POST request round-trips body + json()', async () => {
  const wire = await serializeRequest(new Request('http://localhost:39888/search/all', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x', top_k: 5 }),
  }));
  const req = deserializeRequest(wire);
  expect(req.method).toBe('POST');
  expect(await req.json()).toEqual({ query: 'x', top_k: 5 });
});

test('JSON response round-trips status + body', async () => {
  const wire = await serializeResponse(Response.json({ healthy: true }, { status: 200 }));
  const res = deserializeResponse(wire);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ healthy: true });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test tests/unit/worker/request-serde.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/worker/request-serde.ts — turn a Request/Response into a structured-cloneable
// plain object and back, so the unchanged worker handler can run on the engine thread.
// Bodies are read as text (all worker responses are Response.json/text); bounded sizes.

export interface WireRequest { method: string; url: string; headers: Record<string, string>; body: string | null; }
export interface WireResponse { status: number; headers: Record<string, string>; body: string; }

export async function serializeRequest(req: Request): Promise<WireRequest> {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return {
    method: req.method,
    url: req.url,
    headers: Object.fromEntries(req.headers),
    body: hasBody ? await req.text() : null,
  };
}

export function deserializeRequest(w: WireRequest): Request {
  return new Request(w.url, {
    method: w.method,
    headers: w.headers,
    ...(w.body !== null ? { body: w.body } : {}),
  });
}

export async function serializeResponse(res: Response): Promise<WireResponse> {
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
}

export function deserializeResponse(w: WireResponse): Response {
  return new Response(w.body, { status: w.status, headers: w.headers });
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun test tests/unit/worker/request-serde.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/request-serde.ts tests/unit/worker/request-serde.test.ts
git commit -m "feat(worker): request-serde — proxy Request/Response across the thread boundary"
```

---

## Task 4: `health-heartbeat` — pure `/health` verdict from the beat

**Files:**
- Create: `src/worker/health-heartbeat.ts`
- Test: `tests/unit/worker/health-heartbeat.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test';
import { healthFromHeartbeat } from '../../../src/worker/health-heartbeat.ts';

test('fresh beat -> healthy', () => {
  expect(healthFromHeartbeat({ lastBeatMs: 1000, busyOp: null }, 1200, 5000)).toEqual({ healthy: true });
});

test('stale beat -> degraded with age + busy op', () => {
  const v = healthFromHeartbeat({ lastBeatMs: 1000, busyOp: '/search/all' }, 9000, 5000);
  expect(v.healthy).toBe(false);
  expect(v.degraded).toContain('8000ms');
  expect(v.degraded).toContain('/search/all');
});

test('stale + idle -> degraded mentions idle', () => {
  const v = healthFromHeartbeat({ lastBeatMs: 0, busyOp: null }, 6000, 5000);
  expect(v.healthy).toBe(false);
  expect(v.degraded).toContain('idle');
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test tests/unit/worker/health-heartbeat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/worker/health-heartbeat.ts — pure verdict for the main thread's /health, derived
// from the engine's last heartbeat. Non-blocking AND honest: a fresh beat means the
// engine's loop is turning (healthy); a stale beat means it's wedged on its last op.
export interface HeartbeatState { lastBeatMs: number; busyOp: string | null; }
export interface HealthVerdict { healthy: boolean; degraded?: string; }

export function healthFromHeartbeat(state: HeartbeatState, now: number, freshMs = 5000): HealthVerdict {
  const age = now - state.lastBeatMs;
  if (age < freshMs) return { healthy: true };
  const where = state.busyOp ? `on ${state.busyOp}` : 'idle';
  return { healthy: false, degraded: `engine unresponsive ${age}ms (${where})` };
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun test tests/unit/worker/health-heartbeat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/health-heartbeat.ts tests/unit/worker/health-heartbeat.test.ts
git commit -m "feat(worker): health-heartbeat — honest non-blocking /health verdict"
```

---

## Task 5: `engine-supervisor` — pure crash-respawn policy

**Files:**
- Create: `src/worker/engine-supervisor.ts`
- Test: `tests/unit/worker/engine-supervisor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test';
import { onEngineCrash, type SupervisorState } from '../../../src/worker/engine-supervisor.ts';

test('respawns while under the cap', () => {
  const s: SupervisorState = { crashes: [] };
  for (let i = 0; i < 5; i++) expect(onEngineCrash(s, 1000 + i, 5, 60_000).action).toBe('respawn');
});

test('gives up past the cap within the window', () => {
  const s: SupervisorState = { crashes: [] };
  for (let i = 0; i < 5; i++) onEngineCrash(s, 1000 + i, 5, 60_000);
  expect(onEngineCrash(s, 1010, 5, 60_000).action).toBe('give-up');
});

test('old crashes outside the window are pruned -> respawns again', () => {
  const s: SupervisorState = { crashes: [1, 2, 3, 4, 5] };
  expect(onEngineCrash(s, 1_000_000, 5, 60_000).action).toBe('respawn');
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test tests/unit/worker/engine-supervisor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/worker/engine-supervisor.ts — pure policy for engine-thread crashes. Respawn on
// crash, but cap respawns within a rolling window so a hard-broken engine (corrupt DB,
// bad config) degrades instead of fork-bombing — at which point the OS supervisor is the
// last resort.
export interface SupervisorState { crashes: number[]; }   // epoch ms of recent crashes
export interface SupervisorDecision { action: 'respawn' | 'give-up'; }

export function onEngineCrash(state: SupervisorState, now: number, maxInWindow = 5, windowMs = 60_000): SupervisorDecision {
  state.crashes = state.crashes.filter((t) => now - t < windowMs);
  state.crashes.push(now);
  return { action: state.crashes.length > maxInWindow ? 'give-up' : 'respawn' };
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun test tests/unit/worker/engine-supervisor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/engine-supervisor.ts tests/unit/worker/engine-supervisor.test.ts
git commit -m "feat(worker): engine-supervisor — crash-respawn with crash-loop cap"
```

---

## Task 6: `index.ts` — `noServe` mode + extract `buildWorkerOptionsFromEnv`

**Files:**
- Modify: `src/worker/index.ts`
- Test: regression via the full suite (no new behavior in the default path).

> Two changes: (a) let `startWorker` build everything + the handler WITHOUT binding a port, and (b) make the env→options building reusable by the engine. The default path stays byte-for-byte behaviorally identical.

- [ ] **Step 1: Add `noServe` to `WorkerOptions`.** Find `export interface WorkerOptions {` and add inside it:
```ts
  /** Engine-thread mode: build stores + handler but do NOT bind an HTTP port.
   *  The caller (engine.ts) wires `handler` to the thread channel instead. */
  noServe?: boolean;
```

- [ ] **Step 2: Add `handler` to `WorkerHandle`.** Find `export interface WorkerHandle {` and add:
```ts
  /** The request handler — exposed so the engine thread can serve it over the channel. */
  handler?: (req: Request) => Promise<Response>;
```

- [ ] **Step 3: Branch the return on `noServe`.** Find this block (the end of `startWorker`):
```ts
  const server = Bun.serve({
    port: opts.port,
    fetch: handler,
  });

  return {
    port: server.port ?? opts.port,
    ...(obsStore ? { store: obsStore } : {}),
    stop: async () => {
      if (tickTimer) clearInterval(tickTimer);
      if (pendingTickTimer) clearInterval(pendingTickTimer);
      if (watcher) await watcher.close();
      server.stop(true);
      if (obsQueue) obsQueue.close();
      if (obsStore) obsStore.close();
      if (pendingEmbed) pendingEmbed.close();
      vector.close();
      meta.close();
    },
  };
}
```
Replace with:
```ts
  const stopResources = async () => {
    if (tickTimer) clearInterval(tickTimer);
    if (pendingTickTimer) clearInterval(pendingTickTimer);
    if (watcher) await watcher.close();
    if (obsQueue) obsQueue.close();
    if (obsStore) obsStore.close();
    if (pendingEmbed) pendingEmbed.close();
    vector.close();
    meta.close();
  };

  if (opts.noServe) {
    // Engine-thread mode: no port bound; the engine serves `handler` over the channel.
    return {
      port: opts.port,
      handler,
      ...(obsStore ? { store: obsStore } : {}),
      stop: stopResources,
    };
  }

  const server = Bun.serve({
    port: opts.port,
    fetch: handler,
  });

  return {
    port: server.port ?? opts.port,
    handler,
    ...(obsStore ? { store: obsStore } : {}),
    stop: async () => { server.stop(true); await stopResources(); },
  };
}
```

- [ ] **Step 4: Extract `buildWorkerOptionsFromEnv`.** In `runWorkerCli()`, the block that reads `process.env.CAPTAIN_MEMO_*` and assembles the object passed to `startWorker(...)` (from `const port = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ...)` down to — and including — the object literal currently written as `const handle = await startWorker({ ...opts... })`) is relocated verbatim into a new exported function. Steps:
  1. Add, just above `export async function runWorkerCli()`:
```ts
/** Build WorkerOptions from process.env. Shared by the inline path (runWorkerCli) and
 *  the engine thread (engine.ts) so both boot identically. The caller adds `noServe`. */
export async function buildWorkerOptionsFromEnv(): Promise<WorkerOptions> {
```
  2. Move the existing env-reading + summarizer/embedder/watch resolution lines (everything currently between the data-dir `mkdirSync` setup and the `const handle = await startWorker({` call) into this function, and end it with `return { /* the SAME object literal currently passed to startWorker */ };` then `}`.
  3. In `runWorkerCli()`, replace the moved block with:
```ts
  const opts = await buildWorkerOptionsFromEnv();
  const handle = await startWorker(opts);
```
  4. Keep the post-start lines (`console.log('[worker] listening ...')`, the `shutdown` closure, `process.on('SIGINT'|'SIGTERM', shutdown)`) in `runWorkerCli()` unchanged. (The `mkdirSync` data-dir setup + `loadWorkerEnv()` stay at the top of `runWorkerCli` — the engine inherits the parent process env, so it does NOT call `loadWorkerEnv` again.)

- [ ] **Step 5: Typecheck + full regression.**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; all existing tests PASS (default path unchanged; `noServe`/`handler` are additive and unused by default).

- [ ] **Step 6: Commit**

```bash
git add src/worker/index.ts
git commit -m "refactor(worker): startWorker noServe mode + shared buildWorkerOptionsFromEnv"
```

---

## Task 7: `engine.ts` — the engine-thread entry

**Files:**
- Create: `src/worker/engine.ts`
- Test: covered by the Task 11 integration test (needs a real Worker).

- [ ] **Step 1: Implement**

```ts
// src/worker/engine.ts — ENGINE thread entry, loaded as a Bun Worker by threaded-main.ts.
// Runs the FULL worker (stores, search, ingest, ticks) via startWorker({noServe}) — so all
// bun:sqlite handles live and stay here — then serves the unchanged handler over the thread
// channel and emits a heartbeat so the main thread's /health is honest without blocking.
import { ThreadChannel } from './thread-channel.ts';
import { deserializeRequest, serializeResponse, type WireRequest } from './request-serde.ts';
import { buildWorkerOptionsFromEnv, startWorker } from './index.ts';

declare const self: Worker;

async function boot(): Promise<void> {
  const handle = await startWorker({ ...(await buildWorkerOptionsFromEnv()), noServe: true });
  const handler = handle.handler!;
  let busyOp: string | null = null;

  const channel = new ThreadChannel({
    post: (m) => postMessage(m),
    onMessage: (cb) => { self.onmessage = (e: MessageEvent) => cb(e.data); },
  });

  channel.serve(async (data) => {
    const wire = data as WireRequest;
    try { busyOp = new URL(wire.url).pathname; } catch { busyOp = '?'; }
    try {
      const res = await handler(deserializeRequest(wire));
      return await serializeResponse(res);
    } finally {
      busyOp = null;
    }
  });

  // Heartbeat: fire-and-forget so main answers /health locally. Posted on a timer AND the
  // timer naturally stops ticking if a synchronous op blocks the loop -> beat goes stale ->
  // /health reports degraded. That stall IS the event-loop-lag signal.
  const beat = () => { try { postMessage({ kind: 'beat', ts: Date.now(), busy_op: busyOp }); } catch { /* ignore */ } };
  beat();
  setInterval(beat, 1000);
  postMessage({ kind: 'ready' });
}

boot().catch((err) => {
  try { postMessage({ kind: 'fatal', message: (err as Error).message }); } catch { /* ignore */ }
  throw err;   // surfaces as the Worker 'error' event -> main respawns
});
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean (the `Worker`/`postMessage` globals resolve under Bun's types; the engine is exercised end-to-end in Task 11).

- [ ] **Step 3: Commit**

```bash
git add src/worker/engine.ts
git commit -m "feat(worker): engine thread — serves the unchanged handler + heartbeat"
```

---

## Task 8: `threaded-main.ts` — thin HTTP main + proxy + crash-respawn

**Files:**
- Create: `src/worker/threaded-main.ts`
- Test: covered by the Task 11 integration test.

- [ ] **Step 1: Implement**

```ts
// src/worker/threaded-main.ts — MAIN thread of the threaded worker. Spawns the engine Worker,
// runs a thin Bun.serve that answers GET /health LOCALLY from the engine heartbeat and proxies
// everything else to the engine. Respawns the engine in-process on crash. No bun:sqlite here.
import { ThreadChannel } from './thread-channel.ts';
import { serializeRequest, deserializeResponse, type WireResponse } from './request-serde.ts';
import { healthFromHeartbeat } from './health-heartbeat.ts';
import { onEngineCrash, type SupervisorState } from './engine-supervisor.ts';
import type { WorkerHandle } from './index.ts';

const ENGINE_URL = new URL('./engine.ts', import.meta.url).href;
const REQUEST_DEADLINE_MS = Number(process.env.CAPTAIN_MEMO_ENGINE_REQUEST_MS ?? 10_000);

export async function startThreadedWorker(port: number): Promise<WorkerHandle> {
  const hb = { lastBeatMs: Date.now(), busyOp: null as string | null };
  const sup: SupervisorState = { crashes: [] };
  let engine: Worker | null = null;
  let channel: ThreadChannel | null = null;
  let stopped = false;

  const handleEngineDeath = () => {
    if (stopped) return;
    channel?.rejectAll('engine_restarting');
    try { engine?.terminate(); } catch { /* ignore */ }
    engine = null; channel = null;
    if (onEngineCrash(sup, Date.now()).action === 'respawn') {
      hb.lastBeatMs = 0;                       // force /health degraded until the new engine beats
      spawnEngine();
    }
    // give-up: engine stays null -> /health degraded -> OS supervisor is the last resort.
  };

  function spawnEngine(): void {
    const w = new Worker(ENGINE_URL);
    const ch = new ThreadChannel({
      post: (m) => w.postMessage(m),
      onMessage: (cb) => {
        w.onmessage = (e: MessageEvent) => {
          const m = e.data as { kind?: string; ts?: number; busy_op?: string | null };
          if (m && m.kind === 'beat') { hb.lastBeatMs = m.ts ?? Date.now(); hb.busyOp = m.busy_op ?? null; return; }
          if (m && (m.kind === 'ready' || m.kind === 'fatal')) return;   // lifecycle, not RPC traffic
          cb(e.data);
        };
      },
    }, REQUEST_DEADLINE_MS);
    w.onerror = () => handleEngineDeath();
    engine = w; channel = ch;
  }

  spawnEngine();

  const server = Bun.serve({
    port,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/health') {
        const v = healthFromHeartbeat(hb, Date.now());
        return Response.json(
          v.healthy ? { healthy: true } : { healthy: false, degraded: v.degraded },
          { status: v.healthy ? 200 : 503 },
        );
      }
      if (!channel) return Response.json({ error: 'engine_unavailable' }, { status: 503 });
      try {
        const wire = (await channel.request(await serializeRequest(req))) as WireResponse;
        return deserializeResponse(wire);
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 503 });
      }
    },
  });

  return {
    port: server.port ?? port,
    stop: async () => {
      stopped = true;
      server.stop(true);
      channel?.rejectAll('worker_stopping');
      try { engine?.terminate(); } catch { /* ignore */ }
    },
  };
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `bun run typecheck`  → clean.
```bash
git add src/worker/threaded-main.ts
git commit -m "feat(worker): threaded-main — thin HTTP proxy, local /health, engine respawn"
```

---

## Task 9: Wire the flag into `runWorkerCli`

**Files:**
- Modify: `src/worker/index.ts`

- [ ] **Step 1: Add the branch.** In `runWorkerCli()`, AFTER the data-dir `mkdirSync(...)` setup and `loadWorkerEnv()` (so the env + dirs exist), and BEFORE `const opts = await buildWorkerOptionsFromEnv()` (added in Task 6), insert:

```ts
  const port = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
  if (process.env.CAPTAIN_MEMO_WORKER_THREADED === '1') {
    const { startThreadedWorker } = await import('./threaded-main.ts');
    const handle = await startThreadedWorker(port);
    console.log(`[worker] listening on http://localhost:${handle.port} (threaded: thin HTTP main + engine thread)`);
    const shutdown = async () => { await handle.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }
```

(`DEFAULT_WORKER_PORT` is already imported in `index.ts`. The inline path below is unchanged.)

- [ ] **Step 2: Smoke both paths.**

Run (inline, default): `CAPTAIN_MEMO_DATA_DIR=/tmp/cm-smoke-a CAPTAIN_MEMO_WORKER_PORT=39950 CAPTAIN_MEMO_SKIP_EMBED=1 CAPTAIN_MEMO_SUMMARIZER_PROVIDER=anthropic ANTHROPIC_API_KEY= timeout 6 bun src/worker/index.ts & sleep 3; curl -s localhost:39950/health; kill %1`
Expected: `{"healthy":true}`.
Run (threaded): same with `CAPTAIN_MEMO_WORKER_THREADED=1` and port `39951`.
Expected: `{"healthy":true}` and a log line containing `(threaded:`.

- [ ] **Step 3: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat(worker): CAPTAIN_MEMO_WORKER_THREADED flag selects the engine-thread path"
```

---

## Task 10: Retained recovery hardening — `TimeoutStopSec` + atomic restart

**Files:**
- Modify: `services/worker/systemd/captain-memo-worker.user.service`
- Modify: `src/services/service-manager/types.ts`, `src/services/service-manager/systemd.ts`, `src/services/service-manager/windows-scheduled-task.ts`, `src/shared/worker-control.ts`

- [ ] **Step 1: `TimeoutStopSec`.** In the unit template, under `[Service]` add:
```
TimeoutStopSec=10
```
(So a stop completes in ≤10 s instead of the 90 s default — SIGKILL is safe with WAL + durable queues. Re-rendered into the installed unit on next `captain-memo install`.)

- [ ] **Step 2: Add `restart` to the `ServiceManager` interface.** In `src/services/service-manager/types.ts`, add to the interface:
```ts
  /** Atomically replace the worker (stop+start as ONE supervisor job, so a caller dying
   *  mid-way cannot strand it stopped). opts mirror StopOptions for the force/graceful path. */
  restart(name: string, opts?: StopOptions): Promise<void>;
```

- [ ] **Step 3: Implement atomic restart on systemd.** In `src/services/service-manager/systemd.ts`, add the method to `SystemdServiceManager`:
```ts
  async restart(name: string, _opts?: StopOptions): Promise<void> {
    // ONE systemctl job owns stop->start; if the calling hook dies (or spawnSync times out),
    // systemd still completes BOTH phases, so the worker can never be left stopped.
    const r = systemctl(['restart', unitName(name)]);
    if (r.status !== 0) {
      throw new Error(
        `systemctl restart ${unitName(name)} failed (status ${r.status ?? '?'}): ` +
        `${((r.stderr ?? '') as string).trim() || r.error?.message || 'no stderr'}`,
      );
    }
  }
```

- [ ] **Step 4: Implement restart on Windows** as its existing force-reclaim sequence. In `src/services/service-manager/windows-scheduled-task.ts`, add:
```ts
  async restart(name: string, opts?: StopOptions): Promise<void> {
    await this.stop(name, { ...opts, force: true });   // hard-kills the port owner / zombie
    await this.start(name);
  }
```

- [ ] **Step 5: Route `restartWorker` through it.** In `src/shared/worker-control.ts`, replace the `stop` then `start` body with:
```ts
  await sm.restart(name, { graceful: opts.graceful ?? false, port: opts.port, force: true });
```
(systemd makes this atomic — fixing the abandoned-`start` outage; Windows keeps force-reclaim.)

- [ ] **Step 6: Typecheck + full suite.**

Run: `bun run typecheck && bun test`
Expected: clean + green (the `restart` addition is additive; existing recovery tests that asserted stop()+start() may need the assertion updated to `restart` — update them to match).

- [ ] **Step 7: Commit**

```bash
git add services/worker/systemd/captain-memo-worker.user.service src/services/service-manager/types.ts src/services/service-manager/systemd.ts src/services/service-manager/windows-scheduled-task.ts src/shared/worker-control.ts
git commit -m "fix(worker): atomic restart + TimeoutStopSec=10 (no more abandoned-start outage)"
```

---

## Task 11: Headline integration test — starvation is impossible

**Files:**
- Modify: `src/worker/index.ts` (a tightly-gated test-only block endpoint)
- Create: `tests/integration/worker-threaded.test.ts`

- [ ] **Step 1: Add a gated block endpoint.** In the `handler` in `src/worker/index.ts`, just after the `/health` block, add (off unless explicitly enabled — never in production):
```ts
      if (req.method === 'GET' && url.pathname === '/test/block' && process.env.CAPTAIN_MEMO_ENABLE_TEST_ENDPOINTS === '1') {
        const ms = Math.min(30_000, Number(url.searchParams.get('ms') ?? 1000));
        const until = Date.now() + ms;
        while (Date.now() < until) { /* deliberately block the engine event loop */ }
        return Response.json({ blocked_ms: ms });
      }
```

- [ ] **Step 2: Write the test**

```ts
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const WORKER = new URL('../../src/worker/index.ts', import.meta.url).pathname;
const procs: Array<{ kill: () => void }> = []; const dirs: string[] = [];
afterAll(() => { for (const p of procs) try { p.kill(); } catch {} for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch {} });

async function freePort(): Promise<number> { const s = Bun.serve({ port: 0, fetch: () => new Response('') }); const p = s.port; s.stop(true); return p; }
async function waitHealthy(base: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(`${base}/health`)).ok) return; } catch {} await Bun.sleep(150); }
  throw new Error('never healthy');
}

test('threaded worker: /health stays fast while the engine is blocked 5s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-thr-')); dirs.push(dir);
  mkdirSync(join(dir, 'mem'), { recursive: true });
  writeFileSync(join(dir, 'mem', 'n.md'), '# note\n\nhello threaded world\n');
  const port = await freePort();
  const proc = Bun.spawn(['bun', WORKER], {
    env: { ...process.env, CAPTAIN_MEMO_WORKER_THREADED: '1', CAPTAIN_MEMO_ENABLE_TEST_ENDPOINTS: '1',
      CAPTAIN_MEMO_SKIP_EMBED: '1', CAPTAIN_MEMO_SUMMARIZER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '',
      CAPTAIN_MEMO_DATA_DIR: dir, CAPTAIN_MEMO_WORKER_PORT: String(port), CAPTAIN_MEMO_WATCH_MEMORY: join(dir, 'mem', '*.md') },
    stdout: 'ignore', stderr: 'ignore',
  });
  procs.push(proc);
  const base = `http://localhost:${port}`;
  await waitHealthy(base);

  // Block the ENGINE for 5s (don't await), then hammer /health on MAIN.
  void fetch(`${base}/test/block?ms=5000`).catch(() => {});
  await Bun.sleep(200);
  let maxMs = 0;
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    const r = await fetch(`${base}/health`);
    maxMs = Math.max(maxMs, performance.now() - t0);
    await r.text();
    await Bun.sleep(200);
  }
  // The whole point: main never blocked, even with the engine pinned for 5s.
  expect(maxMs).toBeLessThan(100);

  // And a real request works again once the engine frees up.
  await Bun.sleep(5000);
  const s = await (await fetch(`${base}/search/all`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'hello', top_k: 3 }) })).json();
  expect(Array.isArray(s.results)).toBe(true);
}, 40_000);
```

- [ ] **Step 3: Run it**

Run: `CAPTAIN_MEMO_ENABLE_TEST_ENDPOINTS=1 bun test tests/integration/worker-threaded.test.ts`
Expected: PASS — `/health` max latency < 100 ms throughout the 5 s engine block (proves starvation is impossible), and search works after.

- [ ] **Step 4: Commit**

```bash
git add src/worker/index.ts tests/integration/worker-threaded.test.ts
git commit -m "test(worker): prove /health can't be starved while the engine is blocked"
```

---

## Task 12: Release prep — version, CHANGELOG, manifests, dist

**Files:**
- Modify: `package.json`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `CHANGELOG.md`, `plugin/dist/*` (rebuilt)

- [ ] **Step 1: Full green gate.** `bun run typecheck && bun test` — typecheck clean, 0 failures. Do NOT proceed otherwise.

- [ ] **Step 2: Bump version to `0.3.0`** in all three manifests: `package.json`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (keep them identical — match the prior release pattern).

- [ ] **Step 3: CHANGELOG entry** under `## [0.3.0]`: "Worker can run threaded (`CAPTAIN_MEMO_WORKER_THREADED=1`): a thin HTTP/health main thread + a dedicated engine thread, so heavy `bun:sqlite` work can no longer starve `/health` and trigger the restart-thrash that caused multi-minute outages. Default-off; cross-platform; engine-crash auto-respawn. Plus atomic worker restart + `TimeoutStopSec=10`."

- [ ] **Step 4: Rebuild the plugin bundle.** Run: `bun run build:plugin` (regenerates `plugin/dist/mcp-server.js` + `plugin/dist/captain-memo-hook.js`).

- [ ] **Step 5: Commit the release.**

```bash
git add package.json plugin/.claude-plugin/plugin.json .claude-plugin/marketplace.json CHANGELOG.md plugin/dist/
git commit -m "release: 0.3.0 — threaded worker (non-starvable /health), opt-in + atomic restart"
```

(The actual tag + push to github+gitlab + GitHub release happen after the plan executes — see the post-plan release steps.)

---

## Self-Review

**Spec coverage** (`docs/specs/2026-06-03-worker-threading-design.md` → task): topology/thin-main+engine → T6–T9; message channel → T2; request/response serde → T3; honest heartbeat `/health` → T4 + T8; SQLite-stays-on-engine → T6/T7 (single thread, by construction); engine-crash respawn + cap → T5 + T8; backpressure/deadline → T8 (`REQUEST_DEADLINE_MS`); rollout flag default-off → T9; retained `TimeoutStopSec` + atomic restart → T10; instrumentation = heartbeat stall → T7/T8; cross-platform → T1 (spike both OSes) + in-process design; headline property test → T11; regression → T6/T10 full-suite gates. No gaps.

**Placeholder scan:** none — every code step carries full source; the one relocation (T6 step 4, `buildWorkerOptionsFromEnv`) moves existing, working code by explicit anchors. **Type consistency:** `WireRequest`/`WireResponse` (T3) flow T7↔T8; `ThreadChannel.request/serve/rejectAll` (T2) used by T7/T8; `healthFromHeartbeat` (T4) called in T8; `onEngineCrash`/`SupervisorState` (T5) used in T8; `WorkerOptions.noServe` + `WorkerHandle.handler` (T6) consumed by T7. Consistent.

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-06-03-worker-threading.md`. All work on `master`, published as a new public version after the suite is green and the property test passes; `CAPTAIN_MEMO_WORKER_THREADED` ships **default-off** and is then enabled + observed on this Linux captain.

Two execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, spec + quality review per task, the Task 11 property test as the hard gate.
2. **Inline Execution** — executing-plans, batched with checkpoints.

Which approach?
