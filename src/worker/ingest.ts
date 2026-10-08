import { readFileSync, statSync } from 'fs';
import { basename } from 'path';
import { sha256Hex } from '../shared/sha.ts';
import { newChunkId } from '../shared/id.ts';
import { chunkMemoryFile } from './chunkers/memory-file.ts';
import { chunkSkill } from './chunkers/skill.ts';
import { chunkCapability } from './chunkers/capability.ts';
import { splitForEmbed } from './chunkers/safe-split.ts';
import { parseSkillDocument, type ParsedSkill } from './skill-registry.ts';
import { parseCapabilityManifest, type ParsedCapability } from './capability-registry.ts';
import type { ChannelType, ChunkInput } from '../shared/types.ts';
import type { MetaStore } from './meta.ts';
import type { VectorStore } from './vector-store.ts';
import type { PendingEmbedQueue } from './pending-embed-queue.ts';

export interface IngestPipelineOptions {
  meta: MetaStore;
  embedder: { embed: (texts: string[]) => Promise<number[][]> };
  vector: VectorStore;
  collectionName: string;
  projectId: string;
  /**
   * If set, chunks exceeding this token count are pre-split via
   * splitForEmbed before reaching the embedder. Pass the same value used
   * for the Embedder's maxInputTokens — single source of truth keeps the
   * splitter and rejector aligned. When unset, no splitting occurs and
   * oversized chunks may throw EmbedderInputTooLarge from the embedder.
   */
  maxInputTokens?: number;
  /**
   * Fired once per indexFile() call: 'indexed' when the file was (re)chunked
   * and embedded, 'skipped' when its content sha was unchanged. Lets the
   * worker track dedup hit-rate without IngestPipeline knowing about
   * WorkerMetrics.
   */
  onIndexResult?: (result: 'indexed' | 'skipped') => void;
  /**
   * Where chunks go when the embed call fails (or returns an unusable vector): the chunks are still
   * written to meta (keyword search works) and queued here, and processPendingEmbed stores their real
   * vectors later. Without it an embed failure throws before anything is changed. Never zero vectors:
   * 538 of them were written that way, and the unchanged sha kept them until the file was edited.
   */
  pendingEmbed?: Pick<PendingEmbedQueue, 'enqueue'>;
}

/** Largest file the ingest path reads. The largest real memory, skill or plugin manifest on the dev host is
 *  58,690 bytes (2026-10-01, 1,821 documents), so 1 MB is 17x headroom; a database or a log is not memory. */
export const MAX_INDEX_FILE_BYTES = 1024 * 1024;

/** Memory is markdown (.md, or Cursor's .mdc). Every shipped source and the memory writer produce only
 *  that, so anything else in the memory channel got there by a watcher that matched too much. */
export const isMemoryFilePath = (p: string): boolean => /\.mdc?$/i.test(p);

/** Why a file must not be indexed, or null when it may. One place: the watcher event, the boot pass and
 *  /reindex all end in indexFile. A captain indexed ~/.codex/logs_2.sqlite-wal (12 chunks) and
 *  models_cache.json (1,670 chunks) as memory before this existed. */
export function unindexableReason(filePath: string, channel: ChannelType, sizeBytes: number, content: Buffer): string | null {
  if (channel === 'memory' && !isMemoryFilePath(filePath)) return 'not a markdown file';
  if (sizeBytes > MAX_INDEX_FILE_BYTES) return `${sizeBytes} bytes is over the ${MAX_INDEX_FILE_BYTES} byte limit`;
  if (content.subarray(0, 8192).includes(0)) return 'binary content';
  return null;
}

/** A chunk that must never be sent to the embedder: it belongs to a file ingest now refuses (a database or log a
 *  too-wide watcher once indexed as memory), or its text holds a NUL byte, which only binary content has. The
 *  retry queue drops rows like these instead of re-sending them: on one captain 260 of them were retried 68,043
 *  times and cost 7.29M tokens in a morning (2026-10-08). */
