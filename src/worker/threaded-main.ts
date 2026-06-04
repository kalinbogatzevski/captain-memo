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
import { startWorker, buildWorkerOptionsFromEnv, type WorkerHandle } from './index.ts';

// Pass the URL OBJECT, not its .href string: on Windows a "file:///C:/…/engine.ts" string is
// not reliably resolved by `new Worker(string)` across bun versions, whereas the URL object is
// the documented, portable form. (A bad URL here is still non-fatal — it surfaces as a Worker
// spawn/error event, trips the crash supervisor, and triggers the single-threaded fallback.)
const ENGINE_URL = new URL('./engine.ts', import.meta.url);
const REQUEST_DEADLINE_MS = Number(process.env.CAPTAIN_MEMO_ENGINE_REQUEST_MS ?? 10_000);
// How long to wait for the engine's first heartbeat before declaring the threaded path dead and
// falling back to single-threaded. Generous on purpose: a healthy engine beats well under a
// second, so this only fires for an engine that wedges without ever crashing AND never beating.
const ENGINE_STARTUP_GRACE_MS = Number(process.env.CAPTAIN_MEMO_ENGINE_STARTUP_MS ?? 15_000);

export async function startThreadedWorker(port: number): Promise<WorkerHandle> {
  const hb = { lastBeatMs: 0, busyOp: null as string | null };   // 0 = no beat yet → /health honest
  const sup: SupervisorState = { crashes: [] };
  let engine: Worker | null = null;
  let channel: ThreadChannel | null = null;
  let stopped = false;
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

  // Keep this exact "(threaded: …)" wording — operators (and the upgrade smoke check) grep for it.
  console.log(`[worker] listening on http://localhost:${server.port ?? port} (threaded: thin HTTP main + engine thread)`);

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
