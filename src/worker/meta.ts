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

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  sha TEXT NOT NULL,
  position INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS migration_progress (
  source_kind TEXT NOT NULL,         -- 'observation' | 'summary'
  source_id INTEGER NOT NULL,
  doc_sha TEXT NOT NULL,
  migrated_at_epoch INTEGER NOT NULL,
  PRIMARY KEY (source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_migration_kind ON migration_progress(source_kind);
`;

export interface UpsertDocumentInput {
  source_path: string;
  channel: ChannelType;
  project_id: string;
  sha: string;
  mtime_epoch: number;
  metadata: Record<string, unknown>;
}

export interface ChunkRow {
  id: number;
  document_id: number;
  chunk_id: string;
  text: string;
  sha: string;
  position: number;
  metadata: Record<string, unknown>;
}

export interface ChunkUpsertInput {
  chunk_id: string;
  text: string;
  sha: string;
  position: number;
  metadata: Record<string, unknown>;
}

export interface KeywordHit {
  chunk_id: string;
  rank: number;        // FTS5 BM25 score (lower = more relevant; we'll invert)
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

  replaceChunksForDocument(documentId: number, chunks: ChunkUpsertInput[]): void {
    const tx = this.db.transaction((docId: number, items: ChunkUpsertInput[]) => {
      this.db.query('DELETE FROM chunks WHERE document_id = ?').run(docId);
      const insert = this.db.query(
        `INSERT INTO chunks (document_id, chunk_id, text, sha, position, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const c of items) {
        insert.run(docId, c.chunk_id, c.text, c.sha, c.position, JSON.stringify(c.metadata));
      }
    });
    tx(documentId, chunks);
  }

  getChunksForDocument(documentId: number): ChunkRow[] {
    const rows = this.db
      .query('SELECT * FROM chunks WHERE document_id = ? ORDER BY position ASC')
      .all(documentId) as Array<Omit<ChunkRow, 'metadata'> & { metadata: string }>;
    return rows.map(r => ({ ...r, metadata: JSON.parse(r.metadata) }));
  }

  searchKeyword(query: string, topK: number): KeywordHit[] {
    // Tokenize natural-language queries on non-word boundaries (Unicode-aware
    // so Bulgarian/etc. tokens survive), then OR the tokens so any-overlap
    // matches rather than requiring full-phrase. Each token is double-quoted
    // so FTS5 doesn't interpret special characters as syntax.
    const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (tokens.length === 0) return [];
    const safeQuery = tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    const rows = this.db
      .query(
        `SELECT chunks.chunk_id AS chunk_id, chunks_fts.rank AS rank
         FROM chunks_fts
         JOIN chunks ON chunks.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY chunks_fts.rank
         LIMIT ?`
      )
      .all(safeQuery, topK) as KeywordHit[];
    return rows;
  }

  getChunkById(chunk_id: string): { chunk: ChunkRow; document: Document } | null {
    const chunkRow = this.db
      .query('SELECT * FROM chunks WHERE chunk_id = ?')
      .get(chunk_id) as (Omit<ChunkRow, 'metadata'> & { metadata: string }) | undefined;
    if (!chunkRow) return null;
    const docRow = this.db
      .query('SELECT * FROM documents WHERE id = ?')
      .get(chunkRow.document_id) as
      | (Omit<Document, 'metadata'> & { metadata: string })
      | undefined;
    if (!docRow) return null;
    return {
      chunk: { ...chunkRow, metadata: JSON.parse(chunkRow.metadata) },
      document: { ...docRow, metadata: JSON.parse(docRow.metadata) },
    };
  }

  stats(): { total_chunks: number; by_channel: Record<string, number> } {
    const total = this.db
      .query('SELECT COUNT(*) AS n FROM chunks')
      .get() as { n: number };
    const rows = this.db
      .query(
        `SELECT documents.channel AS channel, COUNT(chunks.id) AS n
         FROM chunks
         JOIN documents ON documents.id = chunks.document_id
         GROUP BY documents.channel`
      )
      .all() as Array<{ channel: string; n: number }>;
    const by_channel: Record<string, number> = {};
    for (const row of rows) by_channel[row.channel] = row.n;
    return { total_chunks: total.n, by_channel };
  }

  isMigrationDone(kind: 'observation' | 'summary', sourceId: number): boolean {
    const row = this.db
      .query('SELECT 1 AS ok FROM migration_progress WHERE source_kind = ? AND source_id = ?')
      .get(kind, sourceId) as { ok: number } | undefined;
    return row?.ok === 1;
  }

  markMigrationDone(
    kind: 'observation' | 'summary',
    sourceId: number,
    docSha: string,
  ): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .query(
        `INSERT OR REPLACE INTO migration_progress
           (source_kind, source_id, doc_sha, migrated_at_epoch)
         VALUES (?, ?, ?, ?)`,
      )
      .run(kind, sourceId, docSha, now);
  }

  migrationCounts(): { observation: number; summary: number } {
    const rows = this.db
      .query(
        `SELECT source_kind AS kind, COUNT(*) AS n
         FROM migration_progress GROUP BY source_kind`,
      )
      .all() as Array<{ kind: string; n: number }>;
    const out = { observation: 0, summary: 0 };
    for (const r of rows) {
      if (r.kind === 'observation' || r.kind === 'summary') out[r.kind] = r.n;
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}
