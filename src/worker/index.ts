import { join } from 'path';
import { z } from 'zod';
import { MetaStore } from './meta.ts';
import { VoyageEmbedder } from './embedder.ts';
import { VectorStore } from './vector-store.ts';
import { HybridSearcher } from './search.ts';
import { IngestPipeline } from './ingest.ts';
import { FileWatcher } from './watcher.ts';
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
  skipEmbed?: boolean;
  watchPaths?: string[];
  watchChannel?: 'memory' | 'skill';
}

export interface WorkerHandle {
  port: number;
  stop: () => Promise<void>;
}

const SearchRequestSchema = z.object({
  query: z.string(),
  top_k: z.number().int().positive().max(50).default(5),
  channels: z.array(z.enum(['memory', 'skill', 'observation', 'remote'])).optional(),
});

const MemorySearchSchema = z.object({
  query: z.string(),
  type: z.enum(['user', 'feedback', 'project', 'reference']).optional(),
  project: z.string().optional(),
  top_k: z.number().int().positive().max(50).default(5),
});

const SkillSearchSchema = z.object({
  query: z.string(),
  skill_id: z.string().optional(),
  top_k: z.number().int().positive().max(50).default(3),
});

const ObservationSearchSchema = z.object({
  query: z.string(),
  type: z.enum(['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change']).optional(),
  files: z.array(z.string()).optional(),
  since: z.string().optional(),
  project: z.string().optional(),
  top_k: z.number().int().positive().max(50).default(5),
});

const GetFullSchema = z.object({ doc_id: z.string() });
const ReindexSchema = z.object({
  channel: z.enum(['memory', 'skill', 'observation', 'all']).default('all'),
  force: z.boolean().default(false),
});

