import { join } from 'path';
import { z } from 'zod';
import { MetaStore } from './meta.ts';
import { Embedder } from './embedder.ts';
import { VectorStore } from './vector-store.ts';
import { HybridSearcher } from './search.ts';
import { IngestPipeline } from './ingest.ts';
import { FileWatcher } from './watcher.ts';
import { ObservationQueue } from './observation-queue.ts';
import { ObservationsStore } from './observations-store.ts';
import { PendingEmbedQueue } from './pending-embed-queue.ts';
import { chunkObservation } from './chunkers/observation.ts';
import { newChunkId } from '../shared/id.ts';
import { sha256Hex } from '../shared/sha.ts';
import type { RawObservationEvent, ObservationType, Observation } from '../shared/types.ts';
import {
  META_DB_PATH,
  VECTOR_DB_DIR,
  DEFAULT_WORKER_PORT,
  DEFAULT_VOYAGE_ENDPOINT,
  QUEUE_DB_PATH,
  OBSERVATIONS_DB_PATH,
  PENDING_EMBED_DB_PATH,
  ENV_ANTHROPIC_API_KEY,
  ENV_SUMMARIZER_PROVIDER,
  DEFAULT_SUMMARIZER_PROVIDER,
  type SummarizerProvider,
  ENV_OPENAI_ENDPOINT,
  ENV_OPENAI_API_KEY,
  ENV_SUMMARIZER_MODEL,
  ENV_SUMMARIZER_FALLBACKS,
  DEFAULT_SUMMARIZER_MODEL,
  DEFAULT_SUMMARIZER_FALLBACKS,
  ENV_HOOK_BUDGET_TOKENS,
  DEFAULT_HOOK_BUDGET_TOKENS,
  ENV_OBSERVATION_BATCH_SIZE,
  ENV_OBSERVATION_TICK_MS,
  DEFAULT_OBSERVATION_BATCH_SIZE,
  DEFAULT_OBSERVATION_TICK_MS,
} from '../shared/paths.ts';
import { Summarizer } from './summarizer.ts';
import pkg from '../../package.json' with { type: 'json' };

export interface SummarizerResult {
  type: ObservationType;
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
}

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
  observationQueueDbPath?: string;
  observationsDbPath?: string;
  pendingEmbedDbPath?: string;
  summarize?: (events: RawObservationEvent[]) => Promise<SummarizerResult>;
  observationTickMs?: number;
  observationBatchSize?: number;
  hookBudgetTokens?: number;
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

const ObservationEnqueueSchema = z.object({
  session_id: z.string().min(1),
  project_id: z.string().min(1),
  prompt_number: z.number().int().nonnegative(),
  tool_name: z.string().min(1),
  tool_input_summary: z.string().max(2000),
  tool_result_summary: z.string().max(2000),
  files_read: z.array(z.string()).default([]),
  files_modified: z.array(z.string()).default([]),
  ts_epoch: z.number().int(),
});

const ObservationFlushSchema = z.object({
  session_id: z.string().optional(),
  max: z.number().int().positive().max(500).default(100),
});

const PendingEmbedRetrySchema = z.object({
  max: z.number().int().positive().max(500).default(50),
});

const InjectContextSchema = z.object({
  prompt: z.string(),
  top_k: z.number().int().positive().max(50).default(5),
  channels: z.array(z.enum(['memory', 'skill', 'observation'])).optional(),
  budget_tokens: z.number().int().positive().max(20_000).optional(),
});

const SHORT_PROMPT_THRESHOLD = 10;
const NO_OP_TOKENS = new Set(['ok', 'continue', 'yes', 'go', 'next', 'sure']);

