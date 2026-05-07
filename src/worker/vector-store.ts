import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';

export interface VectorStoreOptions {
  dbPath: string;
  dimension: number;  // e.g., 1024 for voyage-4-nano
}

export interface AddVectorInput {
  id: string;
  embedding: number[];
}

export interface VectorQueryResult {
  id: string;
  distance: number;
}

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[__DIM__]
);

CREATE TABLE IF NOT EXISTS vec_chunk_meta (
  chunk_id TEXT NOT NULL,
  collection_name TEXT NOT NULL,
  PRIMARY KEY (collection_name, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_vec_chunk_meta_coll ON vec_chunk_meta(collection_name);
`;

export class VectorStore {
  private db: Database;
  private dimension: number;

  constructor(opts: VectorStoreOptions) {
    this.db = new Database(opts.dbPath);
    sqliteVec.load(this.db);
    this.dimension = opts.dimension;
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA.replace('__DIM__', String(opts.dimension)));
  }

  /**
   * No-op for sqlite-vec — collections are partitioned via the
   * vec_chunk_meta table, not separate virtual tables.
   * Provided for interface symmetry with potential future backends.
   */
  async ensureCollection(_name: string): Promise<void> {
    // intentionally empty
  }

  async add(collection: string, items: AddVectorInput[]): Promise<void> {
    if (items.length === 0) return;

    const deleteVec = this.db.query(`DELETE FROM vec_chunks WHERE chunk_id = ?`);
    const insertVec = this.db.query(
      `INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)`
    );
    const upsertMeta = this.db.query(
      `INSERT OR REPLACE INTO vec_chunk_meta(chunk_id, collection_name) VALUES (?, ?)`
    );

    const tx = this.db.transaction(() => {
      for (const item of items) {
        if (item.embedding.length !== this.dimension) {
          throw new Error(
            `embedding length ${item.embedding.length} does not match expected dimension ${this.dimension}`
          );
        }
        const blob = new Uint8Array(new Float32Array(item.embedding).buffer);
        // vec0 does not support INSERT OR REPLACE — delete first, then insert
        deleteVec.run(item.id);
        insertVec.run(item.id, blob);
        upsertMeta.run(item.id, collection);
      }
    });
    tx();
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .query(`DELETE FROM vec_chunks WHERE chunk_id IN (${placeholders})`)
      .run(...ids);
    this.db
      .query(
        `DELETE FROM vec_chunk_meta WHERE collection_name = ? AND chunk_id IN (${placeholders})`
      )
      .run(collection, ...ids);
  }

  async query(collection: string, embedding: number[], topK: number): Promise<VectorQueryResult[]> {
    if (embedding.length !== this.dimension) {
      throw new Error(
        `query embedding length ${embedding.length} does not match expected dimension ${this.dimension}`
      );
    }
    const blob = new Uint8Array(new Float32Array(embedding).buffer);
    const rows = this.db
      .query(
        `SELECT v.chunk_id, v.distance
         FROM vec_chunks v
         INNER JOIN vec_chunk_meta m ON v.chunk_id = m.chunk_id AND m.collection_name = ?
         WHERE v.embedding MATCH ?
           AND v.k = ?
         ORDER BY v.distance`
      )
      .all(collection, blob, topK) as Array<{ chunk_id: string; distance: number }>;
    return rows.map(r => ({ id: r.chunk_id, distance: r.distance }));
  }

  close(): void {
    this.db.close();
  }
}
