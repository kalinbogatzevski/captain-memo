// src/worker/engine-reader.ts — READER thread entry, loaded as a Bun Worker by threaded-main.ts.
// Runs startWorker({readOnly:true, noServe:true}) — corpus stores opened read-only, NO writes,
// NO background ticks — and serves the read routes over the op-routed thread channel. Retrieval
// bumps are forwarded to main (which relays them to the writer).
//
// The reader posts NO heartbeat — the writer is the single liveness source for /health (invariant:
// a busy reader must never look like an unhealthy worker). It only posts {kind:'ready'}, {kind:'bump'}
// and {kind:'embed_usage'} side-messages; everything else is op-routed req/res over the channel.
import { ThreadChannel } from './thread-channel.ts';
import { deserializeRequest, serializeResponse, type WireRequest } from './request-serde.ts';
import { buildWorkerOptionsFromEnv, startWorker } from './index.ts';
import { makeUsageReporter } from './embedder.ts';
import { loadWorkerEnv } from '../shared/worker-env.ts';
import type { RetrievalSource } from '../shared/types.ts';

declare const self: Worker;

/** How often a reader looks at its embedder's counters; it posts to main only when they changed, so also the most
 *  often it posts. The query embeds a reader sends are in no other engine's /stats, so main adds the latest
 *  snapshot of each reader to the writer's. Measured 2026-10-08 (Bun, this box): usage() 12 µs, usage() plus the
 *  change check 16 µs, one postMessage of the 323-byte snapshot 12 µs on the sending side, so a reader that is
 *  never asked anything pays 16 µs per 5 s (0.0003 % of a core) and, after the one post its boot probe causes, posts nothing; one embedding all the time
 *  posts 12 µs per 5 s. On main, mergeEmbedUsage over 2 readers (the default pool) is 10 µs, over 8 (the most) 25 µs,
 *  paid once per /stats. Counters 5 s old are fine for a total read by a human. */
const EMBED_USAGE_TICK_MS = 5_000;

async function boot(): Promise<void> {
  // A Bun Worker does NOT inherit the main thread's runtime-mutated process.env, and on Windows
  // (Scheduled Task, no systemd EnvironmentFile) worker.env reaches the process ONLY via
  // loadWorkerEnv(). Seed it here BEFORE building options — otherwise the reader falls back to
  // defaults (voyage-4-nano@localhost, …).
  loadWorkerEnv();
  // Inbound 'http' serves are unbounded by this timeout (they are handled, not requested), so a
  // long local KNN scan is not cut off here.
  const channel = new ThreadChannel({
    post: (m) => postMessage(m),
    onMessage: (cb) => { self.onmessage = (e: MessageEvent) => cb(e.data); },
  }, 1500);

  const base = await buildWorkerOptionsFromEnv();
  const handle = await startWorker({
    ...base,
    noServe: true,
    readOnly: true,
    // Read-only: bumps can't be written here. Forward to main, which relays to the single writer.
    onRetrievalBump: (ids: number[], source: RetrievalSource) => {
      try { postMessage({ kind: 'bump', ids, source }); } catch { /* ignore */ }
    },
  });
  // startWorker(noServe:true) always populates the handler. Guard so a regression surfaces as one fatal.
  const { handler, embedUsage } = handle;
  if (!handler || !embedUsage) throw new Error('startWorker(readOnly,noServe) returned incomplete handle');

  // This reader's own embedder counters → main, which adds them to the writer's in /stats (see EMBED_USAGE_TICK_MS).
  const reporter = makeUsageReporter(embedUsage, (usage) => {
    try { postMessage({ kind: 'embed_usage', usage }); } catch { /* ignore */ }
  });
  (setInterval(reporter.tick, EMBED_USAGE_TICK_MS) as unknown as { unref?: () => void }).unref?.();

  // Inbound HTTP proxy (the read routes main classifies to the pool).
  channel.serve('http', async (data) => {
    const wire = data as WireRequest;
    const res = await handler(deserializeRequest(wire));
    return await serializeResponse(res);
  });

  postMessage({ kind: 'ready' });   // now pickable by the pool. NO heartbeat (writer owns liveness).
}

boot().catch((err) => {
  try { postMessage({ kind: 'fatal', message: (err as Error).message }); } catch { /* ignore */ }
  throw err;   // surfaces as the Worker 'error' event → main respawns the reader
});
