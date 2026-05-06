import { Database } from 'bun:sqlite';
import type { ChannelType, Document } from '../shared/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  mtime_epoch INTEGER NOT NULL,
  last_indexed_epoch INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_documents_project_channel ON documents(project_id, channel);
`;

export interface UpsertDocumentInput {
  source_path: string;
  channel: ChannelType;
  project_id: string;
  sha: string;
  mtime_epoch: number;
  metadata: Record<string, unknown>;
}

export class MetaStore {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  upsertDocument(input: UpsertDocumentInput): number {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.db
      .query('SELECT id FROM documents WHERE source_path = ?')
      .get(input.source_path) as { id: number } | undefined;

    if (existing) {
      this.db
        .query(
          `UPDATE documents
           SET channel = ?, project_id = ?, sha = ?, mtime_epoch = ?,
               last_indexed_epoch = ?, metadata = ?
           WHERE id = ?`
        )
        .run(
          input.channel,
          input.project_id,
          input.sha,
          input.mtime_epoch,
          now,
          JSON.stringify(input.metadata),
          existing.id
        );
      return existing.id;
    }

    const result = this.db
      .query(
        `INSERT INTO documents (source_path, channel, project_id, sha, mtime_epoch, last_indexed_epoch, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.source_path,
        input.channel,
        input.project_id,
        input.sha,
        input.mtime_epoch,
        now,
        JSON.stringify(input.metadata)
      );
    return Number(result.lastInsertRowid);
  }

  getDocument(source_path: string): Document | null {
    const row = this.db
      .query('SELECT * FROM documents WHERE source_path = ?')
      .get(source_path) as
      | (Omit<Document, 'metadata'> & { metadata: string })
      | undefined;
    if (!row) return null;
    return { ...row, metadata: JSON.parse(row.metadata) };
  }

  deleteDocument(source_path: string): void {
    this.db.query('DELETE FROM documents WHERE source_path = ?').run(source_path);
  }

  close(): void {
    this.db.close();
  }
}
