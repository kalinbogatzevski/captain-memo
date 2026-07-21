// Persisted capture bookkeeping: which sessions we've already ingested (dedup),
// and the per-source backfill cutoff (so a default-on install doesn't summarize
// the entire pre-existing history the first time it runs). A tiny standalone
// sqlite so capture stays decoupled from the observations store.

import { Database } from 'bun:sqlite';

export class CaptureState {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capture_ingested (
        source TEXT NOT NULL,
        session_id TEXT NOT NULL,
        marker TEXT NOT NULL,
        ingested_at_epoch INTEGER NOT NULL,
        PRIMARY KEY (source, session_id)
      );
      CREATE TABLE IF NOT EXISTS capture_meta (
        source TEXT PRIMARY KEY,
        cutoff_epoch INTEGER NOT NULL
      );
    `);
  }

  /** Backfill guard: record `nowEpoch` as the source's cutoff the first time it's
   *  seen, and return whatever the stored cutoff is. Sessions older than the
   *  cutoff are skipped, so enabling capture never floods on historical sessions. */
  ensureCutoff(source: string, nowEpoch: number): number {
    const row = this.db.query('SELECT cutoff_epoch FROM capture_meta WHERE source = ?').get(source) as
      | { cutoff_epoch: number }
      | undefined;
    if (row) return row.cutoff_epoch;
    this.db.query('INSERT INTO capture_meta (source, cutoff_epoch) VALUES (?, ?)').run(source, nowEpoch);
    return nowEpoch;
  }

  /** Clear a source's cutoff so a subsequent tick will ingest history too
   *  (used by an explicit backfill). */
  clearCutoff(source: string): void {
    this.db.query('DELETE FROM capture_meta WHERE source = ?').run(source);
  }

  wasIngested(source: string, sessionId: string, marker: string): boolean {
    const row = this.db.query('SELECT marker FROM capture_ingested WHERE source = ? AND session_id = ?').get(source, sessionId) as
      | { marker: string }
      | undefined;
    return !!row && row.marker === marker;
  }

  markIngested(source: string, sessionId: string, marker: string, nowEpoch: number): void {
    this.db
      .query(
        `INSERT INTO capture_ingested (source, session_id, marker, ingested_at_epoch)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source, session_id)
         DO UPDATE SET marker = excluded.marker, ingested_at_epoch = excluded.ingested_at_epoch`,
      )
      .run(source, sessionId, marker, nowEpoch);
  }

  close(): void {
    this.db.close();
  }
}
