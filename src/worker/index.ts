import { join } from 'path';
import { statSync, readdirSync, chmodSync, existsSync } from 'node:fs';
import { detectBranchSyncCached } from './branch.ts';
import { z } from 'zod';
import { MetaStore } from './meta.ts';
import { Embedder } from './embedder.ts';
import { embedderMaxTokens } from '../shared/embedder-limits.ts';
import { loadWorkerEnv } from '../shared/worker-env.ts';
import { resolveSummarizerProvider } from '../shared/summarizer-provider.ts';
import { loadGatewayConfig, verifyToken } from '../shared/gateway-tokens.ts';
import { dispatchTool, TOOLS } from '../mcp-server.ts';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { VectorStore } from './vector-store.ts';
import { HybridSearcher } from './search.ts';
import { IngestPipeline } from './ingest.ts';
import { writeMemory, type WriteMemoryDeps, type RememberInput } from './memory-writer.ts';
import { discoverMemoryGlobs } from '../shared/ai-memory-sources.ts';
import { FileWatcher } from './watcher.ts';
import { ObservationQueue } from './observation-queue.ts';
import { ObservationsStore } from './observations-store.ts';
import type { RecallQuery, RecallView, RecallSort } from './observations-store.ts';
import { loadTideConfig, computeBuoyancy, tideMultiplier } from './tide.ts';
import { runTideSweepSlice } from './tide-sweep.ts';
import { loadQmConfig } from './qm.ts';
import { loadPromotionConfig } from './promotion-config.ts';
import { runPromotionSlice, type PromotionDeps } from './promotion.ts';
import { buildPromotionJudge } from './promotion-judge.ts';
import { runQmDedupSlice } from './quartermaster.ts';
import { runQmSupersedeSlice, applySupersedeDemotion } from './supersede.ts';
import { setWorkNote, listLocalActive, clearWorkNote, overlapsAgainst, repoOverlapsAgainst, groupRepoContention, repoActiveHolders, type SetWorkNoteInput } from './work-notes.ts';
import { resolveRepoClaim } from './repo-claim.ts';
import { warmWorknoteVecs, semanticOverlapPass, hasIntent, SEMANTIC_ENABLED } from './worknote-semantic.ts';
import { centroid } from '../shared/vector-math.ts';
import { PendingEmbedQueue } from './pending-embed-queue.ts';
import { chunkObservation } from './chunkers/observation.ts';
import { splitForEmbed } from './chunkers/safe-split.ts';
import { EmbedderInputTooLarge } from './embedder.ts';
import { newChunkId } from '../shared/id.ts';
import { sha256Hex } from '../shared/sha.ts';
import { ORIGIN_AGENTS, UNKNOWN_ORIGIN_AGENT } from '../shared/origin-agent.ts';
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
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_FALLBACKS,
  DEFAULT_AGY_MODEL,
  DEFAULT_AGY_FALLBACKS,
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
import { resolveRankConfig, type RankConfig } from './search-config.ts';
import { applyTemporalRerank } from './temporal-intent.ts';
import { getDreamStats } from './dream-stats.ts';
import { Summarizer, type SummarizerTransport } from './summarizer.ts';
import { classifySummarizeFailure, computeBackoffMs } from './summarizer-backoff.ts';
import { CaptureState } from './capture/state.ts';
import { createCodexSource } from './capture/codex-source.ts';
import { createAgySource } from './capture/agy-source.ts';
import { createGeminiSource } from './capture/gemini-source.ts';
import { createKimiSource } from './capture/kimi-source.ts';
import { createOpencodeSource } from './capture/opencode-source.ts';
import { runCaptureTick } from './capture/driver.ts';
import { createWorkerMetrics, recordEmbed, recordIndexResult } from './metrics.ts';
import { computeEfficiency } from './efficiency.ts';
import { countTokens } from '../shared/tokens.ts';
import { VERSION } from '../shared/version.ts';
import { EDITION } from '../shared/edition.ts';

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
  /** Override for the gateway.json path — defaults to env/home-derived. Test isolation point. */
  gatewayConfigPath?: string;
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
  rank_profile: z.enum(['legacy', 'v2']).optional(),
});

const MemorySearchSchema = z.object({
  query: z.string(),
  type: z.enum(['user', 'feedback', 'project', 'reference']).optional(),
  project: z.string().optional(),
  top_k: z.number().int().positive().max(50).default(5),
  rank_profile: z.enum(['legacy', 'v2']).optional(),
});

const SkillSearchSchema = z.object({
  query: z.string(),
  skill_id: z.string().optional(),
  top_k: z.number().int().positive().max(50).default(3),
  rank_profile: z.enum(['legacy', 'v2']).optional(),
});

