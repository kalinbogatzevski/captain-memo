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

// STALL REPORT. The writer serves every write AND runs the background timers, so a timer's synchronous stretch
// holds every request queued behind it — and nothing said which one. Each timer this thread creates is wrapped to
// note its job as it starts; a heartbeat that arrives more than STALL_LOG_MS late logs one line naming it and the
// last HTTP op. Continuations after an await carry no label of their own, so "last timer" is the likeliest culprit,
// not proof. ponytail: label = function name or source head, computed once per timer.
const STALL_LOG_MS = 1_000;
let lastTask: string | null = null;
let lastOp: string | null = null;
const rawSetInterval = globalThis.setInterval;   // the heartbeat itself must not relabel lastTask
for (const k of ['setInterval', 'setTimeout'] as const) {
  const orig = globalThis[k] as (fn: (...a: unknown[]) => unknown, ms?: number, ...args: unknown[]) => unknown;
  (globalThis as Record<string, unknown>)[k] = (fn: unknown, ms?: number, ...args: unknown[]) => {
    if (typeof fn !== 'function') return orig(fn as never, ms, ...args);
    const label = `${k}(${ms ?? 0}) ${fn.name || String(fn).replace(/\s+/g, ' ').slice(0, 90)}`;
    return orig((...a: unknown[]) => { lastTask = label; return (fn as (...x: unknown[]) => unknown)(...a); }, ms, ...args);
  };
}

async function boot(): Promise<void> {
  // A Bun Worker does NOT inherit the main thread's runtime-mutated process.env, and on Windows
  // (Scheduled Task, no systemd EnvironmentFile) worker.env reaches the process ONLY via
  // loadWorkerEnv(). Seed it here so buildWorkerOptionsFromEnv sees the real embedder / summarizer /
  // dimension config instead of the defaults (voyage-4-nano@localhost, …).
  loadWorkerEnv();
  const handle = await startWorker({ ...(await buildWorkerOptionsFromEnv()), noServe: true });
  const { bumpRetrieval } = handle;   // store bump + /stats invalidation; a bare store.bumpRetrieval left /stats stale
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
        if (m && m.kind === 'bump' && Array.isArray(m.ids) && bumpRetrieval) {
          if (m.source === 'auto' || m.source === 'search' || m.source === 'drill') {
            try { bumpRetrieval(m.ids, m.source); } catch (err) { console.error('[retrieval-tracking] writer bump failed:', (err as Error).message); }
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
    lastOp = busyOp;
    try {
      const res = await handler(deserializeRequest(wire));
      return await serializeResponse(res);
    } finally { busyOp = null; }
  });

  let lastBeat = Date.now();
  const beat = () => {
    const now = Date.now();
    const late = now - lastBeat - 1000;
    lastBeat = now;
    if (late > STALL_LOG_MS) {
      console.error(`[engine] writer blocked ~${late} ms: last timer ${lastTask ?? 'none'}; last http ${lastOp ?? 'none'}${busyOp ? ` (still in ${busyOp})` : ''}`);
    }
    try { postMessage({ kind: 'beat', ts: now, busy_op: busyOp }); } catch { /* ignore */ }
  };
  beat();
  rawSetInterval(beat, 1000);
  postMessage({ kind: 'ready' });
}

boot().catch((err) => {
  try { postMessage({ kind: 'fatal', message: (err as Error).message }); } catch { /* ignore */ }
  throw err;   // surfaces as the Worker 'error' event -> main respawns
});