export function isUnembeddableChunk(channel: ChannelType, sourcePath: string, text: string): boolean {
  return (channel === 'memory' && !isMemoryFilePath(sourcePath)) || text.includes('\0');
}

export class IngestPipeline {
  private meta: MetaStore;
  private embedder: { embed: (texts: string[]) => Promise<number[][]> };
  private vector: VectorStore;
  private collection: string;
  private projectId: string;
  private maxInputTokens: number | undefined;
  private onIndexResult: ((result: 'indexed' | 'skipped') => void) | undefined;
  private pendingEmbed: Pick<PendingEmbedQueue, 'enqueue'> | undefined;
  /** Tail of the work queued per path. indexFile reads the old chunk set before its embed await and
   *  swaps it after, so two overlapping calls on one path (a second watcher event, /reindex during a
   *  watcher pass) each displaced a chunk set nobody deleted. Reproduced: 2 and 4 orphaned vectors. */
  private pathTails = new Map<string, Promise<void>>();

  constructor(opts: IngestPipelineOptions) {
    this.meta = opts.meta;
    this.embedder = opts.embedder;
    this.vector = opts.vector;
    this.collection = opts.collectionName;
    this.projectId = opts.projectId;
    this.maxInputTokens = opts.maxInputTokens;
    this.onIndexResult = opts.onIndexResult;
    this.pendingEmbed = opts.pendingEmbed;
  }

  /** Run `work` after every earlier call on the same path has settled. */
  private serial(path: string, work: () => Promise<void>): Promise<void> {
    const run = (this.pathTails.get(path) ?? Promise.resolve()).then(work);
    const tail = run.catch(() => {});
    this.pathTails.set(path, tail);
    void tail.then(() => { if (this.pathTails.get(path) === tail) this.pathTails.delete(path); });
    return run;
  }

  private chunkerFor(channel: ChannelType, content: string, sourcePath: string, capability?: ParsedCapability | null): ChunkInput[] {
    if (channel === 'memory') return chunkMemoryFile(content, sourcePath);
    if (channel === 'skill') return chunkSkill(content, sourcePath);
    if (channel === 'capability' && capability) return chunkCapability(capability);
    throw new Error(`No file-based chunker for channel: ${channel}`);
  }

  indexFile(filePath: string, channel: ChannelType): Promise<void> {
    return this.serial(filePath, () => this.indexFileNow(filePath, channel));
  }

  deleteFile(filePath: string): Promise<void> {
    return this.serial(filePath, () => this.deleteFileNow(filePath));
  }