const ObservationSearchSchema = z.object({
  query: z.string(),
  type: z.enum(['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change']).optional(),
  files: z.array(z.string()).optional(),
  since: z.string().optional(),
  project: z.string().optional(),
  top_k: z.number().int().positive().max(50).default(5),
  rank_profile: z.enum(['legacy', 'v2']).optional(),
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
  // Vendor provenance: which AI agent captured this event. Optional + closed
  // enum; `.catch(undefined)` means an absent OR non-conforming value (wrong
  // type, unrecognized string, null, etc.) both resolve to undefined here, so
  // the field is simply omitted from the enqueued payload rather than 400ing
  // the whole request. Downstream (the chunker) renders that as 'unknown'.
  origin_agent: z.enum([...ORIGIN_AGENTS]).optional().catch(undefined),
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
  rank_profile: z.enum(['legacy', 'v2']).optional(),
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

  // The embedder's actual output dim, measured by the boot probe below. Surfaced
  // in /stats so `doctor` can compare it against the index dim (opts.embeddingDimension)
  // and flag a mismatch — the trap that silently blocks every write.
  let probedEmbedderDim: number | null = null;

  // Boot-time dim probe — catch the dim-mismatch trap (where vector store
  // expects N but embedder returns M) BEFORE any chunk hits vector.add().
  // Skip when the user opted into keyword-only mode.
  if (!opts.skipEmbed) {
    try {
      const probe = await embedder.embed(['probe']);
      const actualDim = probe[0]?.length ?? 0;
      probedEmbedderDim = actualDim || null;
      if (actualDim !== opts.embeddingDimension) {
        console.error(
          `[worker] DIM MISMATCH: the vector index is ${opts.embeddingDimension}-dim but the embedder returns ${actualDim}-dim. ` +
          `Every write (remember) will fail and vector search silently falls back to keyword-only. ` +
          `Fix: run \`captain-memo reindex --redim ${actualDim}\` — it rebuilds the index at the embedder's dimension ` +
          `(re-embedding from observations.db). Setting CAPTAIN_MEMO_EMBEDDING_DIM alone will NOT fix an existing index. ` +
          `Alternatively, switch back to a model that returns ${opts.embeddingDimension}-dim.`,
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
  const promotionConfig = loadPromotionConfig(process.env);
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
      // dot:true — repo-level rules live in HIDDEN dirs (.claude/, .github/, .cursor/).
      // Without it `~/projects/*/.claude/CLAUDE.md` silently matches ZERO files.
      for await (const file of glob.scan({ absolute: true, onlyFiles: true, dot: true })) {
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

  // Semantic-dedup query for the writer engine, shared by POST /remember and the
  // promotion timer. Cosine over the memory channel, scoped to `dir` by source_path
  // prefix; distance → similarity so the score compares against dedupThreshold.
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
        origin_agent: obs.origin_agent ?? UNKNOWN_ORIGIN_AGENT,
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

  // Stale-while-revalidate /stats cache + in-flight dedup: `top` polls /stats every ~2s
  // and it's expensive (recall scans, dream digest, tide counts). A cached snapshot is
  // served instantly; once it's older than STATS_CACHE_MS the next poll still gets the
  // cached body and triggers a background refresh, so an idle poll never blocks on the
  // recompute. Concurrent requests share one computation. The cache is INVALIDATED on
  // the mutations /stats reports (obs created below, retrieval bumps elsewhere) → a
  // write nulls the cache, so the next read blocks on a fresh compute: read-your-writes
  // stays exact, and a "stale" (un-nulled) cache means no mutation happened, so its
  // counts are still correct — only soft fields (uptime, disk, dream) drift a poll.
  const STATS_CACHE_MS = Number(process.env.CAPTAIN_MEMO_STATS_CACHE_MS ?? 5000);
  let statsCache: { at: number; body: unknown } | null = null;
  let statsInflight: Promise<unknown> | null = null;
  let statsInflightGen = -1; // the generation the in-flight compute captured at kickoff
  // Generation counter, bumped on every invalidation. A compute reads its counts, then
  // yields at `await getDreamStats`; if a write lands during that yield it nulls the cache
  // and bumps the gen. The resolving compute (a) only writes the cache when its captured
  // gen still matches (never resurrects pre-write counts over the null), and (b) is never
  // reused by a post-write reader — a nulled cache with only a stale-gen compute in flight
  // starts a FRESH current-gen compute, so read-your-writes stays exact.
  let statsGen = 0;
  const invalidateStats = () => { statsCache = null; statsGen++; };

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
          origin_agent: head.origin_agent ?? null,
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

    if (observations_created > 0) invalidateStats(); // new obs → /stats counts changed
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

  // Cross-AI capture: on by default. Ingest FINISHED codex/agy sessions on this
  // host into the obs pipeline (they have no hooks; we read the transcripts they
  // persist to disk). First tick seeds a per-source cutoff so pre-existing history
  // isn't summarized in bulk; only sessions finished after enable are captured.
  let captureTimer: ReturnType<typeof setInterval> | null = null;
  // Exposed to the /capture/backfill handler: runs one tick that IGNORES the cutoff,
  // so `captain-memo capture backfill` can ingest pre-cutoff history on demand.
  let captureBackfill: (() => { ingested: number; events: number }) | null = null;
  const captureSourceIds: string[] = [];
  if (!opts.readOnly && obsQueue && obsStore && summarize) {
    const captureQueue = obsQueue;
    const captureSources = [
      createCodexSource({ projectId: opts.projectId }),
      createAgySource({ projectId: opts.projectId }),
      createGeminiSource({ projectId: opts.projectId }),
      createKimiSource({ projectId: opts.projectId }),
      createOpencodeSource({ projectId: opts.projectId }),
    ].filter(s => s.available() && s.enabled());
    if (captureSources.length > 0) {
      const captureState = new CaptureState(join(DATA_DIR, 'capture-state.db'));
      captureSourceIds.push(...captureSources.map(s => s.id));
      const runTick = (ignoreCutoff: boolean): { ingested: number; events: number } => {
        try {
          const r = runCaptureTick({
            sources: captureSources,
            state: captureState,
            enqueue: (ev) => { captureQueue.enqueue(ev); },
            log: (m) => console.log(m),
            ignoreCutoff,
          });
          if (r.ingested > 0) console.log(`[capture] ingested ${r.ingested} session(s), ${r.events} event(s)${ignoreCutoff ? ' (backfill)' : ''}`);
          return r;
        } catch (err) {
          console.error('[capture-tick]', (err as Error).message);
          return { ingested: 0, events: 0 };
        }
      };
      captureBackfill = () => runTick(true);
      const captureTickMs = Number(process.env.CAPTAIN_MEMO_CAPTURE_TICK_MS ?? 60_000);
      runTick(false); // seed cutoffs at boot (ingests nothing pre-existing)
      captureTimer = setInterval(() => runTick(false), captureTickMs);
      console.error(`[worker] cross-AI capture on: ${captureSourceIds.join(', ')} (tick ${Math.round(captureTickMs / 1000)}s)`);
    }
  }

  // Pre-warm the Dreams co-retrieval digest at boot (fire-and-forget) so the FIRST
  // /stats doesn't block ~1.4s digesting a large recall-audit.jsonl from offset 0
  // (it's incremental after that). Never blocks startup; audit-off is a no-op.
  if (!opts.readOnly) {
    getDreamStats(`${process.env.CAPTAIN_MEMO_DATA_DIR ?? DATA_DIR}/recall-audit.jsonl`)
      .catch(() => { /* audit off / unreadable — the first /stats will handle it */ });
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

  // Shared representative-vector accessor: centroid of an observation's chunk vectors.
  // Used by both QM auto-dedup and the P3 supersede sweep.
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

  // Quartermaster auto-dedup (opt-in, OFF by default). Sibling of the tide sweep:
  // each slice pulls a bounded candidate window of near-dup observations, confirms
  // each fold behind a cosine ≥ threshold check against the survivor's centroid
  // vector (fail-closed when a vector is missing), folds the members, and yields
  // between groups so the heartbeat breathes and queued ingest preempts mid-slice.
  let qmDedupTimer: ReturnType<typeof setInterval> | null = null;
  let qmDedupPromise: Promise<unknown> | null = null;
  if (!opts.readOnly && obsStore && qmConfig.enabled && qmConfig.dedupEnabled) {
    const qmStore = obsStore;
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

  // Quartermaster supersede sweep (P3, opt-in, OFF by default). Sibling of the dedup
  // timer: each slice pulls a bounded window of older→newest version pairs (entityKey-
  // exact, (project,branch)-scoped), confirms each by cosine ≥ threshold against the
  // newer's centroid, skips protected rows, and links the older as superseded — never
  // hiding it (search demotes). Reuses repVec and the same abort/heartbeat discipline.
  let qmSupersedeTimer: ReturnType<typeof setInterval> | null = null;
  let qmSupersedePromise: Promise<unknown> | null = null;
  if (!opts.readOnly && obsStore && qmConfig.enabled && qmConfig.supersedeEnabled) {
    const qmStore = obsStore;
    qmSupersedeTimer = setInterval(() => {
      if (qmSupersedePromise) return;
      const startedAt = Math.floor(Date.now() / 1000);
      qmSupersedePromise = runQmSupersedeSlice({
        candidates: () => qmStore.supersedeCandidateWindow(qmConfig.dedupWindow),
        representativeVector: repVec,
        isProtected: (id) => qmStore.isProtected(id),
        linkSupersede: (older, newer, m) => qmStore.linkSupersede(older, newer, m),
        shouldAbort: () => processBatchPromise != null || (obsQueue?.pendingCount() ?? 0) > 0,
        cfg: qmConfig,
        now: () => Math.floor(Date.now() / 1000),
        yieldToLoop: () => new Promise<void>(r => setImmediate(r)),
      })
        .then(r => {
          qmStore.recordQmRun({ job: 'supersede', startedAt, finishedAt: Math.floor(Date.now() / 1000),
            rowsScanned: r.scanned, merges: r.linked, skippedNoVector: r.skippedNoVector,
            abortedForIngest: r.aborted, errored: false });
          if (r.linked > 0) console.error(`[qm-supersede] linked ${r.linked} stale fact(s)` + (r.aborted ? ' (aborted for ingest)' : ''));
        })
        .catch(err => {
          qmStore.recordQmRun({ job: 'supersede', startedAt, finishedAt: Math.floor(Date.now() / 1000),
            rowsScanned: 0, merges: 0, skippedNoVector: 0, abortedForIngest: false, errored: true });
          console.error('[qm-supersede] ERROR', err);
        })
        .finally(() => { qmSupersedePromise = null; });
    }, qmConfig.dedupIntervalMs);
  }

  // Promotion (opt-in, OFF by default). Sibling of the Quartermaster auto-dedup
  // timer: each tick pulls a bounded window of durable, high-signal, not-yet-promoted
  // observations, runs ONE judge pass deciding curated-worthy vs ephemeral, writes
  // survivors into curated memory via the shared writeMemory() (NO cwd ⇒ rememberDir),
  // and marks each promoted so a re-run never re-promotes it. Skips — not queues — if
  // a prior run is still in flight, and yields if ingest/batch work is active.
  let promotionTimer: ReturnType<typeof setInterval> | null = null;
  let promotionPromise: Promise<unknown> | null = null;
  if (!opts.readOnly && obsStore && opts.summarizerTransport && promotionConfig.enabled) {
    const promoStore = obsStore;
    const transport = opts.summarizerTransport;
    const rememberDir = process.env[ENV_REMEMBER_DIR] ?? DEFAULT_REMEMBER_DIR;
    const dedupThreshold = Number(process.env[ENV_REMEMBER_DEDUP_THRESHOLD]) || DEFAULT_REMEMBER_DEDUP_THRESHOLD;
    const judge = buildPromotionJudge(transport);
    promotionTimer = setInterval(() => {
      if (promotionPromise) return;                                  // skip, not queue
      if (processBatchPromise != null || (obsQueue?.pendingCount() ?? 0) > 0) return; // ingest preempts
      const deps: PromotionDeps = {
        candidates: () => promoStore.promotionCandidates({ limit: promotionConfig.maxPerRun * 4, minRecall: promotionConfig.minRecall }),
        judge,
        writeMemory: (input) => writeMemory(input, {
          ingest,
          embed: (texts) => embedder.embed(texts),
          searchMemory,
          generate: transport,
          registerSelfWrite,
          rememberDir,
          dedupThreshold,
        }),
        markPromoted: (id, at) => promoStore.markPromoted(id, at),
        cfg: promotionConfig,
        now: () => Math.floor(Date.now() / 1000),
        log: (line) => console.error(line),
      };
      promotionPromise = runPromotionSlice(deps)
        .then(r => {
          if (r.promoted > 0 || r.errored > 0) {
            console.error(`[promote] run: scanned ${r.scanned}, promoted ${r.promoted}, skipped ${r.skipped}, errored ${r.errored}`);
          }
        })
        .catch(err => console.error('[promote] ERROR', err))
        .finally(() => { promotionPromise = null; });
    }, promotionConfig.intervalMs);
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
  const searchWithRecency = async (embedding: number[], query: string, k: number, config: RankConfig) => {
    const branchBoostEnabled = process.env.CAPTAIN_MEMO_BRANCH_BOOST !== '0';
    const currentBranch = branchBoostEnabled ? detectBranchSyncCached(process.cwd()) : null;
    const raw = await searcher.search(embedding, query, k, {
      currentBranch,
      rrfK: config.rrfK,
      perStrategyTopK: config.perStrategyTopK,
      fusionMode: config.fusionMode,
      vectorWeight: config.vectorWeight,
      keywordWeight: config.keywordWeight,
      properNounBoost: config.properNounBoost,
      properNounBoostWeight: config.properNounBoostWeight,
    });
    // Tide (when enabled) re-ranks INSIDE searcher.search, before truncation — so
    // skip the flat recency decay here to avoid double-applying. Disabled ⇒ today's path.
    return tideConfig.enabled ? raw : applyRecencyDecay(raw);
  };

  const searchByChannel = async (
    query: string,
    channel: 'memory' | 'skill' | 'observation',
    topK: number,
    filters: ChannelFilters,
    config: RankConfig,
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
    const fused = await searchWithRecency(embedding, query, candidatePool, config);
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
   * Demote (never drop) hits whose backing observation has been superseded by a newer
   * version (P3). Multiplies their score by `penalty` (<1) and re-sorts. No-op when the
   * penalty is ≥ 1 (legacy/disabled) or nothing in view is superseded. Applied only to
   * observation-bearing surfaces; memory/skill hits carry no observation_id so it is inert
   * there by construction (not wired). Distinct from dropArchived (which hides folded dupes).
   */
  const demoteSuperseded = <T extends { score: number; metadata: Record<string, unknown> }>(
    items: T[], penalty: number,
  ): T[] => {
    if (!obsStore || penalty >= 1 || items.length === 0) return items;
    const ids: number[] = [];
    for (const item of items) {
      const oid = item.metadata?.observation_id;
      if (typeof oid === 'number' && Number.isInteger(oid) && oid > 0) ids.push(oid);
    }
    if (ids.length === 0) return items;
    return applySupersedeDemotion(items, obsStore.supersededAmong(ids), penalty);
  };

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
    invalidateStats(); // retrieval bumps change /stats recall counts — serve fresh next call
  };

  // Local "search everything" → Hit[]. Backs POST /search/all. LOCAL channels only.
  const localSearchAll = async (query: string, topK: number, config: RankConfig): Promise<Hit[]> => {
    let embedding: number[] = [];
    if (!opts.skipEmbed) {
      try { const out = await embedder.embed([query], 'query'); embedding = out[0] ?? []; }
      catch { /* keyword fallback */ }
    }
    const fused = await searchWithRecency(embedding, query, topK, config);
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
    return demoteSuperseded(dropArchived(results), config.supersedePenalty) as Hit[];
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
      // ── Work-coordination board ──────────────────────────────────────────
      // A session publishes a transient "I'm working on X, touching these files" LEASE; concurrent agents on
      // the SAME captain (cross-AI — they all share THIS worker) see it immediately. Notes are kv-backed leases,
      // lazily reaped on read, so a crashed session never leaves a ghost claim.
      if (req.method === 'POST' && url.pathname === '/worknote/set') {
        const body = (await req.json().catch(() => null)) as Partial<SetWorkNoteInput> | null;
        if (!body || typeof body.session_id !== 'string' || body.session_id.trim() === '') {
          return Response.json({ error: 'invalid_request', details: 'session_id required' }, { status: 400 });
        }
        const now = Date.now();
        const setBody = body as SetWorkNoteInput;
        // Enrich a hook-driven generic claim ("editing 3 files") with the session's latest observation TITLE (its
        // human meaning) so the board reads well AND so the semantic pass has real intent to compare. Opt-in only
        // (the PreToolUse hook sets the hint) — an explicit MCP `work_set` `what` is never overwritten. Fail-open.
        const enrichReq = setBody.enrich_from_observations === true;
        let enriched = false;
        if (enrichReq && obsStore) {
          try {
            const latest = obsStore.latestForSession(String(body.session_id));
            if (latest?.title) { setBody.what = latest.title; enriched = true; }
          } catch { /* keep the caller's what */ }
        }
        // The claim carries real declared intent iff it was enriched, OR the caller gave an explicit `what` without
        // asking for enrichment (the MCP work_set path). A hook claim that wasn't enriched (no observation yet) is
        // still the generic placeholder — NOT meaningful, so it stays out of the semantic pass (no false ~1.0 match).
        setBody.meaningful = enriched || !enrichReq;
        // Shared-repo stamp: if the claimed files resolve into a real checkout (not a scratchpad), record
        // repo_root/branch/is_dirty so the board can surface cross-session contention on that working tree.
        const repoClaim = resolveRepoClaim(setBody.files ?? []);
        if (repoClaim.repo_root) {
          setBody.repo_root = repoClaim.repo_root;
          if (repoClaim.branch) setBody.branch = repoClaim.branch;
          if (typeof repoClaim.is_dirty === 'boolean') setBody.is_dirty = repoClaim.is_dirty;
        }
        const note = setWorkNote(meta, setBody, now);
        const others = listLocalActive(meta, now);
        const overlaps = overlapsAgainst(note.files, others, note.session_id);
        // Semantic pass (best-effort, never awaits the embedder): compare meaning vectors already cached, and warm
        // the cache for next time. Catches agents on the SAME intent in DIFFERENT files, which file overlap misses.
        // Only meaningful claims (hasIntent) take part — generic placeholders carry no intent and would false-match.
        if (SEMANTIC_ENABLED && hasIntent(note)) {
          const peers = others.filter((o) => o.session_id !== note.session_id && hasIntent(o));
          warmWorknoteVecs([note.what, ...peers.map((o) => o.what)], (t) => embedder.embed(t));
          const fileSessions = new Set(overlaps.map((o) => o.session_id));
          overlaps.push(...semanticOverlapPass(note, peers, fileSessions));
        }
        return Response.json({ session_id: note.session_id, ttl_s: note.ttl_s, overlaps });
      }
      if (req.method === 'GET' && url.pathname === '/worknote/active') {
        const now = Date.now();
        const claims = listLocalActive(meta, now);
        const mine = url.searchParams.get('session_id') ?? '';
        const mineNote = mine ? claims.find((c) => c.session_id === mine) : undefined;
        const overlaps_with_mine = mineNote
          ? [...overlapsAgainst(mineNote.files, claims, mine), ...repoOverlapsAgainst(mineNote.repo_root, claims, mine)]
          : [];
        const repo_contention = groupRepoContention(claims);
        return Response.json({ claims, overlaps_with_mine, repo_contention });
      }
      if (req.method === 'GET' && url.pathname === '/worknote/repo-active') {
        const now = Date.now();
        const repoRoot = url.searchParams.get('repo_root') ?? '';
        if (!repoRoot) return Response.json({ holders: [] });
        const holders = repoActiveHolders(listLocalActive(meta, now), repoRoot);
        return Response.json({ holders });
      }
      if (req.method === 'POST' && url.pathname === '/worknote/clear') {
        const body = (await req.json().catch(() => null)) as { session_id?: unknown } | null;
        if (!body || typeof body.session_id !== 'string' || body.session_id.trim() === '') {
          return Response.json({ error: 'invalid_request', details: 'session_id required' }, { status: 400 });
        }
        clearWorkNote(meta, body.session_id);
        return Response.json({ ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/stats') {
        // Stale-while-revalidate: serve the cached snapshot instantly and refresh in the
        // background, so an idle `top` poll never blocks on the ~1s recompute. Kick a
        // fresh compute when the cache needs refreshing (missing or past TTL) AND no
        // compute for the CURRENT generation is already in flight — a compute from an
        // older gen started before a write, so its counts are pre-write and must not be
        // reused. Only a MISSING cache (fresh boot / write-invalidated) blocks below, and
        // it always blocks on a current-gen compute, so a reader after a write sees it.
        const statsStale = !statsCache || Date.now() - statsCache.at >= STATS_CACHE_MS;
        if (statsStale && (!statsInflight || statsInflightGen !== statsGen)) {
          const gen = statsGen; statsInflightGen = gen;
          const statsCompute = (async () => {
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
        const supersede = { links: obsStore ? obsStore.supersedeLinkCount() : 0 };
        // Dream-stats path: cheap precursor diagnostics from the audit log.
        // Audit-log path mirrors the writer in recall-audit.ts (same env-var
        // override semantics) so a custom CAPTAIN_MEMO_DATA_DIR is honored.
        const auditLogPath = (() => {
          const dir = process.env.CAPTAIN_MEMO_DATA_DIR ?? DATA_DIR;
          return `${dir}/recall-audit.jsonl`;
        })();
        const dream = await getDreamStats(auditLogPath).catch(() => undefined);
        return {
          total_chunks,
          by_channel,
          observations: {
            total: obsTotal,
            queue_pending: queuePending,
            queue_processing: queueProcessing,
            // Per-AI-source breakdown for the "AI sources" chart (stats + top).
            by_origin: obsStore ? obsStore.countByOrigin() : {},
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
          embedder: { model: opts.embedderModel, endpoint: opts.embedderEndpoint, dim: probedEmbedderDim },
          vector_store: { dim: opts.embeddingDimension },
          disk: { bytes: diskBytes, path: DATA_DIR },
          efficiency,
          recall,
          tide,
          qm,
          supersede,
          dream,
          version: VERSION,
          edition: EDITION,   // 'federation' | 'oss' — surfaced for the SessionStart banner
          // The ACTIVE summarizer, so `captain-memo stats` / doctor can answer "which one is
          // running?" — the RESOLVED provider (post-fallback), which is the ground truth the raw
          // worker.env value can't give (a bad "codex,agy" shows here as its real fallback).
          summarizer: {
            provider: resolveSummarizerProvider(process.env[ENV_SUMMARIZER_PROVIDER]).provider,
            model: process.env[ENV_SUMMARIZER_MODEL] ?? null,
            enabled: summarize !== undefined,
          },
          // Cross-AI capture sources active on this host (codex/agy/gemini/kimi/opencode),
          // so `doctor` / `config show` can report which non-Claude tools feed observations.
          capture: { sources: captureSourceIds },
          worker: {
            started_at_epoch: workerStartedAtEpoch,
            uptime_s: Math.floor(Date.now() / 1000) - workerStartedAtEpoch,
          },
        };
          })().then(
            // Only write the cache if no invalidation happened while this ran, and only
            // clear the single-flight slot if we still own it — a newer-gen compute may
            // have replaced us, and it must not be evicted (a post-write reader awaits it).
            (b) => { if (statsGen === gen) statsCache = { at: Date.now(), body: b }; if (statsInflight === statsCompute) statsInflight = null; return b; },
            (e) => { if (statsInflight === statsCompute) statsInflight = null; throw e; },
          );
          statsInflight = statsCompute;
        }
        if (statsCache) {
          // Serve stale now; attach a catch so a failed background refresh can't surface
          // as an unhandled promise rejection (the blocking path below still propagates).
          statsInflight?.catch(() => {});
          return Response.json(statsCache.body);
        }
        return Response.json(await statsInflight);
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
        invalidateStats(); // drill bump changes /stats recall counts
        return Response.json({ observation: obs });
      }
      if (req.method === 'POST' && url.pathname === '/search/all') {
        const parsed = SearchRequestSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
        }
        const { query, top_k } = parsed.data;
        const cfg = resolveRankConfig(parsed.data.rank_profile, process.env);
        const visible = applyTemporalRerank(await localSearchAll(query, top_k, cfg), query, cfg, Date.now());
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
        const cfg = resolveRankConfig(parsed.data.rank_profile, process.env);
        const results = applyTemporalRerank(
          dropArchived(await searchByChannel(parsed.data.query, 'memory', parsed.data.top_k, filters, cfg)),
          parsed.data.query, cfg, Date.now(),
        );
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
        const cfg = resolveRankConfig(parsed.data.rank_profile, process.env);
        const results = applyTemporalRerank(
          dropArchived(await searchByChannel(parsed.data.query, 'skill', parsed.data.top_k, filters, cfg)),
          parsed.data.query, cfg, Date.now(),
        );
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
        const cfg = resolveRankConfig(parsed.data.rank_profile, process.env);
        const results = applyTemporalRerank(
          demoteSuperseded(
            dropArchived(await searchByChannel(parsed.data.query, 'observation', parsed.data.top_k, filters, cfg)),
            cfg.supersedePenalty,
          ),
          parsed.data.query, cfg, Date.now(),
        );
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
        const cfg = resolveRankConfig(parsed.data.rank_profile, process.env);
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

        const fused = await searchWithRecency(embedding, trimmed, parsed.data.top_k * 3, cfg);
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
        const hits = applyTemporalRerank(
          dropSunkForAutoInject(demoteSuperseded(dropArchived(candidates), cfg.supersedePenalty)).slice(0, parsed.data.top_k),
          trimmed, cfg, Date.now(),
        );

        // Fire-and-forget recall audit (default-off; enable via CAPTAIN_MEMO_RECALL_AUDIT=1).
        // fused already carries .boosts from applyBoosts (BoostedItem); build a
        // lookup so we can attach provenance to each hit without a second scan.
        {
          type BoostedProvenance = { identifier?: number; branch?: number; rareToken?: number } | undefined;
          const fusedBoostMap = new Map<string, BoostedProvenance>(
            fused.map(f => [f.id, (f as { id: string; boosts?: BoostedProvenance }).boosts]),
          );
          const rawPrompt = parsed.data.prompt;
          void writeRecallAuditLine({
            ts: Date.now(),
            session_id: parsed.data.session_id ?? 'unknown',
            project_id: parsed.data.project_id ?? opts.projectId,
            query: trimmed,
            rank_profile: cfg.profile,
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
        const { branch, source, origin_agent, ...rest } = parsed.data;
        const id = obsQueue.enqueue({
          ...rest,
          branch: branch ?? null,
          ...(origin_agent !== undefined && { origin_agent }),
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

      if (req.method === 'POST' && url.pathname === '/capture/backfill') {
        if (!captureBackfill) return Response.json({ ingested: 0, events: 0, sources: captureSourceIds, detail: 'no cross-AI capture sources active on this host' });
        const r = captureBackfill();
        return Response.json({ ...r, sources: captureSourceIds });
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
    if (captureTimer) clearInterval(captureTimer);
    if (tideSweepTimer) clearInterval(tideSweepTimer);
    if (qmDedupTimer) clearInterval(qmDedupTimer);
    if (qmSupersedeTimer) clearInterval(qmSupersedeTimer);
    if (promotionTimer) clearInterval(promotionTimer);
    if (pendingTickTimer) clearInterval(pendingTickTimer);
    // clearInterval cancels the SCHEDULE, not work already IN FLIGHT. Every background slice below is
    // async (they even yieldToLoop), so one that started before stop() keeps running and then writes its
    // result / audit row into a store we are about to close — "RangeError: Cannot use a closed database",
    // thrown from a timer callback, i.e. an UNHANDLED rejection with no test to attribute it to. Under
    // `bun test` that surfaced as a phantom failure attached to whichever test happened to be running,
    // migrating between files run-to-run. Drain every in-flight job BEFORE the handles go.
    // allSettled, not all: a slice that rejects has already logged + recorded its own errored audit row —
    // here we only care that it is DONE, and one failing slice must not skip the drain of the others.
    await Promise.allSettled([
      processBatchPromise, tideSweepPromise, qmDedupPromise, qmSupersedePromise, promotionPromise,
    ].filter((p): p is Promise<unknown> => p != null));
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
  const resolvedPort = server.port ?? opts.port;

  // Optional local device-pairing gateway (GitHub #6) — an authenticated HTTP-MCP listener,
  // started only when at least one device is paired. Localhost-only; the operator's own
  // reverse proxy is responsible for public exposure + TLS. One MCP session (server+transport)
  // per client connection, keyed by the transport-assigned mcp-session-id — mirrors
  // captain-memo-fed's src/gateway/server.ts, the proven reference for this exact pattern.
  // See docs/superpowers/specs/2026-07-05-local-device-pairing-design.md.
  let gatewayServer: ReturnType<typeof Bun.serve> | undefined;
  const gatewaySessions = new Map<string, { server: Server; transport: WebStandardStreamableHTTPServerTransport }>();
  const gatewayCfg = loadGatewayConfig(opts.gatewayConfigPath);
  if (gatewayCfg.devices.length > 0) {
    const gatewayPort = process.env.CAPTAIN_MEMO_GATEWAY_PORT
      ? Number(process.env.CAPTAIN_MEMO_GATEWAY_PORT)
      : resolvedPort + 1;
    try {
      gatewayServer = Bun.serve({
        port: gatewayPort,
        hostname: '127.0.0.1',
        async fetch(req) {
          const sid = req.headers.get('mcp-session-id');
          if (sid) {
            const existing = gatewaySessions.get(sid);
            if (!existing) return new Response('unknown session', { status: 404 });
            return existing.transport.handleRequest(req);
          }

          const auth = req.headers.get('authorization') ?? '';
          const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
          const device = verifyToken(token, loadGatewayConfig(opts.gatewayConfigPath));
          if (!device) return Response.json({ error: 'unauthorized' }, { status: 401 });

          const mcpServer = new Server({ name: 'captain-memo-gateway', version: VERSION }, { capabilities: { tools: {} } });
          mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
          mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
            return dispatchTool(request.params.name, request.params.arguments, {
              workerBase: `http://127.0.0.1:${resolvedPort}`,
              sessionId: `gw-${device.id}`,
              cwd: () => '/',
            });
          });
          let session: { server: Server; transport: WebStandardStreamableHTTPServerTransport };
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (newSid) => { gatewaySessions.set(newSid, session); },
            onsessionclosed: (closedSid) => { gatewaySessions.delete(closedSid); },
          });
          session = { server: mcpServer, transport };
          await mcpServer.connect(transport);
          return transport.handleRequest(req);
        },
      });
      console.log(`[gateway] listening on 127.0.0.1:${gatewayServer.port} (${gatewayCfg.devices.length} device(s) paired)`);
    } catch (err) {
      console.warn(`[gateway] failed to start (port ${gatewayPort} in use?) — continuing without it:`, err);
      gatewayServer = undefined;
    }
  }

  return {
    port: resolvedPort,
    handler,
    ...(obsStore ? { store: obsStore } : {}),
    stop: async () => {
      for (const s of gatewaySessions.values()) {
        try { await s.server.close(); } catch { /* best-effort */ }
      }
      gatewayServer?.stop(true);
      server.stop(true);
      await stopResources();
    },
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
    // `auto` expands to every OTHER AI assistant's memory location that actually
    // exists here (Codex, Gemini, Cursor, Copilot, AGENTS.md, …) — see
    // shared/ai-memory-sources.ts. It composes: `auto,/my/notes/*.md` is a union,
    // so a hand-written glob is still available and never has to be replaced.
    watchPaths = [...new Set(
      watchMemory.split(',').map(s => s.trim()).filter(Boolean)
        .flatMap(p => p === 'auto' ? discoverMemoryGlobs() : [p]),
    )];
    watchChannel = 'memory';
    if (watchMemory.split(',').some(s => s.trim() === 'auto')) {
      console.error(`[worker] watch memory: auto-detected ${watchPaths.length} memory source(s) — ${watchPaths.join(', ')}`);
    }
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
  const hookBudgetTokens = Number(process.env[ENV_HOOK_BUDGET_TOKENS] ?? DEFAULT_HOOK_BUDGET_TOKENS);
  const observationBatchSize = Number(process.env[ENV_OBSERVATION_BATCH_SIZE] ?? DEFAULT_OBSERVATION_BATCH_SIZE);
  const observationTickMs = Number(process.env[ENV_OBSERVATION_TICK_MS] ?? DEFAULT_OBSERVATION_TICK_MS);

  // Summarizer provider toggle:
  //   - 'claude-oauth' (default): direct HTTPS with Claude Code's OAuth token.
  //     No key, no subprocess, ~700 ms/call. Needs a Max/Pro plan.
  //   - 'anthropic':      direct SDK call, requires ANTHROPIC_API_KEY (paid).
  //   - 'claude-code':    shells out to `claude -p`; Max/Pro plan, ~1-2 s.
  //   - 'openai-compatible': any /v1/chat/completions (Ollama, OpenAI, …).
  //   - 'codex':          shells out to `codex exec`; ChatGPT Plus/Pro, no key,
  //     ~6-7 s. The only zero-key path for someone with no Anthropic plan.
  //   - 'agy':            shells out to `agy -p`; Google account, no key.
  // An unrecognized value (e.g. a customer who tried to set "codex,agy") FAILS LOUD with the
  // valid list rather than silently working — see shared/summarizer-provider.ts.
  const { provider, warning: providerWarning } = resolveSummarizerProvider(process.env[ENV_SUMMARIZER_PROVIDER]);
  if (providerWarning) console.error(`[worker] ${ENV_SUMMARIZER_PROVIDER}: ${providerWarning}`);

  // Model defaults are provider-shaped: DEFAULT_SUMMARIZER_MODEL is a Claude slug,
  // and handing a Claude slug to `codex exec` is an instant 400. Resolve the
  // default AFTER the provider is known. An explicit CAPTAIN_MEMO_SUMMARIZER_MODEL
  // always wins — the user may be on a plan with a different allowed model set.
  const providerDefaultModel =
    provider === 'codex' ? DEFAULT_CODEX_MODEL :
    provider === 'agy'   ? DEFAULT_AGY_MODEL   : DEFAULT_SUMMARIZER_MODEL;
  const providerDefaultFallbacks =
    provider === 'codex' ? DEFAULT_CODEX_FALLBACKS :
    provider === 'agy'   ? DEFAULT_AGY_FALLBACKS   : DEFAULT_SUMMARIZER_FALLBACKS;
  const summarizerModel = process.env[ENV_SUMMARIZER_MODEL] ?? providerDefaultModel;
  const summarizerFallbacksRaw = process.env[ENV_SUMMARIZER_FALLBACKS];
  // NOTE: agy model names contain commas? No — but they DO contain spaces and parens
  // ('Gemini 3.5 Flash (Low)'). Comma stays a safe separator; don't switch to spaces.
  const summarizerFallbacks = summarizerFallbacksRaw
    ? summarizerFallbacksRaw.split(',').map(s => s.trim()).filter(Boolean)
    : providerDefaultFallbacks;

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
  } else if (provider === 'codex') {
    const { createCodexTransport } = await import('./summarizer-codex.ts');
    const summarizer = new Summarizer({
      apiKey: '', // unused under the codex transport (auth via `codex login`)
      model: summarizerModel,
      fallbackModels: summarizerFallbacks,
      transport: createCodexTransport(),
    });
    summarize = (events) => summarizer.summarize(events);
    summarizerTransport = summarizer.getTransport();
    console.error(
      `[worker] summarizer provider = codex (ChatGPT Plus/Pro auth via 'codex exec', model ${summarizerModel}; ` +
      `~6-7s/call — agent boot, not inference. Runs on the background tick, so it never blocks a prompt.)`,
    );
  } else if (provider === 'agy') {
    const { createAgyTransport } = await import('./summarizer-agy.ts');
    const summarizer = new Summarizer({
      apiKey: '', // unused under the agy transport (auth via the Google OAuth token agy stored)
      model: summarizerModel,
      fallbackModels: summarizerFallbacks,
      transport: createAgyTransport(),
    });
    summarize = (events) => summarizer.summarize(events);
    summarizerTransport = summarizer.getTransport();
    console.error(
      `[worker] summarizer provider = agy (Google account via Antigravity CLI, model ${summarizerModel}; ` +
      `~3.4-5.5s/call, runs under an isolated $HOME so your real \`agy --continue\` history stays clean)`,
    );
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
      `         - ${ENV_SUMMARIZER_PROVIDER}=claude-oauth       (Claude Max/Pro, no key, fastest)\n` +
      `         - ${ENV_SUMMARIZER_PROVIDER}=claude-code        (Max/Pro plan, no key)\n` +
      `         - ${ENV_SUMMARIZER_PROVIDER}=codex              (ChatGPT Plus/Pro, no key — run \`codex login\`)\n` +
      `         - ${ENV_SUMMARIZER_PROVIDER}=agy                (Google account, no key — run \`agy\` once to log in)\n` +
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
