// src/worker/threaded-main.ts — MAIN thread of the threaded worker. Spawns the engine Worker,
// runs a thin Bun.serve that answers GET /health LOCALLY from the engine heartbeat and proxies
// everything else to the engine. Respawns the engine in-process on crash. No bun:sqlite here.
//
// Safety net: if the engine can NEVER be brought up — the Worker constructor throws, or it
// crash-loops to the supervisor give-up cap, or it wedges and never posts a first heartbeat —
// the threaded path falls back to the normal in-process single-threaded worker. That keeps the
// CAPTAIN_MEMO_WORKER_THREADED flag always safe: it never leaves a dead, never-listening process.
import { ThreadChannel } from './thread-channel.ts';
import { serializeRequest, deserializeResponse, type WireResponse } from './request-serde.ts';
import { healthFromHeartbeat } from './health-heartbeat.ts';
import { onEngineCrash, type SupervisorState } from './engine-supervisor.ts';
import { classifyRoute } from './route-class.ts';
import { ReaderPool } from './reader-pool.ts';
import { startWorker, buildWorkerOptionsFromEnv, type WorkerHandle } from './index.ts';

// Pass the URL OBJECT, not its .href string: on Windows a "file:///C:/…/engine.ts" string is
// not reliably resolved by `new Worker(string)` across bun versions, whereas the URL object is
// the documented, portable form. (A bad URL here is still non-fatal — it surfaces as a Worker
// spawn/error event, trips the crash supervisor, and triggers the single-threaded fallback.)
const ENGINE_URL = new URL('./engine.ts', import.meta.url);
// Reader engines are read-only (startWorker({readOnly:true,noServe:true})). They serve the read
// routes off the writer's heartbeat path entirely — see route-class.ts for the read/write split.
const READER_URL = new URL('./engine-reader.ts', import.meta.url);
const REQUEST_DEADLINE_MS = Number(process.env.CAPTAIN_MEMO_ENGINE_REQUEST_MS ?? 10_000);
// How long to wait for the engine's first heartbeat before declaring the threaded path dead and
// falling back to single-threaded. Generous on purpose: a healthy engine beats well under a
// second, so this only fires for an engine that wedges without ever crashing AND never beating.
const ENGINE_STARTUP_GRACE_MS = Number(process.env.CAPTAIN_MEMO_ENGINE_STARTUP_MS ?? 15_000);
// Reader pool size: integer, default 2, clamped to [0,8]. N=0 disables the pool entirely —
// every request (reads included) routes to the writer, i.e. today's single-engine behavior.
const POOL_SIZE = Math.max(0, Math.min(8, Number(process.env.CAPTAIN_MEMO_READER_POOL_SIZE ?? 2)));
// A saturated pool means every reader is at its in-flight cap. We WAIT for a reader to free up
// rather than spilling the read onto the writer — spilling a slow read to the writer is exactly
// the heartbeat-stall this split exists to prevent. The wait is bounded just under the request
// deadline so the request still returns (as a thread_rpc_timeout) rather than hanging forever; a
// read only ever spills to the writer when the pool is genuinely EMPTY (every reader has died).
const READER_ACQUIRE_WAIT_MS = Number(
  process.env.CAPTAIN_MEMO_READER_ACQUIRE_MS ?? Math.max(1_000, REQUEST_DEADLINE_MS - 500),
);
const READER_ACQUIRE_POLL_MS = 5;

