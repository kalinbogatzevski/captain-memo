import { join } from 'path';
import { statSync, readdirSync, chmodSync, existsSync } from 'node:fs';
import { detectBranchSyncCached } from './branch.ts';
import { z } from 'zod';
import { MetaStore } from './meta.ts';
import { Embedder } from './embedder.ts';
import { embedderMaxTokens } from '../shared/embedder-limits.ts';
import { loadWorkerEnv } from '../shared/worker-env.ts';
import { VectorStore } from './vector-store.ts';
import { HybridSearcher } from './search.ts';
import { IngestPipeline } from './ingest.ts';
import { writeMemory, type WriteMemoryDeps, type RememberInput } from './memory-writer.ts';
import { FileWatcher } from './watcher.ts';
import { ObservationQueue } from './observation-queue.ts';
import { ObservationsStore } from './observations-store.ts';
import type { RecallQuery, RecallView, RecallSort } from './observations-store.ts';
import { loadTideConfig, computeBuoyancy, tideMultiplier } from './tide.ts';
import { runTideSweepSlice } from './tide-sweep.ts';
import { loadQmConfig } from './qm.ts';
import { runQmDedupSlice } from './quartermaster.ts';
import { centroid } from '../shared/vector-math.ts';
import { PendingEmbedQueue } from './pending-embed-queue.ts';
import { chunkObservation } from './chunkers/observation.ts';
import { splitForEmbed } from './chunkers/safe-split.ts';
import { EmbedderInputTooLarge } from './embedder.ts';
import { newChunkId } from '../shared/id.ts';
import { sha256Hex } from '../shared/sha.ts';
import type { RawObservationEvent, ObservationType, Observation } from '../shared/types.ts';
import type { Hit } from '../shared/types.ts';
import {
  DATA_DIR,
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
  ENV_REMEMBER_DIR,
  DEFAULT_REMEMBER_DIR,
  ENV_REMEMBER_DEDUP_THRESHOLD,
  DEFAULT_REMEMBER_DEDUP_THRESHOLD,
} from '../shared/paths.ts';
import { writeRecallAuditLine } from './recall-audit.ts';
import { getDreamStats } from './dream-stats.ts';
import { Summarizer, type SummarizerTransport } from './summarizer.ts';
import { classifySummarizeFailure, computeBackoffMs } from './summarizer-backoff.ts';
import { createWorkerMetrics, recordEmbed, recordIndexResult } from './metrics.ts';
import { computeEfficiency } from './efficiency.ts';
import { countTokens } from '../shared/tokens.ts';
import { VERSION } from '../shared/version.ts';

// Recursive directory size in bytes. Returns 0 for missing dirs (fail-open
// for /stats — better an under-counted disk number than a 500 response).
// Symlinks are not followed (would risk loops + unrelated tree size).
function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      try {
        const path = join(dir, name);
        const st = statSync(path);
        if (st.isDirectory()) total += dirSizeBytes(path);
        else if (st.isFile()) total += st.size;
      } catch { /* skip files that vanished mid-walk */ }
    }
  } catch { /* dir missing or unreadable */ }
  return total;
}

// Route a retrieval-tracking bump to either an injected sink (reader mode forwards
// bumps to the writer) or the local store (normal mode). No-ops on empty ids.
// Exported so it can be unit-tested without booting a worker.
export function applyBump(
  ids: number[],
  source: import('../shared/types.ts').RetrievalSource,
  sink: ((ids: number[], source: import('../shared/types.ts').RetrievalSource) => void) | undefined,
  store: { bumpRetrieval: (ids: number[], source: import('../shared/types.ts').RetrievalSource) => void } | undefined,
): void {
  if (ids.length === 0) return;
  if (sink) { try { sink(ids, source); } catch (e) { console.error('[retrieval-tracking] sink failed:', (e as Error).message); } return; }
  if (!store) return;
  try { store.bumpRetrieval(ids, source); } catch (e) { console.error('[retrieval-tracking] bump failed:', (e as Error).message); }
}

export interface SummarizerResult {
  type: ObservationType;
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  /** Token usage from the summarizer call — available when the transport exposes it. */
  usage?: { input_tokens: number; output_tokens: number };
}

export interface WorkerOptions {
  port: number;
  projectId: string;
  metaDbPath: string;
  embedderEndpoint: string;
  embedderModel: string;
  embedderApiKey?: string;
  embedderApiFormat?: 'openai' | 'aelita';
  embedderMaxInputTokens?: number;
  vectorDbPath: string;
  embeddingDimension: number;
  skipEmbed?: boolean;
  watchPaths?: string[];
  watchChannel?: 'memory' | 'skill';
  observationQueueDbPath?: string;
  observationsDbPath?: string;
  pendingEmbedDbPath?: string;
  summarize?: (events: RawObservationEvent[]) => Promise<SummarizerResult>;
  /** Raw model-fallback transport (from Summarizer.getTransport()). Surfaced so the
   *  /remember writer can drive frontmatter/merge fills directly — distinct from the
   *  observation-shaped `summarize` above. Absent ⇒ writeMemory uses deterministic fallback. */
  summarizerTransport?: SummarizerTransport;
  observationTickMs?: number;
  observationBatchSize?: number;
  hookBudgetTokens?: number;
  /** Engine-thread mode: build stores + handler but do NOT bind an HTTP port.
   *  The caller (engine.ts) wires `handler` to the thread channel instead. */
  noServe?: boolean;
  /** Read-only reader mode: suppress ALL write machinery (watcher, ingest, ticks,
   *  backfill, queue/pending stores) and open corpus stores read-only. */
  readOnly?: boolean;
  /** When set, retrieval-tracking bumps are handed to this sink instead of being
   *  written locally — readers forward them to the writer. */
  onRetrievalBump?: (ids: number[], source: import('../shared/types.ts').RetrievalSource) => void;
}

export interface WorkerHandle {
  port: number;
  stop: () => Promise<void>;
  /** The live observations store, or undefined when the worker runs without
   *  observations. Exposed for tests and in-process introspection (e.g. to
   *  archive a row and assert the search post-filter drops it). */
  store?: ObservationsStore;
  /** The request handler — exposed so the engine thread can serve it over the channel. */
  handler?: (req: Request) => Promise<Response>;
}

const SearchRequestSchema = z.object({
  query: z.string(),
  top_k: z.number().int().positive().max(50).default(5),
  channels: z.array(z.enum(['memory', 'skill', 'observation'])).optional(),
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
  branch: z.string().nullable().optional(),
  source: z.string().optional(),
});

const ObservationFlushSchema = z.object({
  session_id: z.string().optional(),
  max: z.number().int().positive().max(500).default(100),
});

const PendingEmbedRetrySchema = z.object({
  max: z.number().int().positive().max(500).default(50),
});

const RestoreSchema = z.object({
  id: z.number().int().positive(),
});

const RememberSchema = z.object({
  body: z.string().min(1),
  type: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  slug: z.string().optional(),
  cwd: z.string().optional(),
  sourceObservationId: z.number().int().positive().optional(),
  targetDirOverride: z.string().optional(),
});

const InjectContextSchema = z.object({
  prompt: z.string(),
  top_k: z.number().int().positive().max(50).default(5),
  channels: z.array(z.enum(['memory', 'skill', 'observation'])).optional(),
  budget_tokens: z.number().int().positive().max(20_000).optional(),
  session_id: z.string().optional(),
  project_id: z.string().optional(),
});

const SHORT_PROMPT_THRESHOLD = 10;
const NO_OP_TOKENS = new Set(['ok', 'continue', 'yes', 'go', 'next', 'sure']);

/** Tighten the on-disk permissions of a secret-bearing path (the meta DB now persists the E2E private
 *  scalars; DATA_DIR contains it). Best-effort: a chmod failure (e.g. an unsupported platform, or a
 *  non-owner running) must NEVER crash boot — we just warn. Skipped silently when the path is absent. */
