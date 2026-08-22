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

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  skill_ref TEXT NOT NULL UNIQUE,
  skill_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  raw_content TEXT NOT NULL,
  source_path TEXT NOT NULL UNIQUE,
  source_agent TEXT NOT NULL,
  content_sha TEXT NOT NULL,
  frontmatter TEXT NOT NULL DEFAULT '{}',
  warnings TEXT NOT NULL DEFAULT '[]',
  imported_at_epoch INTEGER NOT NULL,
  updated_at_epoch INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_id ON skills(skill_id);
CREATE INDEX IF NOT EXISTS idx_skills_source_agent ON skills(source_agent);

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

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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

export interface SkillRecord {
  id: number;
  document_id: number;
  skill_ref: string;
  skill_id: string;
  name: string;
  description: string;
  instructions: string;
  raw_content: string;
  source_path: string;
  source_agent: string;
  content_sha: string;
  frontmatter: Record<string, string>;
  warnings: string[];
  imported_at_epoch: number;
  updated_at_epoch: number;
}

export type UpsertSkillInput = Omit<SkillRecord, 'id' | 'imported_at_epoch' | 'updated_at_epoch'>;

export interface KeywordHit {
  chunk_id: string;
  rank: number;        // FTS5 BM25 score (lower = more relevant; we'll invert)
}

/** Ceiling on how many tokens of a query reach FTS5.
 *
 *  MEASURED on this corpus (149,179 chunks, `chunks_fts MATCH` alone, no embedding):
 *
 *    tokens |   2  |  10  |  30   |  60   |  120  |  250
 *    time   | 271ms| 474ms| 1.06s | 2.15s | 4.85s | 13.47s      (~54 ms per token)
 *
 *  FTS5 unions ONE posting list per OR'd term before bm25 ever ranks anything, so the cost
 *  is linear in token count and the ranking cannot save you — the common words whose lists
 *  span most of the index are exactly the ones being unioned. Uncapped, a query crosses the
 *  10s thread-RPC deadline (REQUEST_DEADLINE_MS) at ~185 tokens and the request 503s with
 *  `thread_rpc_timeout`. A 1 KB body is ~170 tokens, which is why `/search/all` on one
 *  measured 10,003 ms → 503, and why a `/remember` dedup search over a large body did too.
 *  Inbound peer searches carry the requester's query text, so a fleet-mate sending a long
 *  query timed out the SERVING captain the same way.
 *
 *  32 holds the worst case near 1s while leaving far more signal than any real query needs. */
export const KEYWORD_MAX_TOKENS = 32;

/** Tokens to OR into an FTS5 MATCH: deduped, capped, original order preserved.
 *
 *  Selection is longest-first because token length is a cheap proxy for selectivity — the
 *  short tokens are the stopwords with the largest posting lists, i.e. the expensive ones
 *  that contribute least. Order is then restored so the expression still reads like the
 *  query, and so the behaviour is stable rather than dependent on sort tie-breaks. */
export function keywordMatchTokens(query: string, max: number = KEYWORD_MAX_TOKENS): string[] {
  const raw = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const t of raw) {
    const key = t.toLowerCase();   // FTS5's default tokenizer is case-insensitive, so "A" and "a" are one term
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(t);
  }
  if (tokens.length <= max) return tokens;
  return tokens
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.length - a.t.length || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map(({ t }) => t);
}

export class MetaStore {
  private db: Database;

  constructor(path: string, opts?: { readonly?: boolean }) {
    this.db = new Database(path, opts?.readonly ? { readonly: true } : undefined);
    if (!opts?.readonly) {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec(SCHEMA);
    }
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

  upsertSkill(input: UpsertSkillInput): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.query(
      `INSERT INTO skills (
         document_id, skill_ref, skill_id, name, description, instructions, raw_content,
         source_path, source_agent, content_sha, frontmatter, warnings,
         imported_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_path) DO UPDATE SET
         document_id = excluded.document_id,
         skill_ref = excluded.skill_ref,
         skill_id = excluded.skill_id,
         name = excluded.name,
         description = excluded.description,
         instructions = excluded.instructions,
         raw_content = excluded.raw_content,
         source_agent = excluded.source_agent,
         content_sha = excluded.content_sha,
         frontmatter = excluded.frontmatter,
         warnings = excluded.warnings,
         updated_at_epoch = excluded.updated_at_epoch`,
    ).run(
      input.document_id, input.skill_ref, input.skill_id, input.name, input.description,
      input.instructions, input.raw_content, input.source_path, input.source_agent,
      input.content_sha, JSON.stringify(input.frontmatter), JSON.stringify(input.warnings), now, now,
    );
  }

