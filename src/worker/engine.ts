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
