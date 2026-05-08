import { Database } from 'bun:sqlite';
import { newChunkId } from '../shared/id.ts';
import { sha256Hex } from '../shared/sha.ts';
import {
  transformObservation,
  transformSessionSummary,
  migrationDocumentSha,
  type MigrationDocument,
} from './transform.ts';
import type {
  ClaudeMemObservationRow,
  ClaudeMemSessionSummaryRow,
} from './claude-mem-schema.ts';
import type { MetaStore } from '../worker/meta.ts';
import type { VectorStore } from '../worker/vector-store.ts';

export interface MigrationDeps {
  meta: MetaStore;
  embedder: { embed: (texts: string[]) => Promise<number[][]> };
  vector: VectorStore;
  collectionName: string;
  projectId: string;
  sourceDbPath: string;
}

export interface MigrationOptions {
  dryRun?: boolean;
  limit?: number;             // max number of source rows to process this run
  fromId?: number;            // resume marker — process rows with id >= fromId
  batchSize?: number;         // embed batch size; default 64
  onProgress?: (msg: string) => void;
}

export interface MigrationResult {
  observations_migrated: number;
  observations_skipped: number;
  summaries_migrated: number;
  summaries_skipped: number;
  errors: number;
}

const DEFAULT_BATCH = 64;

async function commitDocument(
  doc: MigrationDocument,
  deps: MigrationDeps,
): Promise<void> {
  if (doc.chunks.length === 0) return;

  const sourceKind = doc.source_path.startsWith('claude-mem://observation/')
    ? 'observation'
    : 'summary';
  const sourceId = String(
    sourceKind === 'observation'
      ? (doc.metadata.observation_id ?? doc.metadata.source_id)
      : (doc.metadata.summary_id ?? doc.metadata.source_id),
  );

  const chunksWithIds = doc.chunks.map(c => ({
    chunk_id: newChunkId('observation', sourceId),
    text: c.text,
    sha: sha256Hex(c.text),
    position: c.position,
    metadata: c.metadata,
  }));

  const embeddings = await deps.embedder.embed(chunksWithIds.map(c => c.text));
  const documentId = deps.meta.upsertDocument({
    source_path: doc.source_path,
    channel: doc.channel,
    project_id: doc.project_id,
    sha: migrationDocumentSha(doc),
    mtime_epoch: doc.mtime_epoch,
    metadata: doc.metadata,
  });
  deps.meta.replaceChunksForDocument(documentId, chunksWithIds);
  await deps.vector.add(
    deps.collectionName,
    chunksWithIds.map((c, i) => ({ id: c.chunk_id, embedding: embeddings[i]! })),
  );
}

export async function runMigration(
  deps: MigrationDeps,
  opts: MigrationOptions,
): Promise<MigrationResult> {
  const result: MigrationResult = {
    observations_migrated: 0,
    observations_skipped: 0,
    summaries_migrated: 0,
    summaries_skipped: 0,
    errors: 0,
  };

  const dry = opts.dryRun === true;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const fromId = opts.fromId ?? 0;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  let processed = 0;

  const src = new Database(deps.sourceDbPath, { readonly: true });
  try {
    // Pre-flight totals (informational — used to render % / ETA in progress lines)
    const obsTotal = (src.query(
      `SELECT COUNT(*) AS n FROM observations WHERE id >= ?`,
    ).get(fromId) as { n: number } | undefined)?.n ?? 0;
    const sumTotal = (src.query(
      `SELECT COUNT(*) AS n FROM session_summaries WHERE id >= ?`,
    ).get(fromId) as { n: number } | undefined)?.n ?? 0;
    const grandTotal = Math.min(limit, obsTotal + sumTotal);
    const startedAtMs = Date.now();
    const fmtElapsed = (s: number): string =>
      s < 60 ? `${s.toFixed(0)}s`
      : s < 3600 ? `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`
      : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    const renderProgress = (kind: 'obs' | 'sum'): string => {
      const done = result.observations_migrated + result.observations_skipped
                 + result.summaries_migrated + result.summaries_skipped;
      const elapsedS = (Date.now() - startedAtMs) / 1000;
      const rate = elapsedS > 0 ? done / elapsedS : 0;
      const etaS = rate > 0 ? Math.ceil((grandTotal - done) / rate) : 0;
      const pct = grandTotal > 0 ? Math.round((done / grandTotal) * 100) : 100;
      return `${kind} ${done}/${grandTotal} (${pct}%)  rate=${rate.toFixed(1)}/s  ETA=${fmtElapsed(etaS)}`;
    };

    // Observations first, then summaries — chronological order maximises continuity
    const obsRows = src
      .query(
        `SELECT * FROM observations WHERE id >= ? ORDER BY created_at_epoch ASC, id ASC`,
      )
      .all(fromId) as ClaudeMemObservationRow[];

    let batch: Array<{ doc: MigrationDocument; kind: 'observation' | 'summary' }> = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      if (!dry) {
        for (const item of batch) {
          await commitDocument(item.doc, deps);
          const sourceId = (item.kind === 'observation'
            ? item.doc.metadata.observation_id
            : item.doc.metadata.summary_id) as number;
          deps.meta.markMigrationDone(
            item.kind,
            sourceId,
            migrationDocumentSha(item.doc),
          );
        }
      }
      batch = [];
    };

    for (const row of obsRows) {
      if (processed >= limit) break;
      if (deps.meta.isMigrationDone('observation', row.id)) {
        result.observations_skipped++;
        continue;
      }
      const doc = transformObservation(row, deps.projectId);
      if (doc.chunks.length === 0) {
        // Empty content — still mark done so we don't reattempt
        if (!dry) {
          deps.meta.markMigrationDone('observation', row.id, migrationDocumentSha(doc));
        }
        result.observations_skipped++;
        continue;
      }
      batch.push({ doc, kind: 'observation' });
      result.observations_migrated++;
      processed++;
      if (batch.length >= batchSize) await flush();
      opts.onProgress?.(renderProgress('obs'));
    }
    await flush();

    // Session summaries
    if (processed < limit) {
      const sumRows = src
        .query(
          `SELECT * FROM session_summaries WHERE id >= ? ORDER BY created_at_epoch ASC, id ASC`,
        )
        .all(fromId) as ClaudeMemSessionSummaryRow[];

      for (const row of sumRows) {
        if (processed >= limit) break;
        if (deps.meta.isMigrationDone('summary', row.id)) {
          result.summaries_skipped++;
          continue;
        }
        const doc = transformSessionSummary(row, deps.projectId);
        if (doc.chunks.length === 0) {
          if (!dry) {
            deps.meta.markMigrationDone('summary', row.id, migrationDocumentSha(doc));
          }
          result.summaries_skipped++;
          continue;
        }
        batch.push({ doc, kind: 'summary' });
        result.summaries_migrated++;
        processed++;
        if (batch.length >= batchSize) await flush();
        opts.onProgress?.(renderProgress('sum'));
      }
      await flush();
    }
  } catch (err) {
    result.errors++;
    opts.onProgress?.(`migration error: ${(err as Error).message}`);
  } finally {
    src.close();
  }

  return result;
}