export async function startWorker(opts: WorkerOptions): Promise<WorkerHandle> {
  const meta = new MetaStore(opts.metaDbPath);
  const embedder = new Embedder({
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

  // Boot-time dim probe — catch the dim-mismatch trap (where vector store
  // expects N but embedder returns M) BEFORE any chunk hits vector.add().
  // Skip when the user opted into keyword-only mode.
  if (!opts.skipEmbed) {
    try {
      const probe = await embedder.embed(['probe']);
      const actualDim = probe[0]?.length ?? 0;
      if (actualDim !== opts.embeddingDimension) {
        console.error(
          `[worker] DIM MISMATCH: VectorStore expects ${opts.embeddingDimension} but embedder returns ${actualDim}. ` +
          `Set CAPTAIN_MEMO_EMBEDDING_DIM=${actualDim} (or pick a model that returns ${opts.embeddingDimension}-dim) ` +
          `then restart the worker. Current state will fail at every vector.add() call.`,
        );
      } else {
        console.log(`[worker] embedder probe OK (dim=${actualDim})`);
      }
    } catch (err) {
      console.error(`[worker] embedder probe failed at boot:`, (err as Error).message);
      // Don't crash the worker — keyword search still works; vector half will
      // log per-call errors via the new search.ts error visibility.
    }
  }

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

  // Indexing status — exposed via /stats so users (and `captain-memo doctor`)
  // can see initial-pass progress instead of "worker not responding".
  type IndexingStatus = 'idle' | 'indexing' | 'ready' | 'error';
  const indexingState: {
    status: IndexingStatus;
    total: number;
    done: number;
    errors: number;
    started_at_epoch: number;
    finished_at_epoch: number;
    last_error: string | null;
  } = {
    status: 'idle', total: 0, done: 0, errors: 0,
    started_at_epoch: 0, finished_at_epoch: 0, last_error: null,
  };

  let watcher: FileWatcher | null = null;
  if (opts.watchPaths && opts.watchPaths.length > 0 && opts.watchChannel) {
    const channel = opts.watchChannel;
    const watchPaths = opts.watchPaths;

    // Run the initial indexing pass in the background — the HTTP server
    // starts immediately and reports progress via /stats. Watcher attaches
    // after the initial pass so we don't double-index files we just hit.
    indexingState.status = 'indexing';
    indexingState.started_at_epoch = Math.floor(Date.now() / 1000);
    void (async () => {
      try {
        const files = await expandWatchPaths(watchPaths);
        indexingState.total = files.length;
        for (const file of files) {
          try {
            await ingest.indexFile(file, channel);
            indexingState.done++;
          } catch (err) {
            indexingState.errors++;
            indexingState.last_error = (err as Error).message;
            console.error(`[ingest] ${file}: ${(err as Error).message}`);
          }
        }
        // Live watcher attaches AFTER initial indexing finishes (so chokidar's
        // own add events don't re-fire indexFile on every file we just wrote).
        watcher = new FileWatcher({
          paths: watchPaths,
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
        indexingState.status = 'ready';
        indexingState.finished_at_epoch = Math.floor(Date.now() / 1000);
        const elapsed = indexingState.finished_at_epoch - indexingState.started_at_epoch;
        console.error(`[worker] initial indexing complete: ${indexingState.done} files (${indexingState.errors} errors) in ${elapsed}s`);
      } catch (err) {
        indexingState.status = 'error';
        indexingState.last_error = (err as Error).message;
        console.error(`[worker] initial indexing failed: ${(err as Error).message}`);
      }
    })();
  } else {
    indexingState.status = 'ready'; // no watch paths configured
  }

  // ─────────────────────────────────────────────────────────────────────
  // Plan-2: observation pipeline (queue → store → vector/meta).
  // ─────────────────────────────────────────────────────────────────────
  const obsQueue = opts.observationQueueDbPath
    ? new ObservationQueue(opts.observationQueueDbPath)
    : null;
  const obsStore = opts.observationsDbPath
    ? new ObservationsStore(opts.observationsDbPath)
    : null;
  const pendingEmbed = opts.pendingEmbedDbPath
    ? new PendingEmbedQueue(opts.pendingEmbedDbPath)
    : null;

  const summarize = opts.summarize ?? null;
  const tickMs = opts.observationTickMs ?? 5000;
  const batchSize = opts.observationBatchSize ?? 20;

  function dedupeFlat(lists: string[][]): string[] {
    return [...new Set(lists.flat())];
  }

  async function ingestObservation(obs: Observation): Promise<void> {
    const chunks = chunkObservation(obs);
    if (chunks.length === 0) return;
    const synthesizedPath = `observation:${opts.projectId}:${obs.id}`;
    const chunksWithIds = chunks.map(c => ({
      chunk_id: newChunkId('observation', String(obs.id)),
      text: c.text,
      sha: sha256Hex(c.text),
      position: c.position,
      metadata: c.metadata,
    }));

    // Embed → write meta + vectors. If embed fails, write meta (so keyword
    // search still works on this doc) but DO NOT write zero-vectors to the
    // vector store. Zero-vectors poison vector retrieval for the lifetime
    // of the row (cosine sim with zeros is undefined / 0). Instead we queue
    // the chunks for retry; processPendingEmbed will insert real vectors.
    let embeddings: number[][] | null = null;
    if (opts.skipEmbed) {
      // Keyword-only mode — write zero-vectors deliberately (the user opted
      // out of vector search entirely; nothing in the vector half will rank).
      embeddings = chunksWithIds.map(() => new Array(opts.embeddingDimension).fill(0));
    } else {
      try {
        embeddings = await embedder.embed(chunksWithIds.map(c => c.text));
      } catch (err) {
        console.error('[ingest-obs] embed failed; queueing for retry:', (err as Error).message);
        if (pendingEmbed) {
          for (const c of chunksWithIds) {
            pendingEmbed.enqueue({
              chunk_id: c.chunk_id, source_path: synthesizedPath,
              sha: c.sha, channel: 'observation',
            });
          }
        }
        // embeddings stays null → skip vector.add below
      }
    }

    const documentId = meta.upsertDocument({
      source_path: synthesizedPath,
      channel: 'observation',
      project_id: opts.projectId,
      sha: sha256Hex(JSON.stringify(obs)),
      mtime_epoch: obs.created_at_epoch,
      metadata: {
        observation_id: obs.id,
        session_id: obs.session_id,
        type: obs.type,
        title: obs.title,
        created_at_epoch: obs.created_at_epoch,
      },
    });
    meta.replaceChunksForDocument(documentId, chunksWithIds);
    if (embeddings) {
      await vector.add(
        collectionName,
        chunksWithIds.map((c, i) => ({ id: c.chunk_id, embedding: embeddings![i]! })),
      );
    }
  }

  async function processBatch(limit: number): Promise<{ processed: number; observations_created: number }> {
    if (!obsQueue || !obsStore || !summarize) return { processed: 0, observations_created: 0 };
    const batch = obsQueue.takeBatch(limit);
    if (batch.length === 0) return { processed: 0, observations_created: 0 };

    // Group by (session_id, prompt_number) — one observation per prompt window.
    const groups = new Map<string, typeof batch>();
    for (const row of batch) {
      const key = `${row.payload.session_id}::${row.payload.prompt_number}`;
      const existing = groups.get(key) ?? [];
      existing.push(row);
      groups.set(key, existing);
    }

    let observations_created = 0;
    const doneIds: number[] = [];
    const failedIds: number[] = [];
    const permanentIds: number[] = [];
    let retryReason = '';
    let permanentReason = '';

    for (const groupRows of groups.values()) {
      const events = groupRows.map(r => r.payload);
      try {
        const summary = await summarize(events);
        const head = events[0]!;
        const id = obsStore.insert({
          session_id: head.session_id,
          project_id: head.project_id,
          prompt_number: head.prompt_number,
          type: summary.type,
          title: summary.title,
          narrative: summary.narrative,
          facts: summary.facts,
          concepts: summary.concepts,
          files_read: dedupeFlat(events.map(e => e.files_read)),
          files_modified: dedupeFlat(events.map(e => e.files_modified)),
          created_at_epoch: head.ts_epoch,
        });
        const inserted = obsStore.findById(id);
        if (inserted) await ingestObservation(inserted);
        observations_created++;
        doneIds.push(...groupRows.map(r => r.id));
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        console.error(`[obs-batch] summarize failed: ${msg}`);
        // Permanent failures (auth, schema, 400) shouldn't loop. Distinguish
        // by error shape — these will never succeed on retry, so retrying
        // burns API quota for nothing.
        const permanent = /401|403|invalid api key|invalid x-api-key|authentication|unauthorized|400|schema|invalid request|executable not found|enoent|command not found/i.test(msg);
        if (permanent) {
          permanentIds.push(...groupRows.map(r => r.id));
          permanentReason = msg.slice(0, 200);
        } else {
          failedIds.push(...groupRows.map(r => r.id));
          retryReason = msg.slice(0, 200);
        }
      }
    }

    obsQueue.markDone(doneIds);
    if (failedIds.length > 0) obsQueue.markFailed(failedIds, 3, retryReason);
    if (permanentIds.length > 0) obsQueue.markPermanent(permanentIds, permanentReason);

    return { processed: batch.length, observations_created };
  }

  // Worker-wide processBatch lock. Prevents overlapping invocations from
  // any caller (the regular tick AND /observation/flush from Stop hooks).
  // Without it, a Stop hook firing during an active tick spawns concurrent
  // takeBatch claims, accumulating rows in 'processing' state across many
  // sessions — exactly the runaway pattern. The queue is durable so calls
  // that get queued behind the lock aren't lost: they just have to wait.
  let processBatchPromise: Promise<unknown> | null = null;
  async function processBatchSerialized(limit: number): Promise<{ processed: number; observations_created: number }> {
    while (processBatchPromise) {
      try { await processBatchPromise; } catch { /* tracked separately */ }
    }
    const p = processBatch(limit);
    processBatchPromise = p.finally(() => { processBatchPromise = null; });
    return p;
  }

  let tickTimer: ReturnType<typeof setInterval> | null = null;
  if (tickMs > 0 && obsQueue && obsStore && summarize) {
    tickTimer = setInterval(() => {
      // Skip — not queue — if another invocation is in flight. setInterval
      // already calls us every tickMs; piling up missed ticks isn't useful.
      if (processBatchPromise) return;
      processBatchSerialized(batchSize)
        .catch(err => console.error('[obs-tick]', err));
    }, tickMs);
  }

  const PENDING_RETRY_TICK_MS = 60_000;
  const PENDING_BATCH = 25;

  async function processPendingEmbed(limit: number): Promise<{ retried: number; embedded: number }> {
    if (!pendingEmbed) return { retried: 0, embedded: 0 };
    const due = pendingEmbed.listDue(limit);
    if (due.length === 0) return { retried: 0, embedded: 0 };

    // Look up the chunk text from meta. Stale rows (chunk no longer exists)
    // are dropped; remaining rows are re-embedded as a single batch.
    const staleIds: number[] = [];
    const liveRows: typeof due = [];
    const texts: string[] = [];
    for (const row of due) {
      const lookup = meta.getChunkById(row.chunk_id);
      if (!lookup) {
        staleIds.push(row.id);
        continue;
      }
      liveRows.push(row);
      texts.push(lookup.chunk.text);
    }
    if (staleIds.length > 0) pendingEmbed.markEmbedded(staleIds);
    if (liveRows.length === 0) return { retried: due.length, embedded: 0 };

    try {
      const embeddings = await embedder.embed(texts);
      await vector.add(
        collectionName,
        liveRows.map((row, i) => ({ id: row.chunk_id, embedding: embeddings[i]! })),
      );
      pendingEmbed.markEmbedded(liveRows.map(r => r.id));
      return { retried: due.length, embedded: liveRows.length };
    } catch {
      pendingEmbed.markRetried(liveRows.map(r => r.id), PENDING_RETRY_TICK_MS);
      return { retried: due.length, embedded: 0 };
    }
  }

  let pendingTickTimer: ReturnType<typeof setInterval> | null = null;
  if (pendingEmbed && !opts.skipEmbed) {
    pendingTickTimer = setInterval(() => {
      processPendingEmbed(PENDING_BATCH).catch(err => console.error('[pe-tick]', err));
    }, PENDING_RETRY_TICK_MS);
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
        const out = await embedder.embed([query], 'query');
        embedding = out[0] ?? [];
      } catch {
        // fall back to keyword-only on embed failure
      }
    }
    // Channel-scoped search filters POST-fusion. With ~87K observations and
    // only ~279 memory chunks, a 3x multiplier rarely surfaces ANY memory in
    // the candidate pool — we'd ask for top-15 globally and get all
    // observations, leaving 0 after the channel filter. Pull a much larger
    // candidate pool so small channels still get representation. TODO: push
    // channel filter down to SQL/vector layer for proper efficiency.
    const candidatePool = Math.max(topK * 20, 200);
    const fused = await searcher.search(embedding, query, candidatePool);
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
        const obsTotal = obsStore ? obsStore.countAll() : 0;
        const queuePending = obsQueue ? obsQueue.pendingCount() : 0;
        const queueProcessing = obsQueue ? obsQueue.processingCount() : 0;
        return Response.json({
          total_chunks,
          by_channel,
          observations: {
            total: obsTotal,
            queue_pending: queuePending,
            queue_processing: queueProcessing,
          },
          indexing: {
            ...indexingState,
            // Convenience computed fields
            elapsed_s: indexingState.started_at_epoch > 0
              ? (indexingState.finished_at_epoch || Math.floor(Date.now() / 1000)) - indexingState.started_at_epoch
              : 0,
            percent: indexingState.total > 0 ? Math.round((indexingState.done / indexingState.total) * 100) : 100,
          },
          project_id: opts.projectId,
          embedder: { model: opts.embedderModel, endpoint: opts.embedderEndpoint },
          version: pkg.version,
        });
      }
      if (req.method === 'GET' && url.pathname === '/observations/recent') {
        if (!obsStore) return Response.json({ items: [] });
        const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 20));
        const items = obsStore.listRecent(limit).map(o => ({
          id: o.id, session_id: o.session_id, prompt_number: o.prompt_number,
          type: o.type, title: o.title, created_at_epoch: o.created_at_epoch,
        }));
        return Response.json({ items });
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
            const out = await embedder.embed([query], 'query');
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

      if (req.method === 'POST' && url.pathname === '/inject/context') {
        const startMs = Date.now();
        const parsed = InjectContextSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const { formatEnvelope } = await import('./envelope.ts');
        const budget = parsed.data.budget_tokens ?? opts.hookBudgetTokens ?? 4000;

        const trimmed = parsed.data.prompt.trim();
        const isShort = trimmed.length < SHORT_PROMPT_THRESHOLD;
        const isNoOp = NO_OP_TOKENS.has(trimmed.toLowerCase());

        if (isShort || isNoOp) {
          const empty = formatEnvelope({
            project_id: opts.projectId,
            budget_tokens: budget,
            hits: [],
            degradation_flags: [],
          });
          return Response.json({
            envelope: empty.envelope,
            hit_count: 0,
            budget_tokens: budget,
            used_tokens: empty.used_tokens,
            channels_searched: [],
            degradation_flags: ['skipped=short_or_no_op'],
            elapsed_ms: Date.now() - startMs,
          });
        }

        const flags: string[] = [];
        let embedding: number[] = [];
        if (!opts.skipEmbed) {
          try {
            const out = await embedder.embed([trimmed], 'query');
            embedding = out[0] ?? [];
          } catch {
            flags.push('embedder=voyage:keyword-fallback=true');
          }
        } else {
          flags.push('embedder=skipped');
        }

        const fused = await searcher.search(embedding, trimmed, parsed.data.top_k * 3);
        const channelsRequested: Array<'memory' | 'skill' | 'observation'> =
          parsed.data.channels ?? ['memory', 'skill', 'observation'];
        const hits: import('../shared/types.ts').EnvelopeHit[] = [];
        for (const f of fused) {
          const lookup = meta.getChunkById(f.id);
          if (!lookup) continue;
          if (!channelsRequested.includes(lookup.document.channel as 'memory' | 'skill' | 'observation')) continue;
          const m = lookup.chunk.metadata as Record<string, unknown>;
          hits.push({
            doc_id: lookup.chunk.chunk_id,
            channel: lookup.document.channel,
            source_path: lookup.document.source_path,
            title: (m.section_title ?? m.filename_id ?? m.title ?? 'Untitled') as string,
            snippet: lookup.chunk.text.slice(0, 600),
            score: f.score,
            metadata: m,
          });
          if (hits.length >= parsed.data.top_k) break;
        }

        const result = formatEnvelope({
          project_id: opts.projectId,
          budget_tokens: budget,
          hits,
          degradation_flags: flags,
        });

        return Response.json({
          envelope: result.envelope,
          hit_count: result.hit_count,
          budget_tokens: budget,
          used_tokens: result.used_tokens,
          channels_searched: channelsRequested,
          degradation_flags: flags,
          elapsed_ms: Date.now() - startMs,
        });
      }

      if (req.method === 'POST' && url.pathname === '/observation/enqueue') {
        if (!obsQueue) return Response.json({ error: 'observation_pipeline_disabled' }, { status: 503 });
        const parsed = ObservationEnqueueSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const id = obsQueue.enqueue(parsed.data);
        return Response.json({ id, queued: true });
      }

      if (req.method === 'POST' && url.pathname === '/observation/flush') {
        if (!obsQueue || !obsStore || !summarize) {
          return Response.json({ error: 'observation_pipeline_disabled' }, { status: 503 });
        }
        const parsed = ObservationFlushSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        let total_processed = 0;
        let total_created = 0;
        while (total_processed < parsed.data.max) {
          const remaining = parsed.data.max - total_processed;
          // Use the serialized wrapper so flush calls from Stop hooks don't
          // race the regular tick — both share the same in-flight guard.
          const result = await processBatchSerialized(Math.min(batchSize, remaining));
          if (result.processed === 0) break;
          total_processed += result.processed;
          total_created += result.observations_created;
        }
        return Response.json({
          processed: total_processed,
          observations_created: total_created,
          pending_remaining: obsQueue.pendingCount(),
        });
      }

      if (req.method === 'POST' && url.pathname === '/pending_embed/retry') {
        if (!pendingEmbed) return Response.json({ error: 'pending_embed_disabled' }, { status: 503 });
        const parsed = PendingEmbedRetrySchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const due = pendingEmbed.listDue(parsed.data.max);
        return Response.json({
          due_count: due.length,
          total_pending: pendingEmbed.totalCount(),
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
      if (tickTimer) clearInterval(tickTimer);
      if (pendingTickTimer) clearInterval(pendingTickTimer);
      if (watcher) await watcher.close();
      server.stop(true);
      if (obsQueue) obsQueue.close();
      if (obsStore) obsStore.close();
      if (pendingEmbed) pendingEmbed.close();
      vector.close();
      meta.close();
    },
  };
}

// Exported so a `bin/captain-memo-worker` shim can call this explicitly.
// Avoid gating on `import.meta.main` alone: when this file is imported
// (rather than invoked directly), `import.meta.main` is false and the
// startup body would silently no-op.
export async function runWorkerCli(): Promise<void> {
  const { mkdirSync } = await import('fs');
  const { dirname } = await import('path');
  const { DATA_DIR } = await import('../shared/paths.ts');

  // Ensure data directories exist on first run — every store opens a SQLite
  // file inside DATA_DIR, and bun:sqlite won't create missing parent dirs.
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(VECTOR_DB_DIR, { recursive: true });
  mkdirSync(dirname(META_DB_PATH), { recursive: true });

  const port = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
  const projectId = process.env.CAPTAIN_MEMO_PROJECT_ID ?? 'default';
  const embedderEndpoint = process.env.CAPTAIN_MEMO_EMBEDDER_ENDPOINT ?? DEFAULT_VOYAGE_ENDPOINT;
  const embedderModel = process.env.CAPTAIN_MEMO_EMBEDDER_MODEL ?? 'voyageai/voyage-4-nano';
  const embedderApiKey = process.env.CAPTAIN_MEMO_EMBEDDER_API_KEY;
  const embeddingDimension = Number(process.env.CAPTAIN_MEMO_EMBEDDING_DIM ?? 2048);
  // Honor the install wizard's keyword-only mode — without this read, a user
  // who picked "skip embedder" still gets every chunk silently zero-vectored.
  const skipEmbed = process.env.CAPTAIN_MEMO_SKIP_EMBED === '1';
  const vectorDbPath = join(VECTOR_DB_DIR, 'embeddings.db');

  const watchMemory = process.env.CAPTAIN_MEMO_WATCH_MEMORY;
  const watchSkills = process.env.CAPTAIN_MEMO_WATCH_SKILLS;

  let watchPaths: string[] | undefined;
  let watchChannel: 'memory' | 'skill' | undefined;
  if (watchMemory) {
    watchPaths = watchMemory.split(',').map(s => s.trim()).filter(Boolean);
    watchChannel = 'memory';
    if (watchSkills) {
      console.error(
        '[worker] both CAPTAIN_MEMO_WATCH_MEMORY and CAPTAIN_MEMO_WATCH_SKILLS set; ' +
        'Plan-1 supports one channel per worker — using memory'
      );
    }
  } else if (watchSkills) {
    watchPaths = watchSkills.split(',').map(s => s.trim()).filter(Boolean);
    watchChannel = 'skill';
  }

  const anthropicKey = process.env[ENV_ANTHROPIC_API_KEY];
  const summarizerModel = process.env[ENV_SUMMARIZER_MODEL] ?? DEFAULT_SUMMARIZER_MODEL;
  const summarizerFallbacksRaw = process.env[ENV_SUMMARIZER_FALLBACKS];
  const summarizerFallbacks = summarizerFallbacksRaw
    ? summarizerFallbacksRaw.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_SUMMARIZER_FALLBACKS;
  const hookBudgetTokens = Number(process.env[ENV_HOOK_BUDGET_TOKENS] ?? DEFAULT_HOOK_BUDGET_TOKENS);
  const observationBatchSize = Number(process.env[ENV_OBSERVATION_BATCH_SIZE] ?? DEFAULT_OBSERVATION_BATCH_SIZE);
  const observationTickMs = Number(process.env[ENV_OBSERVATION_TICK_MS] ?? DEFAULT_OBSERVATION_TICK_MS);

  // Summarizer provider toggle. Two paths:
  //   - 'anthropic' (default): direct SDK call, requires ANTHROPIC_API_KEY.
  //     Per-call cost on Anthropic's API, sub-second latency.
  //   - 'claude-code':         shells out to `claude -p`, uses your Max/Pro
  //     plan (no API key needed). Higher latency (~1-2s subprocess overhead),
  //     counts against Max session quota.
  const providerRaw = (process.env[ENV_SUMMARIZER_PROVIDER] ?? DEFAULT_SUMMARIZER_PROVIDER).toLowerCase();
  const provider: SummarizerProvider =
    providerRaw === 'claude-oauth'                               ? 'claude-oauth' :
    providerRaw === 'claude-code'                                ? 'claude-code' :
    providerRaw === 'openai-compatible' || providerRaw === 'openai' ? 'openai-compatible' :
    providerRaw === 'anthropic'                                  ? 'anthropic' :
    (() => {
      console.error(`[worker] unknown ${ENV_SUMMARIZER_PROVIDER}="${providerRaw}" — falling back to '${DEFAULT_SUMMARIZER_PROVIDER}'`);
      return DEFAULT_SUMMARIZER_PROVIDER;
    })();

  let summarize: ((events: import('../shared/types.ts').RawObservationEvent[]) => Promise<import('./index.ts').SummarizerResult>) | undefined;
  if (provider === 'claude-oauth') {
    const { createClaudeOauthTransport, readClaudeOauthToken } = await import('./summarizer-claude-oauth.ts');
    const probe = readClaudeOauthToken();
    if (!probe) {
      console.error(
        `[worker] summarizer provider = claude-oauth, but no OAuth token found ` +
        `at ~/.claude/.credentials.json. Run \`claude login\` to authenticate, ` +
        `or pick a different ${ENV_SUMMARIZER_PROVIDER}.`,
      );
    } else {
      const summarizer = new Summarizer({
        apiKey: '', // unused — OAuth transport carries the bearer token
        model: summarizerModel,
        fallbackModels: summarizerFallbacks,
        transport: createClaudeOauthTransport(),
      });
      summarize = (events) => summarizer.summarize(events);
      const expiresIn = Math.floor((probe.expiresAt - Date.now()) / 60_000);
      console.error(
        `[worker] summarizer provider = claude-oauth ` +
        `(direct api.anthropic.com, no API key, no subprocess; token expires in ~${expiresIn} min)`,
      );
    }
  } else if (provider === 'claude-code') {
    const { createClaudeCodeTransport } = await import('./summarizer-claude-code.ts');
    const summarizer = new Summarizer({
      apiKey: '', // unused under claude-code transport (auth via the CLI)
      model: summarizerModel,
      fallbackModels: summarizerFallbacks,
      transport: createClaudeCodeTransport(),
    });
    summarize = (events) => summarizer.summarize(events);
    console.error(`[worker] summarizer provider = claude-code (Max/Pro plan auth via 'claude -p')`);
  } else if (provider === 'openai-compatible') {
    const endpoint = process.env[ENV_OPENAI_ENDPOINT];
    if (!endpoint) {
      console.error(
        `[worker] ${ENV_SUMMARIZER_PROVIDER}=openai-compatible requires ${ENV_OPENAI_ENDPOINT} to be set\n` +
        `         (e.g. http://localhost:11434/v1/chat/completions for Ollama)`
      );
    } else {
      const apiKey = process.env[ENV_OPENAI_API_KEY];
      const { createOpenAITransport } = await import('./summarizer-openai.ts');
      const summarizer = new Summarizer({
        apiKey: '', // unused — openai transport carries its own optional key
        model: summarizerModel,
        fallbackModels: summarizerFallbacks,
        transport: createOpenAITransport({
          endpoint,
          ...(apiKey !== undefined && { apiKey }),
        }),
      });
      summarize = (events) => summarizer.summarize(events);
      console.error(`[worker] summarizer provider = openai-compatible (${endpoint})${apiKey ? ' [auth]' : ' [no auth]'}`);
    }
  } else if (anthropicKey) {
    const summarizer = new Summarizer({
      apiKey: anthropicKey,
      model: summarizerModel,
      fallbackModels: summarizerFallbacks,
    });
    summarize = (events) => summarizer.summarize(events);
    console.error(`[worker] summarizer provider = anthropic (Anthropic API key)`);
  } else {
    console.error(
      `[worker] observation summarizer disabled — set one of:\n` +
      `         - ${ENV_SUMMARIZER_PROVIDER}=claude-code        (Max/Pro plan, no key)\n` +
      `         - ${ENV_SUMMARIZER_PROVIDER}=openai-compatible  + ${ENV_OPENAI_ENDPOINT} (Ollama / LM Studio / OpenAI / etc.)\n` +
      `         - ${ENV_ANTHROPIC_API_KEY}=sk-...                (direct Anthropic API)`
    );
  }

  const handle = await startWorker({
    port,
    projectId,
    metaDbPath: META_DB_PATH,
    embedderEndpoint,
    embedderModel,
    ...(embedderApiKey !== undefined && { embedderApiKey }),
    vectorDbPath,
    embeddingDimension,
    skipEmbed,
    ...(watchPaths !== undefined && watchChannel !== undefined && { watchPaths, watchChannel }),
    observationQueueDbPath: QUEUE_DB_PATH,
    observationsDbPath: OBSERVATIONS_DB_PATH,
    pendingEmbedDbPath: PENDING_EMBED_DB_PATH,
    hookBudgetTokens,
    observationBatchSize,
    observationTickMs,
    ...(summarize !== undefined && { summarize }),
  });
  console.log(`[worker] listening on http://localhost:${handle.port}`);

  const shutdown = async () => {
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Direct invocation (`bun src/worker/index.ts` from systemd unit). Keep the
// guard for convenience but the function is exported above for wrappers.
if (import.meta.main) {
  runWorkerCli().catch((err) => {
    console.error('[worker] startup failed:', err);
    process.exit(1);
  });
}
