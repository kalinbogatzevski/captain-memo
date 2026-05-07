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
  created_at_epoch INTEGER NOT NULL,
  processed_at_epoch INTEGER
);
CREATE INDEX IF NOT EXISTS idx_obsq_status ON observation_queue(status, created_at_epoch);
CREATE INDEX IF NOT EXISTS idx_obsq_session ON observation_queue(session_id, status);
`;

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
   * otherwise mark failed permanently.
   */
  markFailed(ids: number[], maxRetries = 3): void {
    if (ids.length === 0) return;
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        const row = this.db
          .query('SELECT retries FROM observation_queue WHERE id = ?')
          .get(id) as { retries: number } | undefined;
        if (!row) continue;
        const next = row.retries + 1;
        if (next >= maxRetries) {
          this.db
            .query(`UPDATE observation_queue SET status = 'failed', retries = ? WHERE id = ?`)
            .run(next, id);
        } else {
          this.db
            .query(`UPDATE observation_queue SET status = 'pending', retries = ? WHERE id = ?`)
            .run(next, id);
        }
      }
    });
    tx();
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