  private decodeSkill(row: Omit<SkillRecord, 'frontmatter' | 'warnings'> & {
    frontmatter: string; warnings: string;
  }): SkillRecord {
    return { ...row, frontmatter: JSON.parse(row.frontmatter), warnings: JSON.parse(row.warnings) };
  }

  getSkillBySourcePath(sourcePath: string): SkillRecord | null {
    const row = this.db.query('SELECT * FROM skills WHERE source_path = ?').get(sourcePath) as
      | (Omit<SkillRecord, 'frontmatter' | 'warnings'> & { frontmatter: string; warnings: string })
      | undefined;
    return row ? this.decodeSkill(row) : null;
  }

  getSkillByDocumentId(documentId: number): SkillRecord | null {
    const row = this.db.query('SELECT * FROM skills WHERE document_id = ?').get(documentId) as
      | (Omit<SkillRecord, 'frontmatter' | 'warnings'> & { frontmatter: string; warnings: string })
      | undefined;
    return row ? this.decodeSkill(row) : null;
  }

  getSkillByRef(skillRef: string): SkillRecord | null {
    const row = this.db.query('SELECT * FROM skills WHERE skill_ref = ?').get(skillRef) as
      | (Omit<SkillRecord, 'frontmatter' | 'warnings'> & { frontmatter: string; warnings: string })
      | undefined;
    return row ? this.decodeSkill(row) : null;
  }

  listSkills(limit = 100): SkillRecord[] {
    const rows = this.db.query('SELECT * FROM skills ORDER BY name, source_agent LIMIT ?').all(limit) as
      Array<Omit<SkillRecord, 'frontmatter' | 'warnings'> & { frontmatter: string; warnings: string }>;
    return rows.map((row) => this.decodeSkill(row));
  }

  /** Documents whose FILE NAME matches, optionally within one channel. The identifier a user holds
   *  is the doc_id (`memory:<basename>`) printed by search — not the absolute path, which they never
   *  see. `source_path` is unique per PATH, so one basename can legitimately exist in two directories;
   *  this returns EVERY match so the caller can refuse an ambiguous delete rather than guess which
   *  one was meant.
   *
   *  MEASURED on a real corpus (148,676 documents): 67 ms, a full SCAN either way. Passing `channel`
   *  does NOT speed it up, contrary to what this comment first claimed — idx_documents_project_channel
   *  is on (project_id, channel), so constraining `channel` alone leaves the leading column open and
   *  the index unusable: 67.08 ms with it, 66.96 ms without, i.e. identical. Keep passing it anyway,
   *  because it is a CORRECTNESS narrowing (it stops a basename colliding across channels), not an
   *  optimisation. ponytail: 67 ms is fine for a rare, confirmed, interactive delete; index the
   *  basename only if forget ever grows a bulk mode.
   *
   *  ESCAPE is not optional here — `_` is a LIKE wildcard and every remember-written name contains
   *  one (`reference_bench-2kb.md`), so an unescaped pattern would match unrelated documents and a
   *  delete would take the wrong file. */
  findDocumentsByBasename(basename: string, channel?: ChannelType): Document[] {
    const escaped = basename.replace(/[\\%_]/g, (c) => '\\' + c);
    const sql = 'SELECT * FROM documents WHERE (source_path = ? OR source_path LIKE ? ESCAPE \'\\\')'
      + (channel ? ' AND channel = ?' : '');
    const params: string[] = [basename, '%/' + escaped];
    if (channel) params.push(channel);
    const rows = this.db.query(sql).all(...params) as Array<Omit<Document, 'metadata'> & { metadata: string }>;
    return rows.map((r) => ({ ...r, metadata: JSON.parse(r.metadata) }));
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
    const tokens = keywordMatchTokens(query);
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

  /**
   * Count chunks still using the pre-v0.1.8 observation chunk shape — one
   * vector per fact or per narrative. Used by the upgrade command + worker
   * startup banner to decide whether the corpus needs rechunking.
   */
  countLegacyObservationChunks(): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM chunks
         WHERE json_extract(metadata, '$.field_type') IN ('fact', 'narrative')`
      )
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
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

  getKv(key: string): string | null {
    const row = this.db.query('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setKv(key: string, value: string): void {
    this.db.query(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  listKvPrefix(prefix: string): Array<{ key: string; value: string }> {
    const esc = prefix.replace(/[\\%_]/g, (c) => '\\' + c);
    return this.db
      .query("SELECT key, value FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key")
      .all(esc + '%') as Array<{ key: string; value: string }>;
  }

  deleteKv(key: string): void {
    this.db.query('DELETE FROM kv WHERE key = ?').run(key);
  }

  close(): void {
    this.db.close();
  }
}
