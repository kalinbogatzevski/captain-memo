import { Database } from 'bun:sqlite';
import { newChunkId } from '../shared/id.ts';
import { sha256Hex } from '../shared/sha.ts';
import { fmtElapsed } from '../shared/format.ts';
import { bold, boldRed, cyan, cyanBold, isTTY } from '../shared/ansi.ts';
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

const SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const BAR_WIDTH = 24;

function progressBar(done: number, total: number): string {
  const filled = total > 0
    ? Math.min(BAR_WIDTH, Math.round((done / total) * BAR_WIDTH))
    : BAR_WIDTH;
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

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

// Persist a doc's meta + chunks + vectors. Pure local I/O — does NOT call
// the embedder. The caller supplies the embeddings (typically obtained from
// a single batched call across multiple docs to amortize HTTP overhead).
async function writeDocWithEmbeddings(
  doc: MigrationDocument,
  embeddings: number[][],
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

// Per-doc fallback: embed this doc's chunks alone, then write. Used when
// a batched embed call fails — isolates which doc is the problem.
async function commitDocument(
  doc: MigrationDocument,
  deps: MigrationDeps,
): Promise<void> {
  if (doc.chunks.length === 0) return;
  const embeddings = await deps.embedder.embed(doc.chunks.map(c => c.text));
  return writeDocWithEmbeddings(doc, embeddings, deps);
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
  let ticker: ReturnType<typeof setInterval> | undefined;
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
    let spinnerIdx = 0;
    let lastKind: 'obs' | 'sum' = 'obs';

    const renderProgress = (kind: 'obs' | 'sum'): string => {
      lastKind = kind;
      const done = result.observations_migrated + result.observations_skipped
                 + result.summaries_migrated + result.summaries_skipped;
      const elapsedS = (Date.now() - startedAtMs) / 1000;
      const rate = elapsedS > 0 ? done / elapsedS : 0;
      const etaS = rate > 0 ? Math.ceil((grandTotal - done) / rate) : 0;
      const pct = grandTotal > 0 ? Math.min(100, Math.round((done / grandTotal) * 100)) : 100;
      const spinner = cyan(SPINNER[spinnerIdx % SPINNER.length] ?? '⠋');
      const bar = cyanBold(progressBar(done, grandTotal));
      const total = grandTotal.toLocaleString('en-US');
      const doneFmt = done.toLocaleString('en-US');
      return `${spinner} ${bold(kind)} ${bar} ${doneFmt}/${total} (${pct}%)  ${rate.toFixed(1)}/s  ETA ${fmtElapsed(etaS)}`;
    };

    // Steady-cadence repaint so the spinner keeps animating even when the row
    // loop stalls inside an embedder call. Skipped on non-TTY: piped output
    // would otherwise capture ~12 near-identical lines per second.
    if (isTTY()) {
      ticker = setInterval(() => {
        spinnerIdx = (spinnerIdx + 1) % SPINNER.length;
        opts.onProgress?.(renderProgress(lastKind));
      }, 80);
    }

    // Observations first, then summaries — chronological order maximises continuity
    const obsRows = src
      .query(
        `SELECT * FROM observations WHERE id >= ? ORDER BY created_at_epoch ASC, id ASC`,
      )
      .all(fromId) as ClaudeMemObservationRow[];

    let batch: Array<{ doc: MigrationDocument; kind: 'observation' | 'summary' }> = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;

      // Dry-run: count without writing or embedding.
      if (dry) {
        for (const item of batch) {
          if (item.kind === 'observation') result.observations_migrated++;
          else result.summaries_migrated++;
        }
        batch = [];
        return;
      }

      // Fast path: batch-embed every chunk across every doc in one HTTP call.
      // ~10-30x throughput vs per-doc embedding because we amortize the
      // round-trip across the whole batch. The Embedder client auto-splits
      // into 128-text sub-batches for the API limit.
      const allTexts: string[] = [];
      const docOffsets: number[] = [];
      for (const item of batch) {
        docOffsets.push(allTexts.length);
        for (const c of item.doc.chunks) allTexts.push(c.text);
      }

      let batchedEmbeddings: number[][] | null = null;
      if (allTexts.length > 0) {
        try {
          batchedEmbeddings = await deps.embedder.embed(allTexts);
        } catch (err) {
          // Fall back to per-doc embed so one bad doc doesn't kill 64 good ones.
          opts.onProgress?.(
            `batch embed failed (${(err as Error).message}); falling back per-doc`,
          );
        }
      }

      for (let i = 0; i < batch.length; i++) {
        const item = batch[i]!;
        try {
          if (batchedEmbeddings) {
            const start = docOffsets[i]!;
            const docEmbeddings = batchedEmbeddings.slice(start, start + item.doc.chunks.length);
            await writeDocWithEmbeddings(item.doc, docEmbeddings, deps);
          } else {
            // Per-doc fallback: isolates the problem doc's failure.
            await commitDocument(item.doc, deps);
          }
          const sourceId = (item.kind === 'observation'
            ? item.doc.metadata.observation_id
            : item.doc.metadata.summary_id) as number;
          deps.meta.markMigrationDone(
            item.kind,
            sourceId,
            migrationDocumentSha(item.doc),
          );
          if (item.kind === 'observation') result.observations_migrated++;
          else result.summaries_migrated++;
        } catch (err) {
          result.errors++;
          opts.onProgress?.(
            `${boldRed('skip')} ${item.kind} ${(item.doc.metadata.source_id ?? '?')}: ${(err as Error).message}`,
          );
          continue;
        }
      }
      batch = [];
    };

    for (const row of obsRows) {
      if (processed >= limit) break;
      lastKind = 'obs';
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
      processed++;
      if (batch.length >= batchSize) await flush();
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
        lastKind = 'sum';
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
        processed++;
        if (batch.length >= batchSize) await flush();
      }
      await flush();
    }
    // Final paint so the bar always lands at 100%, even if the run finished
    // between interval ticks.
    opts.onProgress?.(renderProgress(lastKind));
  } catch (err) {
    result.errors++;
    opts.onProgress?.(`${boldRed('migration error:')} ${(err as Error).message}`);
  } finally {
    if (ticker) clearInterval(ticker);
    src.close();
  }

  return result;
}
