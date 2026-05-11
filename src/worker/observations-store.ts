import { Database } from 'bun:sqlite';
import type { Observation, ObservationType } from '../shared/types.ts';

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
// Schema-evolution: add branch column if upgrading from v0 schema.
const ALTER_BRANCH = `ALTER TABLE observations ADD COLUMN branch TEXT`;
// Schema-evolution: add work_tokens column (v0.1.6+).
const ALTER_WORK_TOKENS = `ALTER TABLE observations ADD COLUMN work_tokens INTEGER`;

export type NewObservation = Omit<Observation, 'id'>;

export class ObservationsStore {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    try {
      this.db.exec(ALTER_BRANCH);
    } catch (err) {
      const message = (err as Error).message ?? '';
      // SQLite emits "duplicate column name: branch" on re-run; that's the
      // expected idempotent case. Any other failure (disk full, locked DB,
      // WAL corruption) deserves a warning so it doesn't masquerade as
      // benign "already migrated".
      if (!/duplicate column/i.test(message)) {
        console.warn('[observations-store] ALTER TABLE failed unexpectedly:', message);
      }
    }
    try {
      this.db.exec(ALTER_WORK_TOKENS);
    } catch (err) {
      const message = (err as Error).message ?? '';
      if (!/duplicate column/i.test(message)) {
        console.warn('[observations-store] ALTER TABLE failed unexpectedly:', message);
      }
    }
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

  countAll(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
