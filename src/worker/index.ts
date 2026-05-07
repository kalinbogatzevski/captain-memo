import { join } from 'path';
import { MetaStore } from './meta.ts';
import { VoyageEmbedder } from './embedder.ts';
import { VectorStore } from './vector-store.ts';
import {
  META_DB_PATH,
  VECTOR_DB_DIR,
  DEFAULT_WORKER_PORT,
  DEFAULT_VOYAGE_ENDPOINT,
} from '../shared/paths.ts';

export interface WorkerOptions {
  port: number;
  projectId: string;
  metaDbPath: string;
  embedderEndpoint: string;
  embedderModel: string;
  embedderApiKey?: string;
  vectorDbPath: string;
  embeddingDimension: number;
}

export interface WorkerHandle {
  port: number;
  stop: () => Promise<void>;
}

export async function startWorker(opts: WorkerOptions): Promise<WorkerHandle> {
  const meta = new MetaStore(opts.metaDbPath);
  const _embedder = new VoyageEmbedder({
    endpoint: opts.embedderEndpoint,
    model: opts.embedderModel,
    ...(opts.embedderApiKey !== undefined && { apiKey: opts.embedderApiKey }),
  });
  const vector = new VectorStore({
    dbPath: opts.vectorDbPath,
    dimension: opts.embeddingDimension,
  });

  // Reference to silence unused-locals: embedder will be wired into ingest/search
  // pipelines in Tasks 20-25. For now we only need it constructed so config errors
  // surface at boot time.
  void _embedder;

  const handler = async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ healthy: true });
      }
      if (req.method === 'GET' && url.pathname === '/stats') {
        // Stub — real corpus stats land in Task 26.
        return Response.json({
          total_chunks: 0,
          by_channel: {},
          project_id: opts.projectId,
        });
      }
      return new Response('Not Found', { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  };

  const server = Bun.serve({
    port: opts.port,
    fetch: handler,
  });

  return {
    port: server.port ?? opts.port,
    stop: async () => {
      server.stop();
      vector.close();
      meta.close();
    },
  };
}

if (import.meta.main) {
  const port = Number(process.env.AELITA_WORKER_PORT ?? DEFAULT_WORKER_PORT);
  const projectId = process.env.AELITA_PROJECT_ID ?? 'default';
  const embedderEndpoint = process.env.VOYAGE_ENDPOINT ?? DEFAULT_VOYAGE_ENDPOINT;
  const embedderModel = process.env.VOYAGE_MODEL ?? 'voyage-4-nano';
  const embedderApiKey = process.env.VOYAGE_API_KEY;
  const vectorDbPath = join(VECTOR_DB_DIR, 'embeddings.db');

  const handle = await startWorker({
    port,
    projectId,
    metaDbPath: META_DB_PATH,
    embedderEndpoint,
    embedderModel,
    ...(embedderApiKey !== undefined && { embedderApiKey }),
    vectorDbPath,
    embeddingDimension: 1024,
  });
  console.log(`[worker] listening on http://localhost:${handle.port}`);

  const shutdown = async () => {
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
