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
