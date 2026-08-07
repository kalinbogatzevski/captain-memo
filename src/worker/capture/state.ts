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
    // EVENT CURSOR (additive, guarded like every other column here). Without it the driver could only
    // ask "has this marker changed?", and a live session's marker (mtime:size) changes on every append —
    // so extract() returned the WHOLE file again and every earlier turn was re-enqueued. A session
    // growing to N turns cost 1+2+…+N = N(N+1)/2 summarizer calls instead of N. Seen on a light OSS
    // install: codex at 8 950 observations (97.8% of the corpus) with 30 564 more queued.
    const cols = this.db.query('PRAGMA table_info(capture_ingested)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'events_ingested')) {
      this.db.exec('ALTER TABLE capture_ingested ADD COLUMN events_ingested INTEGER NOT NULL DEFAULT 0');
    }
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

  /** How many events of this session have already been enqueued. 0 when unseen. */
  ingestedCount(source: string, sessionId: string): number {
    const row = this.db
      .query('SELECT events_ingested FROM capture_ingested WHERE source = ? AND session_id = ?')
      .get(source, sessionId) as { events_ingested: number } | undefined;
    return row?.events_ingested ?? 0;
  }

  /** How many sessions of `source` actually PRODUCED something — `events_ingested > 0`.
   *  This is doctor's question: "is capture actually yielding observations?" A session marked
   *  ingested with events_ingested=0 (extract ran, decompressed fine, but the file matched a
   *  zero-event outcome — see codex-source's zero-turn warning) must NOT count here, or a
   *  payload-format rename that silently zeroes out every extract would still show doctor a
   *  green "N session(s) ingested" — precisely the incident this counter exists to catch.
   *
   *  Deliberately narrower than `capture status`'s own COUNT(*) query in
   *  src/cli/commands/capture.ts, which answers a different question — "how many sessions has
   *  capture SEEN/attempted" — and keeps counting zero-event sessions on purpose, because that
   *  raw touch-count is itself a useful troubleshooting signal there. Do not "align" the two;
   *  see the comment on that query for why. */
  ingestedSessions(source: string): number {
    const row = this.db
      .query('SELECT COUNT(*) AS n FROM capture_ingested WHERE source = ? AND events_ingested > 0')
      .get(source) as { n: number } | null;
    return row?.n ?? 0;
  }

  markIngested(source: string, sessionId: string, marker: string, nowEpoch: number, eventsIngested = 0): void {
    this.db
      .query(
        `INSERT INTO capture_ingested (source, session_id, marker, ingested_at_epoch, events_ingested)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source, session_id)
         DO UPDATE SET marker = excluded.marker, ingested_at_epoch = excluded.ingested_at_epoch,
                       events_ingested = excluded.events_ingested`,
      )
      .run(source, sessionId, marker, nowEpoch, eventsIngested);
  }

  close(): void {
    this.db.close();
  }
}
