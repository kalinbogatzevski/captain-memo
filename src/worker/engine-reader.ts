// src/worker/engine-reader.ts — READER thread entry, loaded as a Bun Worker by threaded-main.ts.
// Runs startWorker({readOnly:true, noServe:true}) — corpus stores opened read-only, NO writes,
// NO background ticks — and serves the read handler over the thread channel. Retrieval bumps are
// forwarded to the main thread (which relays them to the single writer).
import { ThreadChannel } from './thread-channel.ts';
import { deserializeRequest, serializeResponse, type WireRequest } from './request-serde.ts';
import { buildWorkerOptionsFromEnv, startWorker } from './index.ts';
import type { RetrievalSource } from '../shared/types.ts';

declare const self: Worker;

async function boot(): Promise<void> {
  const base = await buildWorkerOptionsFromEnv();
  const handle = await startWorker({
    ...base,
    noServe: true,
    readOnly: true,
    onRetrievalBump: (ids: number[], source: RetrievalSource) => {
      try { postMessage({ kind: 'bump', ids, source }); } catch { /* ignore */ }
    },
  });
  const handler = handle.handler!;
  const channel = new ThreadChannel({
    post: (m) => postMessage(m),
    onMessage: (cb) => { self.onmessage = (e: MessageEvent) => cb(e.data); },
  });
  channel.serve(async (data) => {
    const wire = data as WireRequest;
    const res = await handler(deserializeRequest(wire));
    return await serializeResponse(res);
  });
  postMessage({ kind: 'ready' });
}

boot().catch((err) => {
  try { postMessage({ kind: 'fatal', message: (err as Error).message }); } catch { /* ignore */ }
  throw err;   // surfaces as the Worker 'error' event → main respawns the reader
});