export async function startWorker(opts: WorkerOptions): Promise<WorkerHandle> {
  const meta = new MetaStore(opts.metaDbPath);
  const embedder = new VoyageEmbedder({
    endpoint: opts.embedderEndpoint,
    model: opts.embedderModel,
    ...(opts.embedderApiKey !== undefined && { apiKey: opts.embedderApiKey }),
  });
  const vector = new VectorStore({
    dbPath: opts.vectorDbPath,
    dimension: opts.embeddingDimension,
  });

  const collectionName = `am_${opts.projectId}`;
  await vector.ensureCollection(collectionName);

  const searcher = new HybridSearcher({
    vectorSearch: async (embedding, topK) => {
      if (opts.skipEmbed || embedding.length === 0) return [];
      const results = await vector.query(collectionName, embedding, topK);
      return results.map(r => ({ id: r.id, distance: r.distance }));
    },
    keywordSearch: async (query, topK) => meta.searchKeyword(query, topK),
  });

  const ingest = new IngestPipeline({
    meta,
    embedder: {
      embed: async (texts) => {
        if (opts.skipEmbed) {
          return texts.map(() => new Array(opts.embeddingDimension).fill(0));
        }
        try {
          return await embedder.embed(texts);
        } catch {
          // Embed failure → return zero-vectors so chunks still land in the vector table
          // (keyword search still works; vector half degrades gracefully).
          return texts.map(() => new Array(opts.embeddingDimension).fill(0));
        }
      },
    },
    vector,
    collectionName,
    projectId: opts.projectId,
  });

  const expandWatchPaths = async (patterns: string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const pattern of patterns) {
      const glob = new Bun.Glob(pattern);
      for await (const file of glob.scan({ absolute: true, onlyFiles: true })) {
        out.push(file);
      }
    }
    return out;
  };

  let watcher: FileWatcher | null = null;
  if (opts.watchPaths && opts.watchPaths.length > 0 && opts.watchChannel) {
    const channel = opts.watchChannel;

    // Initial indexing pass
    const files = await expandWatchPaths(opts.watchPaths);
    for (const file of files) {
      try {
        await ingest.indexFile(file, channel);
      } catch (err) {
        console.error(`[ingest] ${file}: ${(err as Error).message}`);
      }
    }

    // Live watcher
    watcher = new FileWatcher({
      paths: opts.watchPaths,
      debounceMs: 500,
      onEvent: async (type, path) => {
        try {
          if (type === 'unlink') await ingest.deleteFile(path);
          else await ingest.indexFile(path, channel);
        } catch (err) {
          console.error(`[watcher] ${type} ${path}: ${(err as Error).message}`);
        }
      },
    });
    await watcher.start();
  }

  type ChannelFilters = {
    memory_type?: string;
    skill_id?: string;
    obs_type?: string;
    files?: string[];
  };

  const searchByChannel = async (
    query: string,
    channel: 'memory' | 'skill' | 'observation',
    topK: number,
    filters: ChannelFilters,
  ) => {
    let embedding: number[] = [];
    if (!opts.skipEmbed) {
      try {
        const out = await embedder.embed([query]);
        embedding = out[0] ?? [];
      } catch {
        // fall back to keyword-only on embed failure
      }
    }
    const fused = await searcher.search(embedding, query, topK * 3);
    const results: Array<{
      doc_id: string;
      source_path: string;
      title: string;
      snippet: string;
      score: number;
      channel: string;
      metadata: Record<string, unknown>;
    }> = [];
    for (const f of fused) {
      const lookup = meta.getChunkById(f.id);
      if (!lookup) continue;
      if (lookup.document.channel !== channel) continue;

      const m = lookup.chunk.metadata as Record<string, unknown>;
      if (filters.memory_type !== undefined && m.memory_type !== filters.memory_type) continue;
      if (filters.skill_id !== undefined && m.skill_id !== filters.skill_id) continue;
      if (filters.obs_type !== undefined && m.type !== filters.obs_type) continue;
      if (filters.files !== undefined && filters.files.length > 0) {
        const filesList = (m.files_modified ?? m.files_read ?? []) as string[];
        const hasMatch = filters.files.some(file => filesList.includes(file));
        if (!hasMatch) continue;
      }

      results.push({
        doc_id: lookup.chunk.chunk_id,
        source_path: lookup.document.source_path,
        title: (m.section_title ?? m.filename_id ?? m.title ?? 'Untitled') as string,
        snippet: lookup.chunk.text.slice(0, 600),
        score: f.score,
        channel: lookup.document.channel,
        metadata: m,
      });
      if (results.length >= topK) break;
    }
    return results;
  };

  const handler = async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ healthy: true });
      }
      if (req.method === 'GET' && url.pathname === '/stats') {
        const { total_chunks, by_channel } = meta.stats();
        return Response.json({
          total_chunks,
          by_channel,
          project_id: opts.projectId,
          embedder: { model: opts.embedderModel, endpoint: opts.embedderEndpoint },
        });
      }
      if (req.method === 'POST' && url.pathname === '/search/all') {
        const parsed = SearchRequestSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json(
            { error: 'invalid_request', details: parsed.error.format() },
            { status: 400 }
          );
        }
        const { query, top_k } = parsed.data;
        let embedding: number[] = [];
        if (!opts.skipEmbed) {
          try {
            const out = await embedder.embed([query]);
            embedding = out[0] ?? [];
          } catch {
            // Fall back to keyword-only on embed failure (logged by embedder itself)
          }
        }
        const fused = await searcher.search(embedding, query, top_k);
        const results = fused.map(f => {
          const lookup = meta.getChunkById(f.id);
          if (!lookup) return null;
          const { chunk, document } = lookup;
          const titleMeta = chunk.metadata as Record<string, unknown>;
          return {
            doc_id: chunk.chunk_id,
            source_path: document.source_path,
            title: (titleMeta.section_title ?? titleMeta.filename_id ?? titleMeta.title ?? 'Untitled') as string,
            snippet: chunk.text.slice(0, 600),
            score: f.score,
            channel: document.channel,
            metadata: chunk.metadata,
          };
        }).filter((r): r is NonNullable<typeof r> => r !== null);

        const by_channel: Record<string, number> = {};
        for (const r of results) by_channel[r.channel] = (by_channel[r.channel] ?? 0) + 1;
        return Response.json({ results, by_channel });
      }
      if (req.method === 'POST' && url.pathname === '/search/memory') {
        const parsed = MemorySearchSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const filters: ChannelFilters = {};
        if (parsed.data.type !== undefined) filters.memory_type = parsed.data.type;
        const results = await searchByChannel(parsed.data.query, 'memory', parsed.data.top_k, filters);
        return Response.json({ results });
      }

      if (req.method === 'POST' && url.pathname === '/search/skill') {
        const parsed = SkillSearchSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const filters: ChannelFilters = {};
        if (parsed.data.skill_id !== undefined) filters.skill_id = parsed.data.skill_id;
        const results = await searchByChannel(parsed.data.query, 'skill', parsed.data.top_k, filters);
        return Response.json({ results });
      }

      if (req.method === 'POST' && url.pathname === '/search/observations') {
        const parsed = ObservationSearchSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const filters: ChannelFilters = {};
        if (parsed.data.type !== undefined) filters.obs_type = parsed.data.type;
        if (parsed.data.files !== undefined) filters.files = parsed.data.files;
        const results = await searchByChannel(parsed.data.query, 'observation', parsed.data.top_k, filters);
        return Response.json({ results });
      }

      if (req.method === 'POST' && url.pathname === '/get_full') {
        const parsed = GetFullSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const result = meta.getChunkById(parsed.data.doc_id);
        if (!result) {
          return Response.json({ error: 'not_found' }, { status: 404 });
        }
        return Response.json({
          content: result.chunk.text,
          metadata: {
            ...result.chunk.metadata,
            ...result.document.metadata,
            source_path: result.document.source_path,
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/reindex') {
        const parsed = ReindexSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }

        let indexed = 0;
        let skipped = 0;
        let errors = 0;

        if (opts.watchPaths && opts.watchPaths.length > 0 && opts.watchChannel) {
          const channelMatch =
            parsed.data.channel === 'all' || parsed.data.channel === opts.watchChannel;
          if (channelMatch) {
            const files = await expandWatchPaths(opts.watchPaths);
            for (const file of files) {
              try {
                if (parsed.data.force) {
                  const existing = meta.getDocument(file);
                  if (existing) meta.deleteDocument(file);
                }
                const before = meta.getDocument(file);
                await ingest.indexFile(file, opts.watchChannel);
                const after = meta.getDocument(file);
                if (after && (!before || before.sha !== after.sha)) indexed++;
                else skipped++;
              } catch {
                errors++;
              }
            }
          }
        }

        return Response.json({ indexed, skipped, errors });
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
      if (watcher) await watcher.close();
      server.stop();
      vector.close();
      meta.close();
    },
  };
}

