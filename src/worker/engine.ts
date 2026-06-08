// src/worker/engine.ts — WRITER thread entry, loaded as a Bun Worker by threaded-main.ts.
// Runs the FULL worker via startWorker({noServe:true}) — writes, observation ticks, watcher —
// so all bun:sqlite write handles live here. It serves op 'http' (main routes writes/stats/
// control here), applies retrieval bumps forwarded from the readers, and posts a heartbeat so
// main's /health stays honest (the writer is the single liveness source).
import { ThreadChannel } from './thread-channel.ts';
import { deserializeRequest, serializeResponse, type WireRequest } from './request-serde.ts';
import { buildWorkerOptionsFromEnv, startWorker } from './index.ts';
import { loadWorkerEnv } from '../shared/worker-env.ts';

declare const self: Worker;

async function boot(): Promise<void> {
  // A Bun Worker does NOT inherit the main thread's runtime-mutated process.env, and on Windows
  // (Scheduled Task, no systemd EnvironmentFile) worker.env reaches the process ONLY via
  // loadWorkerEnv(). Seed it here so buildWorkerOptionsFromEnv sees the real embedder / summarizer /
  // dimension config instead of the defaults (voyage-4-nano@localhost, …).
  loadWorkerEnv();
  const handle = await startWorker({ ...(await buildWorkerOptionsFromEnv()), noServe: true });
  const store = handle.store;
  let busyOp: string | null = null;

  const channel = new ThreadChannel({
    post: (m) => postMessage(m),
    onMessage: (cb) => {
      self.onmessage = (e: MessageEvent) => {
        const m = e.data as { kind?: string; ids?: number[]; source?: string };
        // Forwarded retrieval bump (reader → main → writer). Intercept BEFORE the channel — it is a
        // side-message, not an op-routed req/res frame. Validate the source against the known set
        // rather than casting: a malformed value would otherwise build `SET undefined = undefined + 1`
        // and throw (then get swallowed). The reader→main→writer relay only ever sends a valid source.
        if (m && m.kind === 'bump' && Array.isArray(m.ids) && store) {
          if (m.source === 'auto' || m.source === 'search' || m.source === 'drill') {
            try { store.bumpRetrieval(m.ids, m.source); } catch (err) { console.error('[retrieval-tracking] writer bump failed:', (err as Error).message); }
          }
          return;
        }
        cb(e.data);
      };
    },
  });

  // startWorker(noServe:true) always populates the handler; guard so a future regression surfaces as
  // one descriptive fatal (forwarded to main by boot().catch) instead of a silent TypeError later.
  const { handler } = handle;
  if (!handler) throw new Error('startWorker(noServe) returned incomplete handle');

  // Inbound HTTP proxy (writes / stats / control — every route main classifies to the writer).
  channel.serve('http', async (data) => {
    const wire = data as WireRequest;
    try { busyOp = new URL(wire.url).pathname; } catch { busyOp = '?'; }
    try {
      const res = await handler(deserializeRequest(wire));
      return await serializeResponse(res);
    } finally { busyOp = null; }
  });

  const beat = () => { try { postMessage({ kind: 'beat', ts: Date.now(), busy_op: busyOp }); } catch { /* ignore */ } };
  beat();
  setInterval(beat, 1000);
  postMessage({ kind: 'ready' });
}

boot().catch((err) => {
  try { postMessage({ kind: 'fatal', message: (err as Error).message }); } catch { /* ignore */ }
  throw err;   // surfaces as the Worker 'error' event -> main respawns
});
