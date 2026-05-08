import { Database } from 'bun:sqlite';
import type { RawObservationEvent, ObservationQueueStatus } from '../shared/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observation_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  retries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at_epoch INTEGER NOT NULL,
  processed_at_epoch INTEGER
);
CREATE INDEX IF NOT EXISTS idx_obsq_status ON observation_queue(status, created_at_epoch);
CREATE INDEX IF NOT EXISTS idx_obsq_session ON observation_queue(session_id, status);
`;
// Schema-evolution: add last_error column if upgrading from v0 schema. SQLite
// doesn't have IF NOT EXISTS for columns; we accept the error if it's already there.
const ALTER = `ALTER TABLE observation_queue ADD COLUMN last_error TEXT`;

export interface ObservationQueueRow {
  id: number;
  session_id: string;
  project_id: string;
  payload: RawObservationEvent;
  status: ObservationQueueStatus;
  retries: number;
  created_at_epoch: number;
}

export class ObservationQueue {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    try { this.db.exec(ALTER); } catch { /* column already exists */ }
    // Startup recovery: rows stuck in 'processing' from a worker crash should
    // be retried, not abandoned. Without this, the queue.processing counter
    // grows monotonically across restarts.
    this.db.exec(`UPDATE observation_queue SET status = 'pending' WHERE status = 'processing'`);
  }

  enqueue(event: RawObservationEvent): number {
    const result = this.db
      .query(
        `INSERT INTO observation_queue
          (session_id, project_id, payload, status, retries, created_at_epoch)
         VALUES (?, ?, ?, 'pending', 0, ?)`
      )
      .run(
        event.session_id,
        event.project_id,
        JSON.stringify(event),
        Math.floor(Date.now() / 1000)
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Atomically claim up to `limit` pending rows; flips them to processing.
   */
  takeBatch(limit: number): ObservationQueueRow[] {
    const rows = this.db.transaction(() => {
      const selected = this.db
        .query(
          `SELECT id, session_id, project_id, payload, status, retries, created_at_epoch
           FROM observation_queue
           WHERE status = 'pending'
           ORDER BY created_at_epoch ASC, id ASC
           LIMIT ?`
        )
        .all(limit) as Array<{
          id: number; session_id: string; project_id: string;
          payload: string; status: ObservationQueueStatus;
          retries: number; created_at_epoch: number;
        }>;
      if (selected.length === 0) return [];
      const ids = selected.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db
        .query(`UPDATE observation_queue SET status = 'processing' WHERE id IN (${placeholders})`)
        .run(...ids);
      return selected.map(r => ({
        ...r,
        status: 'processing' as const,
        payload: JSON.parse(r.payload) as RawObservationEvent,
      }));
    })();
    return rows;
  }

  markDone(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const now = Math.floor(Date.now() / 1000);
    this.db
      .query(
        `UPDATE observation_queue
         SET status = 'done', processed_at_epoch = ?
         WHERE id IN (${placeholders})`
      )
      .run(now, ...ids);
  }

  /**
   * Increment retries; if retries < maxRetries flip back to pending,
   * otherwise mark failed permanently. Stores the most recent error message
   * so /stats and doctor can surface why a row failed.
   */
  markFailed(ids: number[], maxRetries = 3, errorMessage?: string): void {
    if (ids.length === 0) return;
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        const row = this.db
          .query('SELECT retries FROM observation_queue WHERE id = ?')
          .get(id) as { retries: number } | undefined;
        if (!row) continue;
        const next = row.retries + 1;
        const status = next >= maxRetries ? 'failed' : 'pending';
        this.db
          .query(`UPDATE observation_queue SET status = ?, retries = ?, last_error = ? WHERE id = ?`)
          .run(status, next, errorMessage ?? null, id);
      }
    });
    tx();
  }

  /**
   * Mark rows as permanently failed regardless of retries — for errors that
   * would never succeed on retry (auth failure, schema rejection, etc.).
   * Stops the retry-storm pattern that would otherwise burn API quota.
   */
  markPermanent(ids: number[], errorMessage: string): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .query(`UPDATE observation_queue SET status = 'failed', last_error = ? WHERE id IN (${placeholders})`)
      .run(errorMessage, ...ids);
  }

  pendingCount(): number {
    return (this.db
      .query(`SELECT COUNT(*) AS n FROM observation_queue WHERE status = 'pending'`)
      .get() as { n: number }).n;
  }

  processingCount(): number {
    return (this.db
      .query(`SELECT COUNT(*) AS n FROM observation_queue WHERE status = 'processing'`)
      .get() as { n: number }).n;
  }

  failedCount(): number {
    return (this.db
      .query(`SELECT COUNT(*) AS n FROM observation_queue WHERE status = 'failed'`)
      .get() as { n: number }).n;
  }

  pendingForSession(sessionId: string): ObservationQueueRow[] {
    const rows = this.db
      .query(
        `SELECT id, session_id, project_id, payload, status, retries, created_at_epoch
         FROM observation_queue
         WHERE session_id = ? AND status IN ('pending', 'processing')
         ORDER BY created_at_epoch ASC, id ASC`
      )
      .all(sessionId) as Array<{
        id: number; session_id: string; project_id: string;
        payload: string; status: ObservationQueueStatus;
        retries: number; created_at_epoch: number;
      }>;
    return rows.map(r => ({ ...r, payload: JSON.parse(r.payload) as RawObservationEvent }));
  }

  close(): void {
    this.db.close();
  }
}