  private async indexFileNow(filePath: string, channel: ChannelType): Promise<void> {
    // The virtual skill registry only accepts canonical Agent Skill entry
    // files. This is a second structural gate behind discovery/watcher filters:
    // companion docs, transcripts and credentials beside a skill cannot be
    // imported merely because an event source hands us their path.
    if (channel === 'skill' && basename(filePath) !== 'SKILL.md') {
      await this.deleteFileNow(filePath); // also removes rows imported by older watcher behavior
      return;
    }
    if (channel === 'capability' && !['plugin.json', 'gemini-extension.json'].includes(basename(filePath))) {
      await this.deleteFileNow(filePath);
      return;
    }
    const stat = statSync(filePath);
    const raw = stat.size > MAX_INDEX_FILE_BYTES ? Buffer.alloc(0) : readFileSync(filePath);
    const refused = unindexableReason(filePath, channel, stat.size, raw);
    if (refused) {
      console.error(`[ingest] skipping ${filePath}: ${refused}`);
      await this.deleteFileNow(filePath); // and drop what an older version indexed from it
      this.onIndexResult?.('skipped');
      return;
    }
    const content = raw.toString('utf-8');
    const mtime_epoch = Math.floor(stat.mtimeMs / 1000);

    const existing = this.meta.getDocument(filePath);
    const parsedSkill: ParsedSkill | null = channel === 'skill'
      ? parseSkillDocument(content, filePath)
      : null;
    const parsedCapability: ParsedCapability | null = channel === 'capability'
      ? parseCapabilityManifest(content, filePath)
      : null;
    // Capability manifests may contain executable configuration and env. Only
    // the sanitized projection participates in storage/dedup.
    const sha = parsedCapability?.content_sha ?? sha256Hex(content);
    if (existing && existing.sha === sha) {
      // A schema upgrade can encounter an already-indexed skill before its
      // first-class registry row exists. Backfill it without paying to embed
      // unchanged chunks again.
      if (parsedSkill && !this.meta.getSkillBySourcePath(filePath)) {
        this.meta.upsertSkill({ document_id: existing.id, ...parsedSkill });
      }
      if (parsedCapability && !this.meta.getCapabilityBySourcePath(filePath)) {
        this.meta.upsertCapability({ document_id: existing.id, ...parsedCapability });
      }
      this.onIndexResult?.('skipped');
      return;
    }

    const rawChunks = this.chunkerFor(channel, content, filePath, parsedCapability);
    // Pre-split anything that would overflow the embedder's per-input token
    // limit. Without this, a single oversized chunk would either silently
    // tail-truncate at the API (legacy bug) or throw EmbedderInputTooLarge
    // and abort indexing of the entire file.
    const chunks = this.maxInputTokens
      ? splitForEmbed(rawChunks, this.maxInputTokens)
      : rawChunks;

    if (chunks.length === 0) {
      // Empty file or all-whitespace — drop the document (and its vectors) if it existed
      if (existing) await this.deleteFileNow(filePath);
      this.onIndexResult?.('indexed');
      return;
    }

    const sourceKey = parsedSkill?.skill_id ?? parsedCapability?.capability_id ?? basename(filePath, '.md');
    const chunksWithIds = chunks.map(c => ({
      chunk_id: newChunkId(channel, sourceKey),
      text: c.text,
      sha: sha256Hex(c.text),
      position: c.position,
      metadata: c.metadata,
    }));

    let embeddings: number[][] | null = null;
    try {
      embeddings = await this.embedder.embed(chunksWithIds.map(c => c.text));
    } catch (err) {
      if (!this.pendingEmbed) throw err;
      console.error(`[ingest] embed failed for ${filePath}; queueing ${chunksWithIds.length} chunk(s) for retry: ${(err as Error).message}`);
    }

    // Drop old vector entries for this document before indexing the new version. After the embed, so an
    // embed failure with no queue to fall back on leaves the existing index intact.
    if (existing) {
      const oldChunks = this.meta.getChunksForDocument(existing.id);
      if (oldChunks.length > 0) {
        await this.vector.delete(this.collection, oldChunks.map(c => c.chunk_id));
      }
    }

    const documentId = this.meta.upsertDocument({
      source_path: filePath,
      channel,
      project_id: this.projectId,
      sha,
      mtime_epoch,
      metadata: {},
    });

    this.meta.replaceChunksForDocument(documentId, chunksWithIds);
    if (parsedSkill) this.meta.upsertSkill({ document_id: documentId, ...parsedSkill });
    if (parsedCapability) this.meta.upsertCapability({ document_id: documentId, ...parsedCapability });

    if (embeddings) {
      await this.vector.add(
        this.collection,
        chunksWithIds.map((c, i) => ({ id: c.chunk_id, embedding: embeddings![i]! })),
      );
    } else {
      for (const c of chunksWithIds) {
        this.pendingEmbed!.enqueue({ chunk_id: c.chunk_id, source_path: filePath, sha: c.sha, channel });
      }
    }
    this.onIndexResult?.('indexed');
  }

  private async deleteFileNow(filePath: string): Promise<void> {
    const existing = this.meta.getDocument(filePath);
    if (!existing) return;
    const oldChunks = this.meta.getChunksForDocument(existing.id);
    if (oldChunks.length > 0) {
      await this.vector.delete(this.collection, oldChunks.map(c => c.chunk_id));
    }
    this.meta.deleteDocument(filePath);
  }
}