function chmodSecret(path: string, mode: number): void {
  try {
    if (!existsSync(path)) return;
    chmodSync(path, mode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[worker] WARN: could not chmod ' + path + ' to ' + mode.toString(8) + ' (' + msg + ') — secret may be world-readable');
  }
}

export async function startWorker(opts: WorkerOptions): Promise<WorkerHandle> {
  // Worker boot time — surfaced via /stats so the dashboard can show liveness + uptime.
  const workerStartedAtEpoch = Math.floor(Date.now() / 1000);
  const meta = new MetaStore(opts.metaDbPath, { readonly: !!opts.readOnly });
  // Tighten the meta DB to owner-only (0600). It lands 0644 under the default umask; the corpus is
  // private memory, so harden it. Best-effort (never crashes boot). A read-only handle still
  // tightens what it opened.
  chmodSecret(opts.metaDbPath, 0o600);

  // Boot-time hint when the corpus still carries pre-v0.1.8 observation
  // chunks. The worker keeps serving search just fine — the old per-fact
  // shape is still queryable — but disk + recall improve materially after
  // an upgrade, so surface the one command that fixes it.
  const legacyChunks = meta.countLegacyObservationChunks();
  if (legacyChunks > 0) {
    console.error(
      `[worker] notice: ${legacyChunks.toLocaleString('en-US')} observation chunks ` +
      `are on the pre-v0.1.8 per-fact shape. Run \`captain-memo upgrade\` to ` +
      `re-chunk (1 chunk per obs, structural [type] prefix) and reclaim disk.`,
    );
  }
  const embedder = new Embedder({
    endpoint: opts.embedderEndpoint,
    model: opts.embedderModel,
    ...(opts.embedderApiKey !== undefined && { apiKey: opts.embedderApiKey }),
    ...(opts.embedderApiFormat !== undefined && { apiFormat: opts.embedderApiFormat }),
    maxInputTokens: opts.embedderMaxInputTokens ?? embedderMaxTokens(opts.embedderModel),
  });
  const vector = new VectorStore({
    dbPath: opts.vectorDbPath,
    dimension: opts.embeddingDimension,
    readonly: !!opts.readOnly,
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

  const getChunk = async (id: string) => {
    const found = meta.getChunkById(id);
    if (!found) return null;
    return {
      id,
      content: found.chunk.text,
      branch: (found.document.metadata as { branch?: string | null }).branch ?? null,
    };
  };

  // Tide (A7) memory-lifecycle re-rank. Inert unless CAPTAIN_MEMO_TIDE_ENABLED=1.
  // Resolves each candidate to its observation row (observation channel only —
  // memory/skill are anchored at ×1.0), batches the buoyancy inputs via the single
  // tideRowsAmong query, multiplies the fused score by the bounded buoyancy factor,
  // and re-sorts. obsStore is referenced lazily — the closure only runs at search
  // time, long after obsStore is constructed below.
  const tideConfig = loadTideConfig(process.env);
  const qmConfig = loadQmConfig(process.env);
  const tideRerankFn = <T extends { id: string; score: number }>(items: T[]): T[] => {
    if (!obsStore || items.length === 0) return items;
    const oidByItem = new Map<T, number>();
    const oids: number[] = [];
    for (const item of items) {
      const lookup = meta.getChunkById(item.id);
      if (!lookup || lookup.document.channel !== 'observation') continue; // anchored ⇒ ×1
      const oid = (lookup.chunk.metadata as { observation_id?: unknown }).observation_id;
      if (typeof oid !== 'number') continue;
      oidByItem.set(item, oid);
      oids.push(oid);
    }
    if (oids.length === 0) return items;
    const rows = obsStore.tideRowsAmong(oids);
    const now = Math.floor(Date.now() / 1000);
    const rescored = items.map(item => {
      const oid = oidByItem.get(item);
      if (oid === undefined) return item;            // non-observation ⇒ unchanged (×1)
      const row = rows.get(oid);
      if (!row) return item;
      const mult = tideMultiplier(computeBuoyancy(row, now, tideConfig), tideConfig);
      return { ...item, score: item.score * mult };
    });
    rescored.sort((a, b) => b.score - a.score);
    return rescored;
  };

  const searcher = new HybridSearcher({
    vectorSearch: async (embedding, topK) => {
      if (opts.skipEmbed || embedding.length === 0) return [];
      const results = await vector.query(collectionName, embedding, topK);
      return results.map(r => ({ id: r.id, distance: r.distance }));
    },
    keywordSearch: async (query, topK) => meta.searchKeyword(query, topK),
    getChunk,
    ...(tideConfig.enabled ? { tideRerank: tideRerankFn } : {}),
  });

  const effectiveMaxInputTokens = opts.embedderMaxInputTokens ?? embedderMaxTokens(opts.embedderModel);
  const metrics = createWorkerMetrics();

  // Single timed wrapper around embedder.embed() for the indexing paths.
  // Token counting here is cheap relative to the embed call it wraps and
  // runs off the /stats hot path.
  async function timedEmbed(texts: string[]): Promise<number[][]> {
    const t0 = performance.now();
    try {
      return await embedder.embed(texts);
    } finally {
      const ms = performance.now() - t0;
      const tokens = texts.reduce((n, t) => n + countTokens(t), 0);
      recordEmbed(metrics, tokens, ms);
    }
  }

  const ingest = new IngestPipeline({
    meta,
    maxInputTokens: effectiveMaxInputTokens,
    onIndexResult: (result) => recordIndexResult(metrics, result),
    embedder: {
      embed: async (texts) => {
        if (opts.skipEmbed) {
          return texts.map(() => new Array(opts.embeddingDimension).fill(0));
        }
        try {
          return await timedEmbed(texts);
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

  // Paths the writer engine just wrote itself (e.g. POST /remember). chokidar still
  // fires add/change for our own write; we drop the first event per path so we don't
  // re-run indexFile on a file we already indexed in-process. SHA-idempotent anyway,
  // but this avoids a redundant embed+upsert. Single-shot: consumed on first hit.
  const selfWrites = new Set<string>();
  const registerSelfWrite = (absPath: string): void => { selfWrites.add(absPath); };

  let watcher: FileWatcher | null = null;
  if (!opts.readOnly && opts.watchPaths && opts.watchPaths.length > 0 && opts.watchChannel) {
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
              // Suppress the echo of our own in-process write (POST /remember).
              if (type !== 'unlink' && selfWrites.delete(path)) return;
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
  const obsQueue = !opts.readOnly && opts.observationQueueDbPath
    ? new ObservationQueue(opts.observationQueueDbPath)
    : null;
  const obsStore = opts.observationsDbPath
    ? new ObservationsStore(opts.observationsDbPath, { readonly: !!opts.readOnly, tideConfig })
    : null;
  const pendingEmbed = !opts.readOnly && opts.pendingEmbedDbPath
    ? new PendingEmbedQueue(opts.pendingEmbedDbPath)
    : null;

  // One-time stored_tokens backfill. The column is captured at index time, so
  // observations indexed before v0.1.9 have it NULL. Pure CPU — chunk + count
  // tokens, NO embedder calls. Backgrounded so the HTTP server is up
  // immediately; resumable + idempotent (a later boot with nothing missing is
  // a no-op). Batched so a setStoredTokens write never races a live cursor.
  if (!opts.readOnly && obsStore) {
    const missingStored = obsStore.countMissingStoredTokens();
    if (missingStored > 0) {
      const store = obsStore;
      void (async () => {
        console.error(`[worker] stored_tokens backfill: ${missingStored} observations`);
        const BACKFILL_BATCH = 200;
        let done = 0;
        for (;;) {
          const batch = store.listMissingStoredTokens(BACKFILL_BATCH);
          if (batch.length === 0) break;
          for (const obs of batch) {
            try {
              const rawChunks = chunkObservation(obs);
              const chunks = rawChunks.length > 0
                ? splitForEmbed(rawChunks, effectiveMaxInputTokens)
                : [];
              const tokens = chunks.reduce((n, c) => n + countTokens(c.text), 0);
              store.setStoredTokens(obs.id, tokens);
              done++;
            } catch (err) {
              console.error(`[worker] stored_tokens backfill failed for obs ${obs.id}:`, (err as Error).message);
              store.setStoredTokens(obs.id, 0);  // mark processed so the loop still terminates
            }
          }
        }
        console.error(`[worker] stored_tokens backfill complete: ${done} observations`);
      })();
    }
  }

  const summarize = opts.summarize ?? null;
  const tickMs = opts.observationTickMs ?? 5000;
  const batchSize = opts.observationBatchSize ?? 20;

  // Summarizer backoff: when the Anthropic API is overloaded/down (HTTP 529/5xx/
  // 429/network), stop hammering it. `summarizerCooldownUntil` gates processBatch so
  // no batch is attempted during the cooldown; `overloadStreak` drives exponential
  // backoff and resets on the next clean summarize. Observations are durable — they
  // wait in the queue and are NOT dead-lettered while the API is down.
  let summarizerCooldownUntil = 0;
  let overloadStreak = 0;

  function dedupeFlat(lists: string[][]): string[] {
    return [...new Set(lists.flat())];
  }

  async function ingestObservation(obs: Observation): Promise<void> {
    const rawChunks = chunkObservation(obs);
    if (rawChunks.length === 0) return;
    // Pre-split oversized chunks so a long Haiku-summarized narrative never
    // silently truncates at Voyage. Same chokepoint as IngestPipeline uses
    // for memory + skill files; observations have their own embed loop so
    // we re-apply here.
    const chunks = splitForEmbed(rawChunks, effectiveMaxInputTokens);
    const synthesizedPath = `observation:${opts.projectId}:${obs.id}`;
    const chunksWithIds = chunks.map(c => ({
      chunk_id: newChunkId('observation', String(obs.id)),
      text: c.text,
      sha: sha256Hex(c.text),
      position: c.position,
      metadata: c.metadata,
    }));

    const storedTokens = chunksWithIds.reduce((n, c) => n + countTokens(c.text), 0);
    obsStore?.setStoredTokens(obs.id, storedTokens);

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
        embeddings = await timedEmbed(chunksWithIds.map(c => c.text));
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
        branch: obs.branch ?? null,
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
    // Summarizer cooldown: the API was overloaded/unreachable recently — skip this
    // pass entirely (no takeBatch, no API call) until the backoff elapses. The tick
    // keeps firing but this early-return makes each one a cheap no-op.
    if (Date.now() < summarizerCooldownUntil) return { processed: 0, observations_created: 0 };
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
    const overloadedIds: number[] = [];
    let retryReason = '';
    let permanentReason = '';
    let overloadReason = '';
    let maxRetryAfterMs = 0;

    for (const groupRows of groups.values()) {
      const events = groupRows.map(r => r.payload);
      try {
        const summary = await summarize(events);
        const head = events[0]!;
        const workTokens = summary.usage
          ? summary.usage.input_tokens + summary.usage.output_tokens
          : null;
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
          branch: head.branch ?? null,
          work_tokens: workTokens,
        });
        const inserted = obsStore.findById(id);
        if (inserted) await ingestObservation(inserted);
        observations_created++;
        doneIds.push(...groupRows.map(r => r.id));
      } catch (err) {
        const e = err as Error & { status?: number; retryAfterMs?: number };
        const msg = e.message ?? String(err);
        console.error(`[obs-batch] summarize failed: ${msg}`);
        const ids = groupRows.map(r => r.id);
        // permanent  → never succeeds on retry (auth/bad-request/model) → dead-letter.
        // overloaded → transient API outage (5xx/429/network) → requeue (no retry
        //              increment) + back off so we stop hammering a down API.
        // retryable  → per-item (e.g. bad model output failing our schema) → bounded
        //              retries, then dead-letter so one bad item can't wedge the queue.
        const kind = classifySummarizeFailure(msg, e.status);
        if (kind === 'permanent') {
          permanentIds.push(...ids);
          permanentReason = msg.slice(0, 200);
        } else if (kind === 'overloaded') {
          overloadedIds.push(...ids);
          overloadReason = msg.slice(0, 200);
          if (typeof e.retryAfterMs === 'number') maxRetryAfterMs = Math.max(maxRetryAfterMs, e.retryAfterMs);
        } else {
          failedIds.push(...ids);
          retryReason = msg.slice(0, 200);
        }
      }
    }

    obsQueue.markDone(doneIds);
    // Overloaded = transient outage: requeue WITHOUT a retry increment so a long
    // outage can't dead-letter observations (the cooldown below spaces the retries).
    if (overloadedIds.length > 0) obsQueue.requeue(overloadedIds);
    if (failedIds.length > 0) obsQueue.markFailed(failedIds, 3, retryReason);
    if (permanentIds.length > 0) obsQueue.markPermanent(permanentIds, permanentReason);

    if (overloadedIds.length > 0) {
      // The API looked overloaded/down — back off the whole obs-batch loop so we
      // delay (not hammer) our next attempt. Escalates per consecutive cycle.
      overloadStreak++;
      const backoffMs = computeBackoffMs(overloadStreak, maxRetryAfterMs);
      summarizerCooldownUntil = Date.now() + backoffMs;
      console.error(
        `[obs-batch] summarizer API overloaded/unreachable — backing off ${Math.round(backoffMs / 1000)}s `
        + `(attempt ${overloadStreak}): ${overloadReason}`,
      );
    } else if (doneIds.length > 0) {
      // A clean summarize means the API recovered — clear the cooldown + streak.
      overloadStreak = 0;
      summarizerCooldownUntil = 0;
    }

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
  if (!opts.readOnly && tickMs > 0 && obsQueue && obsStore && summarize) {
    tickTimer = setInterval(() => {
      // Skip — not queue — if another invocation is in flight. setInterval
      // already calls us every tickMs; piling up missed ticks isn't useful.
      if (processBatchPromise) return;
      processBatchSerialized(batchSize)
        .catch(err => console.error('[obs-tick]', err));
    }, tickMs);
  }

  // Tide ebb sweep (Phase 2, opt-in). Writer-only, bounded, heartbeat-safe: each slice
  // pulls a capped batch of idle candidates, flips eligible ones down a tier, yields
  // between rows, and aborts the instant ingest is queued. Skips (not queues) if a
  // prior slice is still running. Surfacing stays recall-driven in bumpRetrieval.
  let tideSweepTimer: ReturnType<typeof setInterval> | null = null;
  let tideSweepPromise: Promise<unknown> | null = null;
  if (!opts.readOnly && obsStore && tideConfig.enabled && tideConfig.tieringEnabled) {
    const sweepStore = obsStore;
    tideSweepTimer = setInterval(() => {
      if (tideSweepPromise) return;
      tideSweepPromise = runTideSweepSlice({
        candidates: (state, limit, olderThan) => sweepStore.tierSweepCandidates(state, limit, olderThan),
        setTideState: (id, state, at) => sweepStore.setTideState(id, state, at),
        // Ingest and the heartbeat always preempt: abort if a batch is processing or
        // any observation is queued.
        shouldAbort: () => processBatchPromise != null || (obsQueue?.pendingCount() ?? 0) > 0,
        cfg: tideConfig,
        now: () => Math.floor(Date.now() / 1000),
        yieldToLoop: () => new Promise<void>(r => setImmediate(r)),
      })
        .then(r => {
          if (r.ebbed > 0 || r.archived > 0) {
            console.error(`[tide-sweep] ebbed ${r.ebbed} → dormant, ${r.archived} → archived`
              + (r.aborted ? ' (aborted for ingest)' : ''));
          }
        })
        .catch(err => console.error('[tide-sweep] ERROR', err))
        .finally(() => { tideSweepPromise = null; });
    }, tideConfig.sweepIntervalMs);
  }

  // Quartermaster auto-dedup (opt-in, OFF by default). Sibling of the tide sweep:
  // each slice pulls a bounded candidate window of near-dup observations, confirms
  // each fold behind a cosine ≥ threshold check against the survivor's centroid
  // vector (fail-closed when a vector is missing), folds the members, and yields
  // between groups so the heartbeat breathes and queued ingest preempts mid-slice.
  let qmDedupTimer: ReturnType<typeof setInterval> | null = null;
  let qmDedupPromise: Promise<unknown> | null = null;
  if (!opts.readOnly && obsStore && qmConfig.enabled && qmConfig.dedupEnabled) {
    const qmStore = obsStore;
    // Representative vector for an observation = centroid of its chunk vectors (already in sqlite-vec).
    const repVec = (obsId: number): Float32Array | null => {
      const doc = meta.getDocument(`observation:${opts.projectId}:${obsId}`);
      if (!doc) return null;
      const vecs = meta.getChunksForDocument(doc.id)
        .map(c => vector.getEmbedding(c.chunk_id))
        .filter((v): v is Float32Array => v != null)
        .map(v => Array.from(v));
      const c = centroid(vecs);
      return c ? Float32Array.from(c) : null;
    };
    qmDedupTimer = setInterval(() => {
      if (qmDedupPromise) return;
      const startedAt = Math.floor(Date.now() / 1000);
      qmDedupPromise = runQmDedupSlice({
        candidates: () => qmStore.dedupCandidateWindow(qmConfig.dedupTitleThreshold, qmConfig.dedupWindow),
        representativeVector: repVec,
        memberIsProtected: (id) => qmStore.isProtected(id),
        mergeGroup: (s, m, at) => qmStore.mergeDuplicateGroup(s, m, at),
        shouldAbort: () => processBatchPromise != null || (obsQueue?.pendingCount() ?? 0) > 0,
        cfg: qmConfig,
        now: () => Math.floor(Date.now() / 1000),
        yieldToLoop: () => new Promise<void>(r => setImmediate(r)),
      })
        .then(r => {
          qmStore.recordQmRun({ job: 'dedup', startedAt, finishedAt: Math.floor(Date.now() / 1000),
            rowsScanned: r.scanned, merges: r.merges, skippedNoVector: r.skippedNoVector,
            abortedForIngest: r.aborted, errored: false });
          if (r.merges > 0) console.error(`[qm-dedup] folded ${r.merges} member(s)` + (r.aborted ? ' (aborted for ingest)' : ''));
        })
        .catch(err => {
          // A throwing slice must still leave an audit row, else /stats.qm.last_run
          // would show the last GOOD run and hide that dedup is broken.
          qmStore.recordQmRun({ job: 'dedup', startedAt, finishedAt: Math.floor(Date.now() / 1000),
            rowsScanned: 0, merges: 0, skippedNoVector: 0, abortedForIngest: false, errored: true });
          console.error('[qm-dedup] ERROR', err);
        })
        .finally(() => { qmDedupPromise = null; });
    }, qmConfig.dedupIntervalMs);
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
    } catch (err) {
      // EmbedderInputTooLarge is permanent — the stored chunk text won't
      // change on retry. Pop the offending row from the queue (FTS still
      // serves it; vector search misses) so it doesn't loop forever.
      // All other failures are transient → standard retry-with-backoff.
      if (err instanceof EmbedderInputTooLarge) {
        const badRow = liveRows[err.inputIndex];
        if (badRow) {
          console.error(
            `[pending-embed] dropping permanently oversized chunk ${badRow.chunk_id}: ` +
            `${err.tokensEstimated} tok > ${err.tokensLimit} limit. ` +
            `Vector search will miss this chunk; FTS still works.`,
          );
          pendingEmbed.markEmbedded([badRow.id]);
          const remainingIds = liveRows.filter((_, i) => i !== err.inputIndex).map(r => r.id);
          if (remainingIds.length > 0) {
            pendingEmbed.markRetried(remainingIds);
          }
          return { retried: due.length, embedded: 0 };
        }
      }
      pendingEmbed.markRetried(liveRows.map(r => r.id));
      return { retried: due.length, embedded: 0 };
    }
  }

  let pendingTickTimer: ReturnType<typeof setInterval> | null = null;
  if (!opts.readOnly && pendingEmbed && !opts.skipEmbed) {
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

  // Recency decay for the OBSERVATION channel only — memory and skill
  // are user-authored canonical knowledge that doesn't go stale, but
  // auto-captured session observations do (yesterday's "we use voyage-4-nano"
  // is superseded by today's "we switched to voyage-4-lite"). Half-life
  // controls how quickly old chunks lose ranking weight without disappearing.
  // Default 90 days = an observation from 90 days ago competes with one from
  // today at 50% of its semantic score. Set to 0 to disable.
  const HALF_LIFE_DAYS = Number(process.env.CAPTAIN_MEMO_OBSERVATION_HALF_LIFE_DAYS ?? 90);
  const HALF_LIFE_MS = HALF_LIFE_DAYS * 24 * 3600 * 1000;
  const applyRecencyDecay = <T extends { id: string; score: number }>(items: T[]): T[] => {
    if (HALF_LIFE_DAYS <= 0) return items;
    const now = Date.now();
    const decayed = items.map(item => {
      const lookup = meta.getChunkById(item.id);
      if (!lookup || lookup.document.channel !== 'observation') return item;
      const m = lookup.chunk.metadata as Record<string, unknown>;
      const epochS = (typeof m.created_at_epoch === 'number' ? m.created_at_epoch : null)
        ?? lookup.document.mtime_epoch;
      if (!epochS) return item;
      const ageMs = now - epochS * 1000;
      if (ageMs <= 0) return item;
      const decay = Math.exp(-Math.LN2 * ageMs / HALF_LIFE_MS);
      return { ...item, score: item.score * decay };
    });
    decayed.sort((a, b) => b.score - a.score);
    return decayed;
  };
  const searchWithRecency = async (embedding: number[], query: string, k: number) => {
    const branchBoostEnabled = process.env.CAPTAIN_MEMO_BRANCH_BOOST !== '0';
    const currentBranch = branchBoostEnabled ? detectBranchSyncCached(process.cwd()) : null;
    const raw = await searcher.search(embedding, query, k, { currentBranch });
    // Tide (when enabled) re-ranks INSIDE searcher.search, before truncation — so
    // skip the flat recency decay here to avoid double-applying. Disabled ⇒ today's path.
    return tideConfig.enabled ? raw : applyRecencyDecay(raw);
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
    const fused = await searchWithRecency(embedding, query, candidatePool);
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

  /**
   * Bump the per-source retrieval counter on any observation rows surfaced by
   * a search/inject response. Empty-safe and exception-safe — a write failure
   * here must never bubble up and fail the originating request, since the
   * tracking signal is auxiliary, not load-bearing.
   *
   * `source` tags the call site so /stats can break out auto-injection vs
   * explicit search vs full-content drill. Non-observation results contribute
   * no ids and are naturally filtered out (only items with a numeric
   * metadata.observation_id are counted).
   */
  /**
   * Shared post-filter for surfacing paths: extract observation ids, ask `lookup`
   * which to drop, and remove them. Non-observation hits (no observation_id) are
   * always kept. obsStore-guarded, so `lookup` only runs when the store exists.
   */
  const dropByLookup = <T extends { metadata: Record<string, unknown> }>(
    items: T[], lookup: (ids: number[]) => Set<number>,
  ): T[] => {
    if (!obsStore || items.length === 0) return items;
    const ids: number[] = [];
    for (const item of items) {
      const oid = item.metadata?.observation_id;
      if (typeof oid === 'number' && Number.isInteger(oid) && oid > 0) ids.push(oid);
    }
    if (ids.length === 0) return items;
    const drop = lookup(ids);
    if (drop.size === 0) return items;
    return items.filter(item => {
      const oid = item.metadata?.observation_id;
      return !(typeof oid === 'number' && drop.has(oid));
    });
  };

  /**
   * Drop hits whose backing observation has been archived (folded into a survivor by
   * dedup). Applied to every surfacing path — search and the auto-injection hook — so
   * archived duplicates stop appearing without deleting their vectors (reversible).
   * Distinct from Tide dormancy (dropSunkForAutoInject) below.
   */
  const dropArchived = <T extends { metadata: Record<string, unknown> }>(items: T[]): T[] =>
    dropByLookup(items, ids => obsStore!.archivedAmong(ids));

  /**
   * Auto-inject ONLY: drop *sunk* observations (Tide dormant/archived) so the default
   * injected context shows live memory, not ebbed rows. Unlike dropArchived this never
   * touches /search — a sunk row stays reachable there (down-ranked by buoyancy) and
   * one recall re-floats it. No-op unless tiering is enabled.
   */
  const dropSunkForAutoInject = <T extends { metadata: Record<string, unknown> }>(items: T[]): T[] =>
    tideConfig.tieringEnabled ? dropByLookup(items, ids => obsStore!.sunkAmong(ids)) : items;

  const bumpRetrievalFromResults = (
    items: Array<{ metadata: Record<string, unknown> }>,
    source: import('../shared/types.ts').RetrievalSource,
  ): void => {
    if (items.length === 0) return;
    const ids: number[] = [];
    for (const item of items) {
      const oid = item.metadata?.observation_id;
      if (typeof oid === 'number' && Number.isInteger(oid) && oid > 0) {
        ids.push(oid);
      }
    }
    applyBump(ids, source, opts.onRetrievalBump, obsStore ?? undefined);
  };

  // Local "search everything" → Hit[]. Backs POST /search/all. LOCAL channels only.
  const localSearchAll = async (query: string, topK: number): Promise<Hit[]> => {
    let embedding: number[] = [];
    if (!opts.skipEmbed) {
      try { const out = await embedder.embed([query], 'query'); embedding = out[0] ?? []; }
      catch { /* keyword fallback */ }
    }
    const fused = await searchWithRecency(embedding, query, topK);
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
    return dropArchived(results) as Hit[];
  };

  // Local full-doc lookup → `{ content, metadata }` or null. Backs POST /get_full (local id).
  const localGetFull = (
    docId: string,
  ): { content: string; metadata: Record<string, unknown>; observationMeta: Record<string, unknown> } | null => {
    const result = meta.getChunkById(docId);
    if (!result) return null;
    return {
      content: result.chunk.text,
      metadata: {
        ...result.chunk.metadata,
        ...result.document.metadata,
        source_path: result.document.source_path,
      },
      // The chunk metadata alone (carries observation_id) — used for the retrieval `drill` bump.
      observationMeta: result.chunk.metadata,
    };
  };

  const handler = async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ healthy: true });
      }
      if (req.method === 'GET' && url.pathname === '/test/block' && process.env.CAPTAIN_MEMO_ENABLE_TEST_ENDPOINTS === '1') {
        const ms = Math.min(30_000, Number(url.searchParams.get('ms') ?? 1000));
        const until = Date.now() + ms;
        while (Date.now() < until) { /* deliberately block the engine event loop */ }
        return Response.json({ blocked_ms: ms });
      }
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        // Graceful-stop hook for a supervisor (the Windows Scheduled-Task manager,
        // or `upgrade`/`vacuum` which need SQLite locks released before mutating).
        // Reply first, then exit on the next tick so the response flushes. Stores
        // are WAL-backed and queues persist to disk, so process.exit is safe — the
        // OS releases the file locks and pending work resumes on restart.
        setTimeout(() => process.exit(0), 100);
        return Response.json({ stopping: true });
      }
      if (req.method === 'GET' && url.pathname === '/stats') {
        const { total_chunks, by_channel } = meta.stats();
        const obsTotal = obsStore ? obsStore.countAll() : 0;
        const queuePending = obsQueue ? obsQueue.pendingCount() : 0;
        const queueProcessing = obsQueue ? obsQueue.processingCount() : 0;
        const diskBytes = dirSizeBytes(DATA_DIR);
        const paired = obsStore
          ? obsStore.sumPairedTokens()
          : { work: 0, stored: 0, paired: 0 };
        const efficiency = computeEfficiency({
          workSum: paired.work, storedSum: paired.stored, pairedCount: paired.paired,
          totalObservations: obsTotal,
          metrics,
        });
        const recall = obsStore ? obsStore.getRecallStats(5) : undefined;
        // Tide lifecycle snapshot: enabled flag + relevance floor (the bounded
        // re-rank knob) alongside the persisted lifecycle tallies.
        const tide = obsStore
          ? {
              enabled: tideConfig.enabled,
              tiering_enabled: tideConfig.tieringEnabled,
              relevance_floor: tideConfig.relevanceFloor,
              ...obsStore.getTideStats(),
            }
          : undefined;
        // Quartermaster snapshot: switch + dedup state and the cosine gate, plus
        // the most recent persisted run (null until a slice has recorded one).
        const qm = {
          enabled: qmConfig.enabled,
          dedup_enabled: qmConfig.dedupEnabled,
          cosine_threshold: qmConfig.dedupCosineThreshold,
          last_run: obsStore?.latestQmRuns(1)[0] ?? null,
        };
        // Dream-stats path: cheap precursor diagnostics from the audit log.
        // Audit-log path mirrors the writer in recall-audit.ts (same env-var
        // override semantics) so a custom CAPTAIN_MEMO_DATA_DIR is honored.
        const auditLogPath = (() => {
          const dir = process.env.CAPTAIN_MEMO_DATA_DIR ?? DATA_DIR;
          return `${dir}/recall-audit.jsonl`;
        })();
        const dream = await getDreamStats(auditLogPath).catch(() => undefined);
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
          disk: { bytes: diskBytes, path: DATA_DIR },
          efficiency,
          recall,
          tide,
          qm,
          dream,
          version: VERSION,
          worker: {
            started_at_epoch: workerStartedAtEpoch,
            uptime_s: Math.floor(Date.now() / 1000) - workerStartedAtEpoch,
          },
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

      // Sunk-tier listing for `captain-memo memory --show-archived/--ebbed` (and the
      // restore flow). Read-only; available on readers too.
      if (req.method === 'GET' && url.pathname === '/observations/by-tide-state') {
        if (!obsStore) return Response.json({ items: [] });
        const raw = url.searchParams.get('state');
        const state = raw === 'dormant' || raw === 'archived' ? raw : null;
        if (!state) return Response.json({ error: 'invalid_request', detail: "state must be 'dormant' or 'archived'" }, { status: 400 });
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 50) || 50));
        return Response.json({ items: obsStore.listByTideState(state, limit) });
      }

      // Server-side table for `captain-memo top`: sort/filter/page/collapse.
      if (req.method === 'GET' && url.pathname === '/recall/list') {
        if (!obsStore) return Response.json({ rows: [], total: 0 });
        const sp = url.searchParams;
        const oneOf = <T extends string>(v: string | null, allowed: readonly T[], def: T): T =>
          (v !== null && (allowed as readonly string[]).includes(v)) ? v as T : def;
        const view = oneOf<RecallView>(sp.get('view'), ['surfaced', 'recalled', 'recent'], 'surfaced');
        const sort = oneOf<RecallSort>(sp.get('sort'), ['total', 'auto', 'search', 'drill', 'recency'], 'total');
        const limit = Math.max(1, Math.min(500, Number(sp.get('limit') ?? 50) || 50));
        const offset = Math.max(0, Number(sp.get('offset') ?? 0) || 0);
        const collapse = sp.get('collapse') === '1' || sp.get('collapse') === 'true';
        const qy: RecallQuery = { view, sort, limit, offset, collapse };
        const type = sp.get('type'); if (type) qy.type = type;
        const q = sp.get('q'); if (q) qy.q = q;
        return Response.json(obsStore.queryRecall(qy));
      }

      // Full observation for a `top` drill-in. Counts as a /get_full-style
      // drill: bumps from_drill so inspecting memory via `top` is self-measuring.
      if (req.method === 'GET' && url.pathname === '/observation/full') {
        if (!obsStore) return Response.json({ error: 'not_found' }, { status: 404 });
        const id = Number(url.searchParams.get('id'));
        if (!Number.isInteger(id) || id <= 0) {
          return Response.json({ error: 'invalid_request' }, { status: 400 });
        }
        const obs = obsStore.findById(id);
        if (!obs || obs.archived) {
          return Response.json({ error: 'not_found' }, { status: 404 });
        }
        applyBump([id], 'drill', opts.onRetrievalBump, obsStore);
        return Response.json({ observation: obs });
      }
      if (req.method === 'POST' && url.pathname === '/search/all') {
        const parsed = SearchRequestSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const { query, top_k } = parsed.data;
        const visible = await localSearchAll(query, top_k);
        const by_channel: Record<string, number> = {};
        for (const r of visible) by_channel[r.channel] = (by_channel[r.channel] ?? 0) + 1;
        bumpRetrievalFromResults(visible, 'search');
        return Response.json({ results: visible, by_channel });
      }
      if (req.method === 'POST' && url.pathname === '/search/memory') {
        const parsed = MemorySearchSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const filters: ChannelFilters = {};
        if (parsed.data.type !== undefined) filters.memory_type = parsed.data.type;
        const results = dropArchived(await searchByChannel(parsed.data.query, 'memory', parsed.data.top_k, filters));
        // Memory hits are not observations and carry no observation_id, so
        // this is a defensive no-op for shape consistency — keeps every
        // /search/* endpoint following the same "always bump" contract.
        bumpRetrievalFromResults(results, 'search');
        return Response.json({ results });
      }

      if (req.method === 'POST' && url.pathname === '/search/skill') {
        const parsed = SkillSearchSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const filters: ChannelFilters = {};
        if (parsed.data.skill_id !== undefined) filters.skill_id = parsed.data.skill_id;
        const results = dropArchived(await searchByChannel(parsed.data.query, 'skill', parsed.data.top_k, filters));
        bumpRetrievalFromResults(results, 'search');
        return Response.json({ results });
      }

      if (req.method === 'POST' && url.pathname === '/search/observations') {
        const raw = await req.json();
        // Test-only: a READ-classified endpoint that blocks the serving engine's
        // event loop, so the reader-pool integration test can prove a search burst
        // stalls the SINGLE engine (degrading /health) but NOT the writer once reads
        // are offloaded to readers. Gated behind the same flag as /test/block.
        if (
          process.env.CAPTAIN_MEMO_ENABLE_TEST_ENDPOINTS === '1' &&
          raw && typeof raw === 'object' && typeof (raw as { block_ms?: unknown }).block_ms === 'number'
        ) {
          const ms = Math.min(30_000, (raw as { block_ms: number }).block_ms);
          const until = Date.now() + ms;
          while (Date.now() < until) { /* deliberately block the serving engine */ }
          return Response.json({ results: [], blocked_ms: ms });
        }
        const parsed = ObservationSearchSchema.safeParse(raw);
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const filters: ChannelFilters = {};
        if (parsed.data.type !== undefined) filters.obs_type = parsed.data.type;
        if (parsed.data.files !== undefined) filters.files = parsed.data.files;
        const results = dropArchived(await searchByChannel(parsed.data.query, 'observation', parsed.data.top_k, filters));
        bumpRetrievalFromResults(results, 'search');
        return Response.json({ results });
      }

      if (req.method === 'POST' && url.pathname === '/get_full') {
        const parsed = GetFullSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const result = localGetFull(parsed.data.doc_id);
        if (!result) {
          return Response.json({ error: 'not_found' }, { status: 404 });
        }
        // /get_full is the strongest "this observation was useful" signal —
        // the caller asked for the whole content, not just a snippet.
        bumpRetrievalFromResults([{ metadata: result.observationMeta }], 'drill');
        return Response.json({
          content: result.content,
          metadata: result.metadata,
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

        // Observation reindex — file-based reindex above doesn't cover the
        // observation channel because observations live in obsStore, not on
        // disk. Batched embeds (32 obs per Voyage call) — per-obs serial
        // embedding is API-latency bound at ~1.7 obs/sec, batched lifts it
        // to ~50 obs/sec. With --force, we drop the old document (cascades
        // meta chunks + FTS), evict orphaned vectors, then re-build chunks.
        // Without --force, observations that already carry the current chunk
        // shape (single chunk with field_type='observation') are skipped so
        // the reindex is resumable after a crash or interrupt.
        if (obsStore && (parsed.data.channel === 'observation' || parsed.data.channel === 'all')) {
          const OBS_REINDEX_BATCH = 32;
          let buffer: Observation[] = [];

          const flushBatch = async (): Promise<void> => {
            if (buffer.length === 0) return;
            const batch = buffer;
            buffer = [];

            // Build chunks for every obs in the batch up front; track which
            // index of the flat texts array maps to which observation.
            interface Prepared {
              obs: Observation;
              sourcePath: string;
              chunksWithIds: Array<{ chunk_id: string; text: string; sha: string; position: number; metadata: Record<string, unknown> }>;
              oldChunkIds: string[];
            }
            const prepared: Prepared[] = [];
            for (const obs of batch) {
              const sourcePath = `observation:${opts.projectId}:${obs.id}`;
              // --force: capture the existing chunk ids READ-ONLY here. We must
              // NOT delete vectors/meta yet — embed-then-swap drops the old
              // vectors only after the new ones commit (write loop below), so a
              // failed embed leaves the existing index fully intact.
              let oldChunkIds: string[] = [];
              if (parsed.data.force) {
                const existing = meta.getDocument(sourcePath);
                if (existing) oldChunkIds = meta.getChunksForDocument(existing.id).map(c => c.chunk_id);
              }
              const rawChunks = chunkObservation(obs);
              if (rawChunks.length === 0) {
                skipped++;
                continue;
              }
              const chunks = splitForEmbed(rawChunks, effectiveMaxInputTokens);
              const chunksWithIds = chunks.map(c => ({
                chunk_id: newChunkId('observation', String(obs.id)),
                text: c.text,
                sha: sha256Hex(c.text),
                position: c.position,
                metadata: c.metadata,
              }));
              prepared.push({ obs, sourcePath, chunksWithIds, oldChunkIds });
            }
            if (prepared.length === 0) return;

            // Single embed call for all chunks across the batch.
            const flatTexts = prepared.flatMap(p => p.chunksWithIds.map(c => c.text));
            let flatEmbeddings: number[][] | null = null;
            if (opts.skipEmbed) {
              flatEmbeddings = flatTexts.map(() => new Array(opts.embeddingDimension).fill(0));
            } else {
              try {
                flatEmbeddings = await timedEmbed(flatTexts);
              } catch (err) {
                console.error(`[reindex-obs] batch embed failed (${prepared.length} obs):`, (err as Error).message);
                errors += prepared.length;
                return;
              }
            }

            // Distribute embeddings back to each observation's chunks and
            // commit meta + vector writes.
            let cursor = 0;
            for (const p of prepared) {
              const n = p.chunksWithIds.length;
              const obsEmbeddings = flatEmbeddings!.slice(cursor, cursor + n);
              cursor += n;
              const pStoredTokens = p.chunksWithIds.reduce((n, c) => n + countTokens(c.text), 0);
              obsStore?.setStoredTokens(p.obs.id, pStoredTokens);
              try {
                const documentId = meta.upsertDocument({
                  source_path: p.sourcePath,
                  channel: 'observation',
                  project_id: opts.projectId,
                  sha: sha256Hex(JSON.stringify(p.obs)),
                  mtime_epoch: p.obs.created_at_epoch,
                  metadata: {
                    observation_id: p.obs.id,
                    session_id: p.obs.session_id,
                    type: p.obs.type,
                    title: p.obs.title,
                    created_at_epoch: p.obs.created_at_epoch,
                    branch: p.obs.branch ?? null,
                  },
                });
                meta.replaceChunksForDocument(documentId, p.chunksWithIds);
                await vector.add(
                  collectionName,
                  p.chunksWithIds.map((c, i) => ({ id: c.chunk_id, embedding: obsEmbeddings[i]! })),
                );
                // Embed-then-swap: now that the fresh vectors are committed, drop
                // the old vectors that the new chunk set no longer covers. doc id
                // is preserved (upsertDocument updates in place by source_path,
                // replaceChunksForDocument swaps meta chunks), so no deleteDocument.
                const stale = p.oldChunkIds.filter(id => !p.chunksWithIds.some(c => c.chunk_id === id));
                if (stale.length > 0) await vector.delete(collectionName, stale);
                indexed++;
              } catch (err) {
                console.error(`[reindex-obs] obs#${p.obs.id} write failed:`, (err as Error).message);
                errors++;
              }
            }
          };

          for (const obs of obsStore.iterateAll()) {
            // Resumability: without --force, skip observations already on the
            // current chunk shape so re-running picks up where it left off.
            if (!parsed.data.force) {
              const existing = meta.getDocument(`observation:${opts.projectId}:${obs.id}`);
              if (existing) {
                const chunks = meta.getChunksForDocument(existing.id);
                if (chunks.length === 1 && (chunks[0]!.metadata as Record<string, unknown>).field_type === 'observation') {
                  skipped++;
                  continue;
                }
              }
            }
            buffer.push(obs);
            if (buffer.length >= OBS_REINDEX_BATCH) await flushBatch();
          }
          await flushBatch();
        }

        return Response.json({ indexed, skipped, errors });
      }

      if (req.method === 'POST' && url.pathname === '/remember') {
        const parsed = RememberSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const d = parsed.data;

        // Semantic-dedup query: cosine over the memory channel, scoped to `dir` by
        // source_path prefix (the chunker stamps document.source_path = the .md path).
        // Distance → similarity so the score compares against dedupThreshold directly.
        const searchMemory: WriteMemoryDeps['searchMemory'] = async (queryEmbedding, dir, k) => {
          if (opts.skipEmbed || queryEmbedding.length === 0) return [];
          const raw = await vector.query(collectionName, queryEmbedding, Math.max(k * 5, 20));
          const hits: Array<{ source_path: string; score: number; chunk_id: string }> = [];
          for (const r of raw) {
            const lookup = meta.getChunkById(r.id);
            if (!lookup || lookup.document.channel !== 'memory') continue;
            if (!lookup.document.source_path.startsWith(dir)) continue;
            hits.push({ source_path: lookup.document.source_path, score: 1 - r.distance, chunk_id: r.id });
            if (hits.length >= k) break;
          }
          return hits;
        };

        const deps: WriteMemoryDeps = {
          ingest,
          embed: (texts) => embedder.embed(texts),
          searchMemory,
          registerSelfWrite,
          rememberDir: process.env[ENV_REMEMBER_DIR] ?? DEFAULT_REMEMBER_DIR,
          dedupThreshold: Number(process.env[ENV_REMEMBER_DEDUP_THRESHOLD] ?? DEFAULT_REMEMBER_DEDUP_THRESHOLD),
          // Omit `generate` when no transport is configured so writeMemory takes its
          // deterministic frontmatter fallback (name=first line, description=truncated body).
          ...(opts.summarizerTransport !== undefined && { generate: opts.summarizerTransport }),
        } as WriteMemoryDeps;

        const input: RememberInput = {
          body: d.body,
          type: d.type,
          ...(d.name !== undefined && { name: d.name }),
          ...(d.description !== undefined && { description: d.description }),
          ...(d.slug !== undefined && { slug: d.slug }),
          projectContext: { ...(d.cwd !== undefined && { cwd: d.cwd }) },
          ...(d.sourceObservationId !== undefined && { sourceObservationId: d.sourceObservationId }),
          ...(d.targetDirOverride !== undefined && { targetDirOverride: d.targetDirOverride }),
        };

        const result = await writeMemory(input, deps);
        return Response.json(result, { status: result.ok ? 200 : 500 });
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

        const fused = await searchWithRecency(embedding, trimmed, parsed.data.top_k * 3);
        const channelsRequested: Array<'memory' | 'skill' | 'observation'> =
          parsed.data.channels ?? ['memory', 'skill', 'observation'];
        const candidates: import('../shared/types.ts').EnvelopeHit[] = [];
        for (const f of fused) {
          const lookup = meta.getChunkById(f.id);
          if (!lookup) continue;
          if (!channelsRequested.includes(lookup.document.channel as 'memory' | 'skill' | 'observation')) continue;
          const m = lookup.chunk.metadata as Record<string, unknown>;
          candidates.push({
            doc_id: lookup.chunk.chunk_id,
            channel: lookup.document.channel,
            source_path: lookup.document.source_path,
            title: (m.section_title ?? m.filename_id ?? m.title ?? 'Untitled') as string,
            snippet: lookup.chunk.text.slice(0, 600),
            score: f.score,
            metadata: m,
          });
        }
        // Drop archived (dedup-folded) AND sunk (Tide dormant/archived) observations
        // BEFORE taking top_k, so neither a folded dup nor an ebbed row consumes a slot
        // a live observation should fill. Sunk rows stay reachable via explicit /search.
        const hits = dropSunkForAutoInject(dropArchived(candidates)).slice(0, parsed.data.top_k);

        // Fire-and-forget recall audit (default-off; enable via CAPTAIN_MEMO_RECALL_AUDIT=1).
        // fused already carries .boosts from applyBoosts (BoostedItem); build a
        // lookup so we can attach provenance to each hit without a second scan.
        {
          type BoostedProvenance = { identifier?: number; branch?: number } | undefined;
          const fusedBoostMap = new Map<string, BoostedProvenance>(
            fused.map(f => [f.id, (f as { id: string; boosts?: BoostedProvenance }).boosts]),
          );
          const rawPrompt = parsed.data.prompt;
          void writeRecallAuditLine({
            ts: Date.now(),
            session_id: parsed.data.session_id ?? 'unknown',
            project_id: parsed.data.project_id ?? opts.projectId,
            query: trimmed,
            ...(rawPrompt !== trimmed && { prompt: rawPrompt }),
            hits: hits.map(h => {
              const boosts = fusedBoostMap.get(h.doc_id);
              return {
                doc_id: h.doc_id,
                channel: h.channel,
                score: h.score,
                snippet: h.snippet.slice(0, 200),
                ...(boosts && Object.keys(boosts).length > 0 && { boosts }),
              };
            }),
          });
        }

        // Bump from_auto on every observation surfaced through the auto-
        // injection path. This is the dominant retrieval path in production
        // (fires on every UserPromptSubmit), so without it the recall stats
        // are starved — pre-v5 this gap is exactly why the corpus showed
        // ~0% recalled despite continuous use.
        bumpRetrievalFromResults(hits, 'auto');

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
        const { branch, source, ...rest } = parsed.data;
        const id = obsQueue.enqueue({
          ...rest,
          branch: branch ?? null,
          ...(source !== undefined && { source }),
        });
        return Response.json({ id, queued: true });
      }

      // Per-row reversal: re-surface a sunk (dormant/archived) observation to active.
      // Writer-only — readers have no obsStore and 503 automatically.
      if (req.method === 'POST' && url.pathname === '/observation/restore') {
        if (!obsStore) return Response.json({ error: 'observation_pipeline_disabled' }, { status: 503 });
        const parsed = RestoreSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const result = obsStore.restoreObservation(parsed.data.id, Math.floor(Date.now() / 1000));
        return Response.json({ id: parsed.data.id, result, restored: result === 'restored' });
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

  const stopResources = async () => {
    if (tickTimer) clearInterval(tickTimer);
    if (tideSweepTimer) clearInterval(tideSweepTimer);
    if (qmDedupTimer) clearInterval(qmDedupTimer);
    if (pendingTickTimer) clearInterval(pendingTickTimer);
    if (watcher) await watcher.close();
    if (obsQueue) obsQueue.close();
    if (obsStore) obsStore.close();
    if (pendingEmbed) pendingEmbed.close();
    vector.close();
    meta.close();
  };

  if (opts.noServe) {
    // Engine-thread mode: no port bound; the engine serves `handler` over the channel.
    return {
      port: opts.port,
      handler,
      ...(obsStore ? { store: obsStore } : {}),
      stop: stopResources,
    };
  }

  const server = Bun.serve({
    port: opts.port,
    // Loopback ONLY — the unauthenticated worker API must never be reachable off-box.
    hostname: '127.0.0.1',
    fetch: handler,
  });

  return {
    port: server.port ?? opts.port,
    handler,
    ...(obsStore ? { store: obsStore } : {}),
    stop: async () => { server.stop(true); await stopResources(); },
  };
}

/** Build WorkerOptions from process.env. Shared by the inline path (runWorkerCli) and
 *  the engine thread (engine.ts) so both boot identically. The caller adds `noServe`. */
export async function buildWorkerOptionsFromEnv(): Promise<WorkerOptions> {
  const port = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
  const projectId = process.env.CAPTAIN_MEMO_PROJECT_ID ?? 'default';
  const embedderEndpoint = process.env.CAPTAIN_MEMO_EMBEDDER_ENDPOINT ?? DEFAULT_VOYAGE_ENDPOINT;
  const embedderModel = process.env.CAPTAIN_MEMO_EMBEDDER_MODEL ?? 'voyageai/voyage-4-nano';
  const embedderApiKey = process.env.CAPTAIN_MEMO_EMBEDDER_API_KEY;
  // 'aelita' speaks the {texts, input_type} + x-aelita-token shape used by
  // Aelita's internal embedder VM; 'openai' (default) speaks the standard
  // {input, model, input_type} + Bearer-auth shape used by Voyage hosted,
  // OpenAI, OpenRouter, Ollama, etc. Anything else falls back to 'openai'.
  const embedderApiFormatRaw = (process.env.CAPTAIN_MEMO_EMBEDDER_API_FORMAT ?? 'openai').toLowerCase();
  const embedderApiFormat: 'openai' | 'aelita' = embedderApiFormatRaw === 'aelita' ? 'aelita' : 'openai';
  // Override knob for users running an embedder we don't know about. When
  // unset, startWorker falls back to embedderMaxTokens(model) — a per-model
  // table that defaults to a conservative 512 for unknown models.
  const embedderMaxInputTokensRaw = process.env.CAPTAIN_MEMO_EMBEDDER_MAX_TOKENS;
  const embedderMaxInputTokens = embedderMaxInputTokensRaw
    ? Number(embedderMaxInputTokensRaw)
    : undefined;
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
  let summarizerTransport: import('./summarizer.ts').SummarizerTransport | undefined;
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
      summarizerTransport = summarizer.getTransport();
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
    summarizerTransport = summarizer.getTransport();
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
      summarizerTransport = summarizer.getTransport();
      console.error(`[worker] summarizer provider = openai-compatible (${endpoint})${apiKey ? ' [auth]' : ' [no auth]'}`);
    }
  } else if (anthropicKey) {
    const summarizer = new Summarizer({
      apiKey: anthropicKey,
      model: summarizerModel,
      fallbackModels: summarizerFallbacks,
    });
    summarize = (events) => summarizer.summarize(events);
    summarizerTransport = summarizer.getTransport();
    console.error(`[worker] summarizer provider = anthropic (Anthropic API key)`);
  } else {
    console.error(
      `[worker] observation summarizer disabled — set one of:\n` +
      `         - ${ENV_SUMMARIZER_PROVIDER}=claude-code        (Max/Pro plan, no key)\n` +
      `         - ${ENV_SUMMARIZER_PROVIDER}=openai-compatible  + ${ENV_OPENAI_ENDPOINT} (Ollama / LM Studio / OpenAI / etc.)\n` +
      `         - ${ENV_ANTHROPIC_API_KEY}=sk-...                (direct Anthropic API)`
    );
  }

  return {
    port,
    projectId,
    metaDbPath: META_DB_PATH,
    embedderEndpoint,
    embedderModel,
    ...(embedderApiKey !== undefined && { embedderApiKey }),
    embedderApiFormat,
    ...(embedderMaxInputTokens !== undefined && { embedderMaxInputTokens }),
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
    ...(summarizerTransport !== undefined && { summarizerTransport }),
  };
}

// Exported so a `bin/captain-memo-worker` shim can call this explicitly.
// Avoid gating on `import.meta.main` alone: when this file is imported
// (rather than invoked directly), `import.meta.main` is false and the
// startup body would silently no-op.
export async function runWorkerCli(): Promise<void> {
  // Seed process.env from worker.env BEFORE reading any config below. On Linux the
  // systemd unit already injected these via EnvironmentFile (loadWorkerEnv then
  // no-ops, since it never overwrites a set var); on Windows the Scheduled Task
  // launches `bun` with no env injection, so this is the ONLY place secrets load.
  loadWorkerEnv();

  // Windows has no journal: a Scheduled-Task-launched worker runs detached, so its
  // console output would vanish. Tee stdout/stderr to LOGS_DIR/worker.log so doctor
  // and the user can diagnose. No-op on Linux (systemd journals stdout). Best-effort.
  if (process.platform === 'win32') {
    try {
      const { createWriteStream, mkdirSync: mkdir } = await import('fs');
      const { LOGS_DIR } = await import('../shared/paths.ts');
      mkdir(LOGS_DIR, { recursive: true });
      const logStream = createWriteStream(join(LOGS_DIR, 'worker.log'), { flags: 'a' });
      const tee = (orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
        try { logStream.write(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n'); } catch { /* ignore */ }
        orig(...args);
      };
      console.log = tee(console.log.bind(console)) as typeof console.log;
      console.error = tee(console.error.bind(console)) as typeof console.error;
    } catch { /* logging is best-effort; never block startup */ }
  }

  const { mkdirSync } = await import('fs');
  const { dirname } = await import('path');
  const { DATA_DIR } = await import('../shared/paths.ts');

  // Ensure data directories exist on first run — every store opens a SQLite
  // file inside DATA_DIR, and bun:sqlite won't create missing parent dirs.
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(VECTOR_DB_DIR, { recursive: true });
  mkdirSync(dirname(META_DB_PATH), { recursive: true });
  // DATA_DIR holds the secret-bearing meta DB → owner-only traversal (0700). Best-effort; never blocks
  // boot. (The meta DB file itself is additionally chmod'd 0600 in startWorker.)
  chmodSecret(DATA_DIR, 0o700);

  const port = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
  if (process.env.CAPTAIN_MEMO_WORKER_THREADED === '1') {
    const { startThreadedWorker } = await import('./threaded-main.ts');
    // startThreadedWorker logs its own "listening … (threaded: …)" line on success, or a
    // single-threaded-fallback line if the engine can't come up — so the message always
    // reflects the path that actually bound the port.
    const handle = await startThreadedWorker(port);
    const shutdown = async () => { await handle.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  const opts = await buildWorkerOptionsFromEnv();
  const handle = await startWorker(opts);
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
