import { Database } from 'bun:sqlite';
import type { ChannelType } from '../shared/types.ts';
import { computeBackoffMs } from './summarizer-backoff.ts';

// Per-row exponential backoff for failed embeds. The embedder (Voyage) can be
// flaky/down (timeouts, truncated bodies); retrying every fixed 60s hammered it
// during an outage. A chunk that keeps failing now waits progressively longer
// (~15-30s first, then exponential, capped at 10 min) instead. Exported + jitter-
// injectable so the schedule is unit-testable. `retries` is the row's PRIOR retry
// count (0 on the first failure).
export function embedRetryDelayMs(retries: number, jitter?: () => number): number {
  return computeBackoffMs(retries + 1, 0, { baseMs: 30_000, capMs: 600_000, ...(jitter && { jitter }) });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_embed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL UNIQUE,
  source_path TEXT NOT NULL,
  sha TEXT NOT NULL,
  channel TEXT NOT NULL,
  retries INTEGER NOT NULL DEFAULT 0,
  next_retry_at_epoch INTEGER NOT NULL,
  enqueued_at_epoch INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pe_due ON pending_embed(next_retry_at_epoch);
`;

export interface PendingEmbedInput {
  chunk_id: string;
  source_path: string;
  sha: string;
  channel: ChannelType;
}

export interface PendingEmbedRow extends PendingEmbedInput {
  id: number;
  retries: number;
  next_retry_at_epoch: number;
  enqueued_at_epoch: number;
}

export class PendingEmbedQueue {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  enqueue(input: PendingEmbedInput): void {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.db
      .query('SELECT id FROM pending_embed WHERE chunk_id = ?')
      .get(input.chunk_id) as { id: number } | undefined;
    if (existing) {
      this.db
        .query('UPDATE pending_embed SET source_path = ?, sha = ?, channel = ? WHERE id = ?')
        .run(input.source_path, input.sha, input.channel, existing.id);
    } else {
      this.db
        .query(
          `INSERT INTO pending_embed
            (chunk_id, source_path, sha, channel, retries, next_retry_at_epoch, enqueued_at_epoch)
           VALUES (?, ?, ?, ?, 0, ?, ?)`
        )
        .run(input.chunk_id, input.source_path, input.sha, input.channel, now, now);
    }
  }

  listDue(limit: number): PendingEmbedRow[] {
    const now = Math.floor(Date.now() / 1000);
    return this.db
      .query(
        `SELECT id, chunk_id, source_path, sha, channel, retries,
                next_retry_at_epoch, enqueued_at_epoch
         FROM pending_embed
         WHERE next_retry_at_epoch <= ?
         ORDER BY next_retry_at_epoch ASC, id ASC
         LIMIT ?`
      )
      .all(now, limit) as PendingEmbedRow[];
  }

  markRetried(ids: number[]): void {
    if (ids.length === 0) return;
    // Per-row exponential backoff keyed off each row's own retry count, so a chunk
    // that keeps failing (Voyage overloaded/down) backs off instead of retrying on a
    // fixed tick. A transient blip still recovers fast (first retry ~15-30s).
    const nowSec = Math.floor(Date.now() / 1000);
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        const row = this.db
          .query('SELECT retries FROM pending_embed WHERE id = ?')
          .get(id) as { retries: number } | undefined;
        if (!row) continue;
        const nextRetries = row.retries + 1;
        const next = nowSec + Math.ceil(embedRetryDelayMs(row.retries) / 1000);
        this.db
          .query('UPDATE pending_embed SET retries = ?, next_retry_at_epoch = ? WHERE id = ?')
          .run(nextRetries, next, id);
      }
    });
    tx();
  }

  markEmbedded(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .query(`DELETE FROM pending_embed WHERE id IN (${placeholders})`)
      .run(...ids);
  }

  totalCount(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM pending_embed').get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