if (import.meta.main) {
  const port = Number(process.env.AELITA_MCP_WORKER_PORT ?? DEFAULT_WORKER_PORT);
  const projectId = process.env.AELITA_MCP_PROJECT_ID ?? 'default';
  const embedderEndpoint = process.env.AELITA_MCP_VOYAGE_ENDPOINT ?? DEFAULT_VOYAGE_ENDPOINT;
  const embedderModel = process.env.AELITA_MCP_VOYAGE_MODEL ?? 'voyage-4-nano';
  const embedderApiKey = process.env.AELITA_MCP_VOYAGE_API_KEY;
  const vectorDbPath = join(VECTOR_DB_DIR, 'embeddings.db');

  const watchMemory = process.env.AELITA_MCP_WATCH_MEMORY;
  const watchSkills = process.env.AELITA_MCP_WATCH_SKILLS;

  let watchPaths: string[] | undefined;
  let watchChannel: 'memory' | 'skill' | undefined;
  if (watchMemory) {
    watchPaths = watchMemory.split(',').map(s => s.trim()).filter(Boolean);
    watchChannel = 'memory';
    if (watchSkills) {
      console.error(
        '[worker] both AELITA_MCP_WATCH_MEMORY and AELITA_MCP_WATCH_SKILLS set; ' +
        'Plan-1 supports one channel per worker — using memory'
      );
    }
  } else if (watchSkills) {
    watchPaths = watchSkills.split(',').map(s => s.trim()).filter(Boolean);
    watchChannel = 'skill';
  }

  const handle = await startWorker({
    port,
    projectId,
    metaDbPath: META_DB_PATH,
    embedderEndpoint,
    embedderModel,
    ...(embedderApiKey !== undefined && { embedderApiKey }),
    vectorDbPath,
    embeddingDimension: 1024,
    ...(watchPaths !== undefined && watchChannel !== undefined && { watchPaths, watchChannel }),
  });
  console.log(`[worker] listening on http://localhost:${handle.port}`);

  const shutdown = async () => {
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
