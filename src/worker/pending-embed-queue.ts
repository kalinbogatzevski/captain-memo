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

/** Which KIND of failure, because the remedy differs and the operator needs the remedy.
 *  rate_limited — the embedder is throttling (a free tier without billing is the common
 *                 case); the queue drains on its own, just slowly. Nothing is lost.
 *  auth         — a bad or missing key. Retrying forever will never fix it.
 *  unreachable  — 5xx / network. Transient; backoff is the right answer.
 *  other        — unclassified; show the text verbatim rather than guess. */
export type EmbedErrorClass = 'rate_limited' | 'auth' | 'unreachable' | 'other';

export function classifyEmbedError(msg: string): EmbedErrorClass {
  const m = String(msg || '');
  if (/\b429\b|rate.?limit|too many requests/i.test(m)) return 'rate_limited';
  if (/\b40[13]\b|unauthor|invalid api key|forbidden/i.test(m)) return 'auth';
  if (/\b(5\d\d)\b|fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket|network/i.test(m)) return 'unreachable';
  return 'other';
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
  enqueued_at_epoch INTEGER NOT NULL,
  -- WHY it failed, not just that it did. A bare count rendered as "19 failed" in the
  -- cockpit and the operator had to read worker.log to discover it was a Voyage free-tier
  -- rate limit -- a configuration state they could fix, not a defect.
  last_error TEXT,
  last_error_at_epoch INTEGER
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
    this.migrate();
  }

  /** Bring an EXISTING table up to the current schema.
   *
   *  `CREATE TABLE IF NOT EXISTS` is a no-op when the table is already there, so adding a
   *  column to SCHEMA changes nothing on any install that has run before — and the first
   *  query touching that column then throws `no such column`. That is exactly how
   *  last_error/last_error_at_epoch shipped: every existing captain's `/stats` returned 500,
   *  the cockpit reported the captain unreachable, and it took two operators noticing before
   *  it surfaced. A new column needs a migration every time, not just a schema edit.
   *
   *  Additive and idempotent: read the live column list, add only what is missing. */
  private migrate(): void {
    const cols = new Set(
      (this.db.query('PRAGMA table_info(pending_embed)').all() as Array<{ name: string }>)
        .map(r => r.name),
    );
    if (!cols.has('last_error')) this.db.exec('ALTER TABLE pending_embed ADD COLUMN last_error TEXT');
    if (!cols.has('last_error_at_epoch')) this.db.exec('ALTER TABLE pending_embed ADD COLUMN last_error_at_epoch INTEGER');
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

  markRetried(ids: number[], lastError?: string): void {
    if (ids.length === 0) return;
    // Clamp: this is an upstream error body and ends up on a dashboard.
    const err = lastError ? String(lastError).slice(0, 400) : null;
    const errAt = Math.floor(Date.now() / 1000);
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
        if (err !== null) {
          this.db
            .query('UPDATE pending_embed SET retries = ?, next_retry_at_epoch = ?, last_error = ?, last_error_at_epoch = ? WHERE id = ?')
            .run(nextRetries, next, err, errAt, id);
        } else {
          this.db
            .query('UPDATE pending_embed SET retries = ?, next_retry_at_epoch = ? WHERE id = ?')
            .run(nextRetries, next, id);
        }
      }
    });
    tx();
  }

  /** What is stuck, and WHY — the shape a dashboard can render without a log file.
   *  Reports the most RECENT failure: with one embedder, a backlog shares one cause, and
   *  showing five variants of the same 429 helps nobody. */
  failureState(): { pending: number; last_error: string | null; error_class: EmbedErrorClass | null; last_error_at_epoch: number | null } {
    const row = this.db
      .query(`SELECT COUNT(*) AS pending,
                     (SELECT last_error FROM pending_embed WHERE last_error IS NOT NULL
                       ORDER BY last_error_at_epoch DESC LIMIT 1) AS last_error,
                     (SELECT last_error_at_epoch FROM pending_embed WHERE last_error IS NOT NULL
                       ORDER BY last_error_at_epoch DESC LIMIT 1) AS last_error_at_epoch
                FROM pending_embed`)
      .get() as { pending: number; last_error: string | null; last_error_at_epoch: number | null };
    return {
      pending: row?.pending ?? 0,
      last_error: row?.last_error ?? null,
      error_class: row?.last_error ? classifyEmbedError(row.last_error) : null,
      last_error_at_epoch: row?.last_error_at_epoch ?? null,
    };
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
