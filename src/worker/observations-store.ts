import { Database } from 'bun:sqlite';
import type { Observation, ObservationType } from '../shared/types.ts';
import { applyMigrations } from './migrations.ts';
import type { Migration } from './migrations.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  narrative TEXT NOT NULL DEFAULT '',
  facts TEXT NOT NULL DEFAULT '[]',
  concepts TEXT NOT NULL DEFAULT '[]',
  files_read TEXT NOT NULL DEFAULT '[]',
  files_modified TEXT NOT NULL DEFAULT '[]',
  created_at_epoch INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id, created_at_epoch);
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project_id, created_at_epoch DESC);
`;

export const OBSERVATIONS_STORE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'add_branch',
    up: (db) => db.exec('ALTER TABLE observations ADD COLUMN branch TEXT'),
  },
  {
    version: 2,
    name: 'add_work_tokens',
    up: (db) => db.exec('ALTER TABLE observations ADD COLUMN work_tokens INTEGER'),
  },
  {
    version: 3,
    name: 'add_stored_tokens',
    up: (db) => db.exec('ALTER TABLE observations ADD COLUMN stored_tokens INTEGER'),
  },
];

export type NewObservation = Omit<Observation, 'id' | 'stored_tokens'>;

export class ObservationsStore {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    applyMigrations(this.db, OBSERVATIONS_STORE_MIGRATIONS);
  }

  insert(obs: NewObservation): number {
    const result = this.db
      .query(
        `INSERT INTO observations
          (session_id, project_id, prompt_number, type, title, narrative,
           facts, concepts, files_read, files_modified, created_at_epoch, branch, work_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        obs.session_id, obs.project_id, obs.prompt_number, obs.type, obs.title,
        obs.narrative,
        JSON.stringify(obs.facts),
        JSON.stringify(obs.concepts),
        JSON.stringify(obs.files_read),
        JSON.stringify(obs.files_modified),
        obs.created_at_epoch,
        obs.branch ?? null,
        obs.work_tokens ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  private hydrate(row: Record<string, unknown>): Observation {
    return {
      id: Number(row.id),
      session_id: String(row.session_id),
      project_id: String(row.project_id),
      prompt_number: Number(row.prompt_number),
      type: row.type as ObservationType,
      title: String(row.title),
      narrative: String(row.narrative),
      facts: JSON.parse(String(row.facts)),
      concepts: JSON.parse(String(row.concepts)),
      files_read: JSON.parse(String(row.files_read)),
      files_modified: JSON.parse(String(row.files_modified)),
      created_at_epoch: Number(row.created_at_epoch),
      branch: typeof row.branch === 'string' ? row.branch : null,
      work_tokens: typeof row.work_tokens === 'number' ? row.work_tokens : null,
      stored_tokens: typeof row.stored_tokens === 'number' ? row.stored_tokens : null,
    };
  }

  findById(id: number): Observation | null {
    const row = this.db.query('SELECT * FROM observations WHERE id = ?').get(id) as
      | Record<string, unknown> | undefined;
    return row ? this.hydrate(row) : null;
  }

  listForSession(sessionId: string): Observation[] {
    const rows = this.db
      .query('SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC, id ASC')
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(r => this.hydrate(r));
  }

  listRecent(limit: number): Observation[] {
    const rows = this.db
      .query('SELECT * FROM observations ORDER BY created_at_epoch DESC, id DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => this.hydrate(r));
  }

  *iterateAll(): Generator<Observation> {
    const rows = this.db
      .query('SELECT * FROM observations ORDER BY id ASC')
      .iterate() as IterableIterator<Record<string, unknown>>;
    for (const row of rows) yield this.hydrate(row);
  }

  countAll(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n;
  }

  setStoredTokens(id: number, tokens: number): void {
    this.db
      .query('UPDATE observations SET stored_tokens = ? WHERE id = ?')
      .run(tokens, id);
  }

  /** Count observations whose stored_tokens has not been captured yet. */
  countMissingStoredTokens(): number {
    return (this.db
      .query('SELECT COUNT(*) AS n FROM observations WHERE stored_tokens IS NULL')
      .get() as { n: number }).n;
  }

  /** Oldest-first batch of observations still missing stored_tokens. */
  listMissingStoredTokens(limit: number): Observation[] {
    const rows = this.db
      .query('SELECT * FROM observations WHERE stored_tokens IS NULL ORDER BY id ASC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => this.hydrate(r));
  }

  /**
   * Sum work_tokens and stored_tokens over the SAME observations — only rows
   * carrying BOTH values. Summing them independently would divide totals
   * describing different populations and yield a meaningless ratio.
   */
  sumPairedTokens(): { work: number; stored: number; paired: number } {
    return this.db
      .query(
        `SELECT COALESCE(SUM(work_tokens), 0)   AS work,
                COALESCE(SUM(stored_tokens), 0) AS stored,
                COUNT(*)                        AS paired
         FROM observations
         WHERE work_tokens IS NOT NULL AND stored_tokens IS NOT NULL`,
      )
      .get() as { work: number; stored: number; paired: number };
  }

  close(): void {
    this.db.close();
  }
}