export async function startThreadedWorker(port: number): Promise<WorkerHandle> {
  const hb = { lastBeatMs: 0, busyOp: null as string | null };   // 0 = no beat yet → /health honest
  const sup: SupervisorState = { crashes: [] };
  let engine: Worker | null = null;
  let channel: ThreadChannel | null = null;
  let stopped = false;

  // ── Reader pool ──────────────────────────────────────────────────────────
  // Reads (per route-class.ts) are served by N read-only reader engines, NOT the writer, so a
  // slow KNN scan can never stall the writer's heartbeat. Each reader gets a numeric token used
  // as the ReaderPool key; the maps resolve a token back to its channel/worker. The writer's
  // beat/health path is entirely independent of these — a busy reader never touches /health.
  const pool = new ReaderPool<number>(1);          // 1 in-flight per reader: one KNN scan at a time
  const readerChannels = new Map<number, ThreadChannel>();
  const readerWorkers = new Map<number, Worker>();
  let nextReaderToken = 0;
  // Readers that have been spawned and are not (yet) confirmed dead — i.e. booting OR ready. A read
  // waits for one of these to become pickable instead of spilling to the writer; it only spills when
  // this hits 0 (every reader has permanently given up). This is what makes cold-start deterministic:
  // a read issued right after boot waits the sub-second it takes a reader to post {kind:'ready'}.
  let liveReaders = 0;
  let everBeat = false;     // has the engine EVER posted a heartbeat? gates the fallback decision.
  let gaveUp = false;       // engine could not be started at all (spawn threw / crash-looped pre-beat)
  let wake: (() => void) | null = null;   // resolves the one-shot startup race below

  const onBeat = (ts: number, busyOp: string | null) => {
    hb.lastBeatMs = ts; hb.busyOp = busyOp;
    if (!everBeat) { everBeat = true; wake?.(); }
  };

  const handleEngineDeath = () => {
    if (stopped) return;
    channel?.rejectAll('engine_restarting');
    try { engine?.terminate(); } catch { /* ignore */ }
    engine = null; channel = null;
    if (onEngineCrash(sup, Date.now()).action === 'respawn') {
      hb.lastBeatMs = 0;                       // force /health degraded until the new engine beats
      spawnEngine();
    } else {
      // Give up: too many crashes inside the window. Before the first successful beat this means
      // the engine is fundamentally broken on this host → trip the fallback (wake the startup
      // race). After we've already gone healthy + bound the thin server, leave engine null →
      // /health reports degraded → the OS supervisor is the last resort (unchanged behavior).
      console.error('[worker] threaded engine gave up after repeated crashes within the window');
      gaveUp = true; wake?.();
    }
  };

  function spawnEngine(): void {
    let w: Worker;
    try {
      w = new Worker(ENGINE_URL);
    } catch (err) {
      console.error('[worker] threaded engine spawn failed:', (err as Error).message);
      gaveUp = true; wake?.();
      return;
    }
    const ch = new ThreadChannel({
      post: (m) => w.postMessage(m),
      onMessage: (cb) => {
        w.onmessage = (e: MessageEvent) => {
          const m = e.data as { kind?: string; ts?: number; busy_op?: string | null; message?: string };
          if (m && m.kind === 'beat') { onBeat(m.ts ?? Date.now(), m.busy_op ?? null); return; }
          if (m && m.kind === 'ready') return;                       // lifecycle, not RPC traffic
          if (m && m.kind === 'fatal') {                             // engine boot/uncaught error — make it VISIBLE
            console.error('[worker] threaded engine fatal:', m.message ?? '(no message)');
            return;
          }
          cb(e.data);
        };
      },
    }, REQUEST_DEADLINE_MS);
    w.onerror = (ev: ErrorEvent) => {
      // Surface the engine error instead of swallowing it — this is the signal that used to be
      // invisible (the test ran with stderr 'ignore', so a dead engine looked like "never healthy").
      console.error('[worker] threaded engine error:', ev?.message ?? '(no message)', ev?.error ?? '');
      handleEngineDeath();
    };
    engine = w; channel = ch;
  }

  // Spawn one reader engine under a freshly-allocated token. A reader announces readiness with
  // {kind:'ready'} (→ pool.add, becomes pickable), forwards retrieval {kind:'bump'} messages which
  // we relay to the writer, and dies via onerror (→ remove + bounded respawn). Readers post NO
  // heartbeat — they are invisible to /health by design (invariant 1). A reader that keeps crashing
  // burns its per-reader supervisor budget and is then left dead; the pool simply runs smaller.
  // `inheritedSup` carries a crashing reader's crash history forward across respawns: every respawn
  // gets a NEW token, so without this the supervisor cap (5 crashes/60s) would reset each time and a
  // permanently-broken reader would fork-bomb. Reuse the prior SupervisorState to honor the budget.
  function spawnReader(inheritedSup?: SupervisorState): void {
    if (stopped) return;
    const token = nextReaderToken++;
    const supState = inheritedSup ?? { crashes: [] };
    let w: Worker;
    try {
      w = new Worker(READER_URL);
    } catch (err) {
      // A reader that can't even be constructed is non-fatal: the writer still serves reads as the
      // cold-start fallback. Don't respawn a spawn that threw synchronously (likely a permanent
      // config/URL fault) — that would be the fork-bomb the supervisor exists to prevent.
      console.warn('[worker] threaded reader spawn failed:', (err as Error).message);
      return;
    }
    liveReaders++;                                          // booting now; counts toward "wait, don't spill"
    const removeReader = (): void => {
      pool.remove(token);
      readerChannels.delete(token);
      readerWorkers.delete(token);
      try { w.terminate(); } catch { /* ignore */ }
    };
    const onReaderDeath = (): void => {
      if (stopped) return;
      if (!readerWorkers.has(token)) return;             // already handled (double onerror)
      readerChannels.get(token)?.rejectAll('reader_restarting');
      removeReader();
      liveReaders--;                                      // this reader is down; spawnReader re-bumps on respawn
      if (onEngineCrash(supState, Date.now()).action === 'respawn') {
        spawnReader(supState);                            // fresh token, SAME crash budget (honors the cap)
      } else {
        console.warn(`[worker] threaded reader ${token} gave up after repeated crashes — running with fewer readers`);
      }
    };
    const ch = new ThreadChannel({
      post: (m) => w.postMessage(m),
      onMessage: (cb) => {
        w.onmessage = (e: MessageEvent) => {
          const m = e.data as { kind?: string; ids?: number[]; source?: string; message?: string };
          if (m && m.kind === 'bump') {
            // Relay the reader's retrieval bump to the single writer (the only engine that writes).
            if (Array.isArray(m.ids) && m.ids.length > 0) engine?.postMessage({ kind: 'bump', ids: m.ids, source: m.source });
            return;
          }
          if (m && m.kind === 'ready') { pool.add(token); return; }   // now pickable
          if (m && m.kind === 'fatal') {                              // boot/uncaught error — surface it; onerror respawns
            console.warn(`[worker] threaded reader ${token} fatal:`, m.message ?? '(no message)');
            return;
          }
          cb(e.data);                                                 // ordinary RPC res/err traffic
        };
      },
    }, REQUEST_DEADLINE_MS);
    w.onerror = (ev: ErrorEvent) => {
      console.warn(`[worker] threaded reader ${token} error:`, ev?.message ?? '(no message)');
      onReaderDeath();
    };
    readerWorkers.set(token, w);
    readerChannels.set(token, ch);
  }

  spawnEngine();

  // Wait for whichever comes first: the engine's first heartbeat (healthy → threaded), a terminal
  // failure (spawn threw / crash-looped to give-up), or the startup grace elapsing (wedged engine).
  await new Promise<void>((resolve) => {
    if (everBeat || gaveUp) { resolve(); return; }
    const timer = setTimeout(() => { wake?.(); }, ENGINE_STARTUP_GRACE_MS);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });

  if (!everBeat) {
    // The threaded engine never came up → fall back to the normal single-threaded worker so the
    // flag is always safe. startWorker binds the port itself. We tear down the dead engine first.
    console.error('[worker] threaded engine unavailable (no heartbeat) — falling back to the single-threaded worker');
    stopped = true;
    // engine is only ever reassigned inside the closures above, so TS over-narrows it to `null`
    // at this top-level read — re-assert the real union so the teardown typechecks.
    try { (engine as Worker | null)?.terminate(); } catch { /* ignore */ }
    const opts = await buildWorkerOptionsFromEnv();
    const handle = await startWorker(opts);
    console.log(`[worker] listening on http://localhost:${handle.port} (single-threaded fallback: threaded engine unavailable)`);
    return handle;
  }

  // Writer is healthy — bring up the reader pool BEFORE binding the HTTP server so the first
  // requests already have somewhere to land. N=0 spawns none (everything routes to the writer).
  for (let i = 0; i < POOL_SIZE; i++) spawnReader();

  // Acquire a reader for one read, waiting through both cold-start (readers still booting) and
  // saturation (every reader at its in-flight cap). Returns a reader token (the caller MUST release
  // it), or one of two distinct non-token outcomes the caller handles DIFFERENTLY:
  //   'empty'     — no reader exists at all (cold-start before the first 'ready', or every reader
  //                 permanently died). The writer is the ONLY engine that can serve the read, so the
  //                 caller spills to it. This is the sole case where a read runs on the writer.
  //   'saturated' — readers DO exist but all are at capacity and the wait window elapsed. The caller
  //                 returns 503 and does NOT spill: a saturated read on the writer is the heartbeat
  //                 stall this split exists to prevent (spec §4 — the heartbeat is sacred).
  async function acquireReader(): Promise<number | 'empty' | 'saturated'> {
    const deadline = Date.now() + READER_ACQUIRE_WAIT_MS;
    for (;;) {
      const token = pool.pick();
      if (token !== null) { pool.acquire(token); return token; }
      if (liveReaders === 0) return 'empty';              // no reader exists → caller spills to the writer
      if (Date.now() >= deadline) return 'saturated';     // readers exist but all busy → caller 503s, no spill
      await Bun.sleep(READER_ACQUIRE_POLL_MS);            // a reader is booting or about to free up — wait
    }
  }

  // Forward a request to the writer engine. Used for writes, control-to-writer, /stats, AND the
  // cold-start / all-readers-down read fallbacks. Keeps the original `!channel` 503 guard.
  async function forwardToWriter(wire: import('./request-serde.ts').WireRequest): Promise<Response> {
    if (!channel) return Response.json({ error: 'engine_unavailable' }, { status: 503 });
    try {
      return deserializeResponse((await channel.request(wire)) as WireResponse);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 503 });
    }
  }

  const server = Bun.serve({
    port,
    // Loopback ONLY — the unauthenticated worker API must never be reachable off-box.
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url);
      // /health is answered LOCALLY from the WRITER heartbeat only — never proxied, never affected
      // by a busy reader (invariant 1). This is the unchanged heartbeat verdict.
      if (req.method === 'GET' && url.pathname === '/health') {
        const v = healthFromHeartbeat(hb, Date.now());
        return Response.json(
          v.healthy ? { healthy: true } : { healthy: false, degraded: v.degraded },
          { status: v.healthy ? 200 : 503 },
        );
      }

      // Serialize ONCE, then route on the classifier verdict.
      const wire = await serializeRequest(req);
      const cls = classifyRoute(req.method, url.pathname);

      // Reads go to the pool whenever it's enabled (POOL_SIZE>0). acquireReader waits through
      // cold-start and saturation, then returns a token, 'empty' (spill to the writer — no reader
      // exists), or 'saturated' (503 — readers exist but all busy; we NEVER spill a saturated read
      // onto the writer, that's the heartbeat stall this split prevents).
      if (cls === 'read' && POOL_SIZE > 0) {
        const token = await acquireReader();
        if (token === 'empty') {
          // No reader exists (cold-start before the first 'ready', or every reader permanently died):
          // the writer is the only engine that can serve the read. Logged — a read on the writer is
          // the heartbeat-stall risk, tolerated ONLY because there is literally no reader.
          console.warn('[worker] no reader available — serving read on the writer (cold-start / all readers down)');
          return forwardToWriter(wire);
        }
        if (token === 'saturated') {
          // Every reader is busy and the wait window elapsed. We do NOT spill to the writer (that
          // would risk the heartbeat); the read degrades to 503 so the caller can retry or skip recall.
          return Response.json({ error: 'readers_saturated' }, { status: 503 });
        }
        try {
          return deserializeResponse((await readerChannels.get(token)!.request(wire)) as WireResponse);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 503 });
        } finally {
          pool.release(token);
        }
      }

      // Writes, control-to-writer, /stats, and ALL reads when the pool is disabled (N=0) → the writer.
      return forwardToWriter(wire);
    },
  });

  // Keep this exact "(threaded: …)" wording — operators (and the upgrade smoke check) grep for it.
  // Include the reader count so the boot line reflects the actual topology.
  console.log(`[worker] listening on http://localhost:${server.port ?? port} (threaded: thin HTTP main + 1 writer + ${POOL_SIZE} reader${POOL_SIZE === 1 ? '' : 's'})`);

  return {
    port: server.port ?? port,
    stop: async () => {
      stopped = true;
      server.stop(true);
      // Tear down readers first, then the writer.
      for (const [token, ch] of readerChannels) { try { ch.rejectAll('worker_stopping'); } catch { /* ignore */ } readerWorkers.get(token)?.terminate(); }
      readerChannels.clear(); readerWorkers.clear();
      channel?.rejectAll('worker_stopping');
      try { engine?.terminate(); } catch { /* ignore */ }
    },
  };
}
