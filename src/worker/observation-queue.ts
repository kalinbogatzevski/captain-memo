import { Database } from 'bun:sqlite';
import type { RawObservationEvent, ObservationQueueStatus } from '../shared/types.ts';
import { applyMigrations } from './migrations.ts';
import type { Migration } from './migrations.ts';

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

export const OBSERVATION_QUEUE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'add_last_error',
    up: (db) => db.exec('ALTER TABLE observation_queue ADD COLUMN last_error TEXT'),
  },
];

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
    applyMigrations(this.db, OBSERVATION_QUEUE_MIGRATIONS);
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

  /** Drop pending rows that are re-enqueued copies of a turn this queue already holds.
   *
   *  Repair tool for the capture amplification bug: a growing session's marker (mtime:size) changed on
   *  every append while extract() had no cursor, so the whole file was re-enqueued each tick. An
   *  affected install carries tens of thousands of pending rows that re-summarise turns it already has,
   *  and each one is a real LLM call — draining them costs money to produce nothing.
   *
   *  Identity is (session_id, prompt_number): "1-based index within the session", stable across
   *  re-extracts of an append-only log. Deliberately NOT the whole payload — codex-source seeds its
   *  clock from now() when a session carries no timestamps, so ts_epoch can differ between extracts of
   *  the same turn and payload equality would miss real duplicates.
   *
   *  Two classes are removed, and nothing else:
   *    1. a pending row whose turn is already `done` — it has been summarised; re-doing it is waste;
   *    2. pending rows duplicating another pending row — the lowest id is kept.
   *  Rows in `processing` are never touched, and never used to justify deleting a sibling: a row being
   *  summarised right now must not have its only twin removed out from under the worker.
   *
   *  `apply: false` (the default) reports what it WOULD do and changes nothing. */
  dedupePending(opts: { apply?: boolean } = {}): {
    duplicate_of_done: number; duplicate_pending: number; pending_before: number; applied: boolean;
  } {
    const apply = opts.apply === true;
    const key = "json_extract(payload,'$.session_id') || '|' || json_extract(payload,'$.prompt_number')";
    const pendingBefore = this.pendingCount();

    const ofDone = this.db.query(
      `SELECT id FROM observation_queue WHERE status = 'pending' AND ${key} IN
         (SELECT ${key} FROM observation_queue WHERE status = 'done')`,
    ).all() as Array<{ id: number }>;

    const dupPending = this.db.query(
      `SELECT id FROM observation_queue WHERE status = 'pending'
         AND id NOT IN (SELECT MIN(id) FROM observation_queue WHERE status = 'pending' GROUP BY ${key})
         AND id NOT IN (${ofDone.map(r => r.id).join(',') || '-1'})`,
    ).all() as Array<{ id: number }>;

    if (apply) {
      const ids = [...ofDone, ...dupPending].map(r => r.id);
      const tx = this.db.transaction(() => {
        for (let i = 0; i < ids.length; i += 500) {
          const slice = ids.slice(i, i + 500);
          this.db.query(`DELETE FROM observation_queue WHERE id IN (${slice.map(() => '?').join(',')})`)
            .run(...slice);
        }
      });
      tx();
    }
    return {
      duplicate_of_done: ofDone.length,
      duplicate_pending: dupPending.length,
      pending_before: pendingBefore,
      applied: apply,
    };
  }

  /** How many finished rows are being retained. */
  doneCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM observation_queue WHERE status = 'done'")
      .get() as { n: number }).n;
  }

  /** Test seam: backdate a row's completion so retention can be exercised deterministically. */
  _setProcessedAt(id: number, epochSeconds: number): void {
    this.db.query('UPDATE observation_queue SET processed_at_epoch = ? WHERE id = ?').run(epochSeconds, id);
  }

  /** Drop finished rows completed before `olderThanEpoch`. Returns how many went.
   *
   *  Nothing deleted from this table, ever — markDone only flips a status — so it grew without bound on
   *  every install. One live captain reached 235,899 rows in a 610.9 MB queue.db, all of it work already
   *  done and long since written into observations.db.
   *
   *  ONLY `done` rows are eligible. pending/processing/failed are live or actionable state: a failed row
   *  is a thing an operator may still want to see, and deleting a processing row would pull work out from
   *  under the worker mid-flight.
   *
   *  The trade to know about: dedupePending reads done rows to recognise "this turn was already
   *  summarised", so a shorter window makes that repair blind to older work. It still catches
   *  duplicate-of-pending either way, and the amplification that made the repair necessary is fixed —
   *  but this is why the default window is generous rather than a day or two. */
  pruneDone(olderThanEpoch: number): number {
    const r = this.db
      .query("DELETE FROM observation_queue WHERE status = 'done' AND processed_at_epoch < ?")
      .run(olderThanEpoch);
    return Number(r.changes ?? 0);
  }

  /** Return freed pages to the filesystem. SQLite does NOT shrink a file on DELETE — the pages go on the
   *  free list and the 610 MB stays 610 MB — so a prune without this reclaims nothing an operator can
   *  see. VACUUM rewrites the file and needs room for a copy, which is why it is a separate, deliberate
   *  call rather than something folded into every prune. */
  reclaim(): void {
    this.db.exec('VACUUM');
    // …and CHECKPOINT, or in WAL mode the rewrite lands in the -wal file and the main database is
    // exactly as large as before. Measured: VACUUM alone left a 2.8 MB test file at 2.8 MB.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
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

  /**
   * Flip rows back to 'pending' WITHOUT counting a retry — for a transient outage
   * (summarizer API overloaded/unreachable) that must NOT dead-letter observations.
   * The obs-batch backoff cooldown handles the spacing; markFailed's retry counter
   * is reserved for genuine per-item failures that should eventually dead-letter.
   */
  requeue(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .query(`UPDATE observation_queue SET status = 'pending' WHERE id IN (${placeholders})`)
      .run(...ids);
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
