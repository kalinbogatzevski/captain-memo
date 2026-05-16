import { readFileSync, statSync } from 'fs';
import { basename } from 'path';
import { sha256Hex } from '../shared/sha.ts';
import { newChunkId } from '../shared/id.ts';
import { chunkMemoryFile } from './chunkers/memory-file.ts';
import { chunkSkill } from './chunkers/skill.ts';
import { splitForEmbed } from './chunkers/safe-split.ts';
import type { ChannelType, ChunkInput } from '../shared/types.ts';
import type { MetaStore } from './meta.ts';
import type { VectorStore } from './vector-store.ts';

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
}

export class IngestPipeline {
  private meta: MetaStore;
  private embedder: { embed: (texts: string[]) => Promise<number[][]> };
  private vector: VectorStore;
  private collection: string;
  private projectId: string;
  private maxInputTokens: number | undefined;
  private onIndexResult: ((result: 'indexed' | 'skipped') => void) | undefined;

  constructor(opts: IngestPipelineOptions) {
    this.meta = opts.meta;
    this.embedder = opts.embedder;
    this.vector = opts.vector;
    this.collection = opts.collectionName;
    this.projectId = opts.projectId;
    this.maxInputTokens = opts.maxInputTokens;
    this.onIndexResult = opts.onIndexResult;
  }

  private chunkerFor(channel: ChannelType, content: string, sourcePath: string): ChunkInput[] {
    if (channel === 'memory') return chunkMemoryFile(content, sourcePath);
    if (channel === 'skill') return chunkSkill(content, sourcePath);
    throw new Error(`No file-based chunker for channel: ${channel}`);
  }

  async indexFile(filePath: string, channel: ChannelType): Promise<void> {
    const content = readFileSync(filePath, 'utf-8');
    const sha = sha256Hex(content);
    const stat = statSync(filePath);
    const mtime_epoch = Math.floor(stat.mtimeMs / 1000);

    const existing = this.meta.getDocument(filePath);
    if (existing && existing.sha === sha) {
      this.onIndexResult?.('skipped');
      return;
    }

    const rawChunks = this.chunkerFor(channel, content, filePath);
    // Pre-split anything that would overflow the embedder's per-input token
    // limit. Without this, a single oversized chunk would either silently
    // tail-truncate at the API (legacy bug) or throw EmbedderInputTooLarge
    // and abort indexing of the entire file.
    const chunks = this.maxInputTokens
      ? splitForEmbed(rawChunks, this.maxInputTokens)
      : rawChunks;

    // Drop old vector entries for this document before indexing the new version
    if (existing) {
      const oldChunks = this.meta.getChunksForDocument(existing.id);
      if (oldChunks.length > 0) {
        await this.vector.delete(this.collection, oldChunks.map(c => c.chunk_id));
      }
    }

    if (chunks.length === 0) {
      // Empty file or all-whitespace — drop the document if it existed
      if (existing) this.meta.deleteDocument(filePath);
      this.onIndexResult?.('indexed');
      return;
    }

    const sourceKey = basename(filePath, '.md');
    const chunksWithIds = chunks.map(c => ({
      chunk_id: newChunkId(channel, sourceKey),
      text: c.text,
      sha: sha256Hex(c.text),
      position: c.position,
      metadata: c.metadata,
    }));

    const embeddings = await this.embedder.embed(chunksWithIds.map(c => c.text));

    const documentId = this.meta.upsertDocument({
      source_path: filePath,
      channel,
      project_id: this.projectId,
      sha,
      mtime_epoch,
      metadata: {},
    });

    this.meta.replaceChunksForDocument(documentId, chunksWithIds);

    await this.vector.add(
      this.collection,
      chunksWithIds.map((c, i) => ({ id: c.chunk_id, embedding: embeddings[i]! })),
    );
    this.onIndexResult?.('indexed');
  }

  async deleteFile(filePath: string): Promise<void> {
    const existing = this.meta.getDocument(filePath);
    if (!existing) return;
    const oldChunks = this.meta.getChunksForDocument(existing.id);
    if (oldChunks.length > 0) {
      await this.vector.delete(this.collection, oldChunks.map(c => c.chunk_id));
    }
    this.meta.deleteDocument(filePath);
  }
}
