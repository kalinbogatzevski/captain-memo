import { Database } from 'bun:sqlite';
import { ensureExtensionCapableSqlite, isExtensionLoadingUnsupported, MACOS_SQLITE_REMEDY } from '../shared/sqlite-extensions.ts';
import * as sqliteVec from 'sqlite-vec';
import { DEFAULT_IVF_CONFIG, nearestCentroid, nearestCentroids, type IvfConfig, type Centroid } from './ivf.ts';

export interface VectorStoreOptions {
  dbPath: string;
  dimension: number;  // e.g., 1024 for voyage-4-nano
  /** Open the db read-only (reader-engine mode): skip WAL pragma + schema DDL.
   *  The file must already exist and be initialized by the writer. */
  readonly?: boolean;
  /** A2: governs the clustered-query probe width. Defaults to DEFAULT_IVF_CONFIG
   *  so existing call sites that don't pass this are unaffected. */
  ivfConfig?: IvfConfig;
}

export interface AddVectorInput {
  id: string;
  embedding: number[];
}

export interface VectorQueryResult {
  id: string;
  distance: number;
}

/** Unclustered sentinel — chunks not yet assigned a real cluster carry this
 *  value. Never NULL: NULL-partition-key behavior in vec0 was never verified,
 *  and an explicit sentinel is unambiguous in every query (Task 2 spike). */
const UNCLUSTERED = -1;

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[__DIM__]
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks_p USING vec0(
  chunk_id TEXT PRIMARY KEY,
  cluster_id INTEGER PARTITION KEY,
  embedding FLOAT[__DIM__]
);

CREATE TABLE IF NOT EXISTS vec_chunk_meta (
  chunk_id TEXT NOT NULL,
  collection_name TEXT NOT NULL,
  PRIMARY KEY (collection_name, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_vec_chunk_meta_coll ON vec_chunk_meta(collection_name);

CREATE TABLE IF NOT EXISTS vec_cluster_centroids (
  collection_name TEXT NOT NULL,
  cluster_id INTEGER NOT NULL,
  hit_count INTEGER NOT NULL,
  centroid BLOB NOT NULL,
  PRIMARY KEY (collection_name, cluster_id)
);

CREATE TABLE IF NOT EXISTS vec_cluster_id_seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_id INTEGER NOT NULL
);
`;
const SEED_SEQ = `INSERT OR IGNORE INTO vec_cluster_id_seq (id, next_id) VALUES (1, 0);`;
// A real persisted sequence, not "MAX(cluster_id) already committed to
// vec_cluster_centroids" — allocateClusterIds must reserve immediately and
// atomically, since a caller may allocate before it ever persists a centroid
// (or, as in this file's own tests, allocate standalone without persisting at
// all). Deriving from MAX() would hand out the same range twice if called
// again before the first allocation's centroids are written.
// vec_chunks (no partition key) is the pre-A2 shape, kept for backward
// compatibility with existing installs — see migrateLegacyBatch. It is NEVER
// renamed or dropped (ALTER TABLE RENAME on a vec0 table was spiked and found
// to silently break the table's internal _rowids shadow table). All new reads
// and writes go through vec_chunks_p; vec_chunks only shrinks, via DELETE, as
// migrateLegacyBatch copies its rows across.

export class VectorStore {
  /** Prepared once and reused: reassignment runs across the whole corpus during an index build,
   *  and re-preparing per row was a measurable share of an 18-hour job. */
  private reassignDelStmt: ReturnType<Database['query']> | null = null;
  private reassignInsStmt: ReturnType<Database['query']> | null = null;

  private db: Database;
  private dimension: number;
  private ivfConfig: IvfConfig;

  constructor(opts: VectorStoreOptions) {
    // macOS links Bun against Apple's libsqlite3, which is built WITHOUT extension
    // loading — so vec0 cannot load at all. Point Bun at a Homebrew SQLite first. No-op
    // on Linux/Windows, where Bun bundles its own capable build.
    ensureExtensionCapableSqlite();
    this.db = new Database(opts.dbPath, opts.readonly ? { readonly: true } : undefined);
    try {
      sqliteVec.load(this.db);   // the vec0 extension is needed to READ as well as write
    } catch (err) {
      // Re-throw with the remedy attached. The bare message names sqlite-vec's internals
      // and gives a user no idea that `brew install sqlite` is the whole fix — it sent the
      // first macOS user chasing launchd instead.
      if (isExtensionLoadingUnsupported(err)) {
        throw new Error(`${err instanceof Error ? err.message : String(err)}\n\n${MACOS_SQLITE_REMEDY}`);
      }
      throw err;
    }
    this.dimension = opts.dimension;
    this.ivfConfig = opts.ivfConfig ?? DEFAULT_IVF_CONFIG;
    if (!opts.readonly) {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec(SCHEMA.replace(/__DIM__/g, String(opts.dimension)));
      this.db.exec(SEED_SEQ); // unchanged from Task 2 — keep this line, don't drop it
    }
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

    // If this collection is already clustered, assign each new chunk to its
    // nearest existing centroid immediately — otherwise it would sit invisible
    // to the clustered read path (queryClustered only searches real cluster
    // ids, never the unclustered sentinel) until the next sweep tick picks it
    // up, up to sweepIntervalMs later. Fetched once per add() call, not once
    // per collection-less-common-case; cheap even so (a few hundred rows).
    const centroids = this.getCentroids(collection);

    const deleteVec = this.db.query(`DELETE FROM vec_chunks_p WHERE chunk_id = ?`);
    const insertVec = this.db.query(
      `INSERT INTO vec_chunks_p(chunk_id, cluster_id, embedding) VALUES (?, ?, ?)`
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
        const nearest = centroids.length > 0 ? nearestCentroid(item.embedding, centroids) : null;
        const clusterId = nearest ? nearest.clusterId : UNCLUSTERED;
        // vec0 does not support INSERT OR REPLACE — delete first, then insert
        deleteVec.run(item.id);
        insertVec.run(item.id, clusterId, blob);
        upsertMeta.run(item.id, collection);
      }
    });
    tx();
  }

  /**
   * Read a stored embedding back out by chunk id, without re-embedding.
   * Returns the raw stored vector, or null if the chunk id isn't present.
   * The vec0 `embedding` column reads back as a raw little-endian float32 BLOB
   * (a Uint8Array), so we view those bytes directly as a Float32Array.
   */
  getEmbedding(chunkId: string): Float32Array | null {
    const row = this.db
      .query(`SELECT embedding FROM vec_chunks_p WHERE chunk_id = ?`)
      .get(chunkId) as { embedding: Uint8Array } | null;
    if (!row) return null;
    const buf = row.embedding;
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .query(`DELETE FROM vec_chunks_p WHERE chunk_id IN (${placeholders})`)
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
    const centroids = this.getCentroids(collection);
    if (centroids.length === 0) {
      return this.queryUnfiltered(collection, embedding, topK);
    }
    return this.queryClustered(collection, embedding, topK, centroids);
  }

  /** Today's exact brute-force scan — used when a collection has no centroids
   *  yet (below the clustering threshold, or not reached by the backfill sweep).
   *
   *  Also unions in the OLD `vec_chunks` table's results whenever any legacy
   *  rows remain uncopied. This is a required correctness net, not an edge
   *  case: `add()`/`query()` operate exclusively on `vec_chunks_p`, so without
   *  this, any chunk the migration sweep hasn't reached yet — which, on the
   *  default (IVF-disabled) config, could mean the ENTIRE pre-upgrade corpus,
   *  forever, if the sweep were ever gated on `enabled` — would be silently
   *  invisible to every search. (It isn't gated that way — see
   *  runIvfSweepSlice — but this union is a second, independent safety net in
   *  case that invariant is ever broken by a future change.) */
  private async queryUnfiltered(collection: string, embedding: number[], topK: number): Promise<VectorQueryResult[]> {
    const blob = new Uint8Array(new Float32Array(embedding).buffer);
    const rows = this.db
      .query(
        `SELECT v.chunk_id, v.distance
         FROM vec_chunks_p v
         INNER JOIN vec_chunk_meta m ON v.chunk_id = m.chunk_id AND m.collection_name = ?
         WHERE v.embedding MATCH ?
           AND v.k = ?`
      )
      .all(collection, blob, topK) as Array<{ chunk_id: string; distance: number }>;

    if (this.countLegacyRows() === 0) {
      return rows.map(r => ({ id: r.chunk_id, distance: r.distance }));
    }
    const legacyRows = this.db
      .query(
        `SELECT v.chunk_id, v.distance
         FROM vec_chunks v
         INNER JOIN vec_chunk_meta m ON v.chunk_id = m.chunk_id AND m.collection_name = ?
         WHERE v.embedding MATCH ?
           AND v.k = ?`
      )
      .all(collection, blob, topK) as Array<{ chunk_id: string; distance: number }>;
    // A chunk_id can never appear in both tables at once — migrateLegacyBatch's
    // insert-then-delete happens inside one transaction, so any other reader
    // (including this same connection between separate statements) always sees
    // either the fully-old or fully-new state, never both. Straight concat is safe.
    return [...rows, ...legacyRows]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, topK)
      .map(r => ({ id: r.chunk_id, distance: r.distance }));
  }

  /** IVF fast path: probe the M nearest clusters (by centroid cosine
   *  similarity) via a single `cluster_id IN (...)` KNN query — plus the
   *  unclustered sentinel (-1), always. Bootstrap seeds centroids in one step
   *  but reassigns no rows (runIvfSweepSlice's centroid-seeding branch only
   *  calls setCentroids), so the instant a collection first gets centroids,
   *  its ENTIRE corpus is still sitting at cluster_id = -1. Without -1 in the
   *  probe set, every row the bounded assign-sweep hasn't reached yet would
   *  be unreachable by search until its own sweep tick — up to corpus/
   *  sweepBatch ticks (minutes to hours on a real corpus) — which contradicts
   *  the spec's guarantee that only speed, never recall, is at risk during
   *  the transition. This is NOT the accepted top-M-probe recall/speed
   *  tradeoff (an unprobed but real cluster) — these rows are in NO cluster
   *  at all. The -1 partition scans like brute force early on and empties as
   *  backfill completes.
   *
   *  Real cluster ids are globally unique across collections (see
   *  allocateClusterIds), so filtering on those alone needs no collection
   *  join. -1 breaks that assumption — every collection's not-yet-assigned
   *  rows share the same sentinel — so once -1 is in the probe set the
   *  vec_chunk_meta join (same shape as queryUnfiltered) is required to keep
   *  another collection's still-unclustered rows from leaking into these
   *  results.
   *
   *  vec0's `cluster_id IN (...)` KNN does NOT globally merge-sort across the
   *  listed partitions (verified directly — contra this file's own earlier
   *  assumption/the design spec's "already-merged, pre-sorted" note): each
   *  partition's own top-`k` rows come back concatenated in ascending
   *  partition-id order, not resorted by distance, and since -1 sorts before
   *  every real (non-negative) cluster id, its rows would always land first
   *  regardless of true distance — exactly backwards during backfill, when
   *  -1 holds most of the corpus. Sorting+slicing here (same pattern
   *  queryUnfiltered already uses to merge its two table sources) fixes that
   *  and is lossless: each partition is queried with the full `topK`, so the
   *  concatenated rows are a superset of the true global top-`k` — sorting
   *  and slicing recovers it exactly. */
  private async queryClustered(
    collection: string,
    embedding: number[],
    topK: number,
    centroids: Centroid[],
  ): Promise<VectorQueryResult[]> {
    const nearest = nearestCentroids(embedding, centroids, this.ivfConfig.probeClusters);
    const clusterIds = [...nearest.map(c => c.clusterId), UNCLUSTERED];
    const blob = new Uint8Array(new Float32Array(embedding).buffer);
    const placeholders = clusterIds.map(() => '?').join(',');
    const rows = this.db
      .query(
        `SELECT v.chunk_id, v.distance FROM vec_chunks_p v
         INNER JOIN vec_chunk_meta m ON v.chunk_id = m.chunk_id AND m.collection_name = ?
         WHERE v.cluster_id IN (${placeholders})
           AND v.embedding MATCH ?
           AND v.k = ?`
      )
      .all(collection, ...clusterIds, blob, topK) as Array<{ chunk_id: string; distance: number }>;
    return rows
      .sort((a, b) => a.distance - b.distance)
      .slice(0, topK)
      .map(r => ({ id: r.chunk_id, distance: r.distance }));
  }

  // --- A2: clustering storage. All new methods below operate on vec_chunks_p. ---

  /** Total vector count for a collection — drives the clustering-size
   *  threshold and K sizing. */
  countVectors(collection: string): number {
    // Counted from the meta table ALONE. The joined form measured **114,711 ms** against the real
    // 143k-vector store versus 16 ms this way — and it ran once per sweep slice, on the writer
    // thread, which is the whole reason an index build made the worker stop answering. A count
    // that takes two minutes is not a slow query, it is an outage.
    //
    // Sound because the two tables are written together: add() inserts into vec_chunks_p and
    // vec_chunk_meta in the same operation, and delete() removes from both. One meta row per
    // (collection, chunk) is exactly the number being asked for.
    const row = this.db
      .query(`SELECT count(*) as n FROM vec_chunk_meta WHERE collection_name = ?`)
      .get(collection) as { n: number };
    return row.n;
  }

  /** All centroids currently stored for a collection. Empty when clustering
   *  hasn't started yet — callers treat that as "use the brute-force fallback." */
  getCentroids(collection: string): Centroid[] {
    const rows = this.db
      .query(`SELECT cluster_id, hit_count, centroid FROM vec_cluster_centroids WHERE collection_name = ?`)
      .all(collection) as Array<{ cluster_id: number; hit_count: number; centroid: Uint8Array }>;
    return rows.map(r => {
      const buf = r.centroid;
      const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      return { clusterId: r.cluster_id, vector: Array.from(floats), hitCount: r.hit_count };
    });
  }

  /** Replace the full centroid set for a collection. Does not touch other
   *  collections' centroids. */
  setCentroids(collection: string, centroids: Centroid[]): void {
    const del = this.db.query(`DELETE FROM vec_cluster_centroids WHERE collection_name = ?`);
    const ins = this.db.query(
      `INSERT INTO vec_cluster_centroids (collection_name, cluster_id, hit_count, centroid) VALUES (?, ?, ?, ?)`
    );
    const tx = this.db.transaction(() => {
      del.run(collection);
      for (const c of centroids) {
        const blob = new Uint8Array(new Float32Array(c.vector).buffer);
        ins.run(collection, c.clusterId, c.hitCount, blob);
      }
    });
    tx();
  }

  /** Allocate `n` globally-unique cluster ids (never reused, never reset per
   *  collection — see Global Constraints), so a bare `cluster_id IN (...)`
   *  filter on vec_chunks_p is always collection-correct with no join needed.
   *  Backed by a real persisted sequence (reserved atomically, immediately —
   *  not derived from what's already committed to vec_cluster_centroids,
   *  which would hand out the same range twice if called again before the
   *  first allocation's centroids are persisted). */
  allocateClusterIds(_collection: string, n: number): number[] {
    const tx = this.db.transaction((): number => {
      const row = this.db.query(`SELECT next_id FROM vec_cluster_id_seq WHERE id = 1`).get() as { next_id: number };
      this.db.query(`UPDATE vec_cluster_id_seq SET next_id = ? WHERE id = 1`).run(row.next_id + n);
      return row.next_id;
    });
    const start = tx();
    return Array.from({ length: n }, (_, i) => start + i);
  }

  /** Chunk ids still carrying the unclustered sentinel, oldest first, up to `limit`. */
  getUnclusteredChunks(collection: string, limit: number): Array<{ chunkId: string; embedding: Float32Array }> {
    // TWO STEPS, deliberately. The obvious single JOIN measured 5,141 ms for 64 rows against the
    // real store versus 115 ms this way — 45x — and that cost was per sweep slice, on the writer
    // thread, which is what made an index build take the worker offline rather than merely take
    // a while.
    //
    // The plan explains it: SQLite drives from vec_chunk_meta, scanning every one of its 141k rows
    // for the collection and probing the virtual table for each, because LIMIT cannot be applied
    // until after the join. Taking candidates from the vec table FIRST bounds the work to `limit`
    // rows, and the collection check is then a prefix match on the (collection_name, chunk_id)
    // primary key over exactly those ids.
    const candidates = this.db
      .query(`SELECT chunk_id, embedding FROM vec_chunks_p WHERE cluster_id = ${UNCLUSTERED} LIMIT ?`)
      .all(limit) as Array<{ chunk_id: string; embedding: Uint8Array }>;
    return this.filterToCollection(collection, candidates);
  }

  /** Keep only the rows belonging to `collection`. Indexed prefix lookup over the ids given,
   *  rather than a join that would scan the whole meta table. */
  private filterToCollection<T extends { chunk_id: string; embedding: Uint8Array }>(
    collection: string, rows: T[],
  ): Array<{ chunkId: string; embedding: Float32Array }> {
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => '?').join(',');
    const inCollection = new Set(
      (this.db
        .query(`SELECT chunk_id FROM vec_chunk_meta WHERE collection_name = ? AND chunk_id IN (${placeholders})`)
        .all(collection, ...rows.map(r => r.chunk_id)) as Array<{ chunk_id: string }>)
        .map(r => r.chunk_id),
    );
    return rows
      .filter(r => inCollection.has(r.chunk_id))
      .map(r => ({
        chunkId: r.chunk_id,
        embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
      }));
  }

  /** Sample of vectors for a collection regardless of cluster state — used
   *  ONLY for bootstrap seeding (every row is still unclustered at that point,
   *  so a cluster-state filter would return nothing). */
  sampleAnyVectors(collection: string, limit: number): Array<{ chunkId: string; embedding: Float32Array }> {
    // Two steps for the same reason as getUnclusteredChunks: LIMIT cannot apply until after a
    // join, so the joined form scans the whole meta table before discarding all but `limit` rows.
    const candidates = this.db
      .query(`SELECT chunk_id, embedding FROM vec_chunks_p LIMIT ?`)
      .all(limit) as Array<{ chunk_id: string; embedding: Uint8Array }>;
    return this.filterToCollection(collection, candidates);
  }

  /** Sample of already-clustered vectors (cluster_id != sentinel) for a
   *  collection, including each one's current cluster — used by the periodic
   *  rebalance step, which needs to know whether a re-sampled vector's nearest
   *  centroid actually changed. Uses a plain LIMIT, not ORDER BY RANDOM() (that
   *  would force a full-table sort every tick) — so this returns the same
   *  leading rows every call. Deliberate MVP limitation: rebalancing adapts
   *  slowly to later-arriving data rather than rotating through the whole
   *  corpus; cursor-based rotation is named future work, not built here. */
  sampleClusteredVectors(
    collection: string,
    limit: number,
  ): Array<{ chunkId: string; embedding: Float32Array; clusterId: number }> {
    // Two-step, as above. This one also needs each row's current cluster, so it keeps its own
    // map rather than going through filterToCollection.
    const candidates = this.db
      .query(`SELECT chunk_id, embedding, cluster_id FROM vec_chunks_p
               WHERE cluster_id != ${UNCLUSTERED} LIMIT ?`)
      .all(limit) as Array<{ chunk_id: string; embedding: Uint8Array; cluster_id: number }>;
    if (candidates.length === 0) return [];
    const placeholders = candidates.map(() => '?').join(',');
    const inCollection = new Set(
      (this.db
        .query(`SELECT chunk_id FROM vec_chunk_meta WHERE collection_name = ? AND chunk_id IN (${placeholders})`)
        .all(collection, ...candidates.map(c => c.chunk_id)) as Array<{ chunk_id: string }>)
        .map(r => r.chunk_id),
    );
    return candidates
      .filter(r => inCollection.has(r.chunk_id))
      .map(r => ({
        chunkId: r.chunk_id,
        embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
        clusterId: r.cluster_id,
      }));
  }

  /** Move a chunk to a new cluster. UPDATE on a partition-key column is
   *  rejected by vec0 (spiked directly) — every reassignment is delete then
   *  reinsert. `embedding` is passed in (not re-read) since callers already
   *  have it from whichever batch-read produced this chunk. */
  /**
   * Move a batch of chunks to their assigned clusters in ONE transaction.
   *
   * `cluster_id` is a PARTITION KEY on the vec0 table, so changing it means delete + reinsert —
   * there is no UPDATE path. The cost that mattered was never that pair, though: the original
   * code prepared both statements INSIDE the per-row function and opened a transaction per row,
   * so assigning a corpus meant N statement preparations and N WAL commits.
   *
   * MEASURED on the real 143k-vector store: 49.13 ms/row one at a time versus 2.62 ms/row
   * batched — 18.7x, and the difference between a ~2 hour index build and a ~6 minute one. The
   * build being unaffordable is why IVF had never run on a large install at all, which in turn
   * is why every vector query brute-forced the whole store (615 ms each) and why theme discovery
   * was confined to the surfaced ninth of the corpus.
   *
   * Statements are prepared once and reused (see the class fields) rather than per call.
   */
  reassignClusterBatch(items: Array<{ chunkId: string; embedding: Float32Array; clusterId: number }>): void {
    if (items.length === 0) return;
    const del = this.reassignDelStmt ??= this.db.query(`DELETE FROM vec_chunks_p WHERE chunk_id = ?`);
    const ins = this.reassignInsStmt ??= this.db.query(
      `INSERT INTO vec_chunks_p (chunk_id, cluster_id, embedding) VALUES (?, ?, ?)`);
    const tx = this.db.transaction(() => {
      for (const it of items) {
        const blob = new Uint8Array(it.embedding.buffer, it.embedding.byteOffset, it.embedding.byteLength);
        del.run(it.chunkId);
        ins.run(it.chunkId, it.clusterId, blob);
      }
    });
    tx();
  }

  /** Single-row form, kept for callers that genuinely move one chunk. Delegates so there is one
   *  implementation of the delete+reinsert rule. */
  reassignCluster(chunkId: string, embedding: Float32Array, clusterId: number): void {
    this.reassignClusterBatch([{ chunkId, embedding, clusterId }]);
  }

  /**
   * Cheap index summary for /stats. Every query here was MEASURED before being wired in, because
   * /stats is polled every 2 s by `top`:
   *
   *   COUNT centroids                       11.6 ms   ok
   *   COUNT from vec_chunk_meta             13.7 ms   ok
   *   SUM(hit_count) from centroids          6.9 ms   ok  <- progress proxy
   *   COUNT vec_chunks_p WHERE cluster_id  1329.0 ms   REJECTED — would be a self-inflicted outage
   *
   * `assigned` is the summed hit_count rather than a direct count of clustered rows: it answers
   * the same question for a progress display and costs 6.9 ms instead of 1.3 s. It counts
   * assignments made, so once the build completes and rebalancing begins it can drift past the
   * vector count — hence the caller clamps to 100%.
   */
  indexSummary(collection: string): { centroids: number; vectors: number; assigned: number } {
    const c = this.db
      .query(`SELECT COUNT(*) n, COALESCE(SUM(hit_count),0) h FROM vec_cluster_centroids WHERE collection_name = ?`)
      .get(collection) as { n: number; h: number };
    const v = this.db
      .query(`SELECT COUNT(*) n FROM vec_chunk_meta WHERE collection_name = ?`)
      .get(collection) as { n: number };
    return { centroids: c.n, vectors: v.n, assigned: Math.min(c.h, v.n) };
  }

  /** Count of rows still in the pre-A2 `vec_chunks` table (0 once fully
   *  migrated, or on a fresh install where that table was never populated). */
  countLegacyRows(): number {
    const row = this.db.query(`SELECT count(*) as n FROM vec_chunks`).get() as { n: number };
    return row.n;
  }

  /** Copy up to `limit` rows out of the legacy `vec_chunks` table into
   *  `vec_chunks_p` (with the unclustered sentinel), deleting them from the
   *  legacy table as they're copied. `vec_chunks` is never renamed or dropped
   *  — see Global Constraints. Returns how many rows were migrated. */
  migrateLegacyBatch(limit: number): number {
    const rows = this.db
      .query(`SELECT chunk_id, embedding FROM vec_chunks LIMIT ?`)
      .all(limit) as Array<{ chunk_id: string; embedding: Uint8Array }>;
    if (rows.length === 0) return 0;

    const insertNew = this.db.query(
      `INSERT INTO vec_chunks_p (chunk_id, cluster_id, embedding) VALUES (?, ?, ?)`
    );
    const deleteOld = this.db.query(`DELETE FROM vec_chunks WHERE chunk_id = ?`);
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        insertNew.run(row.chunk_id, UNCLUSTERED, row.embedding);
        deleteOld.run(row.chunk_id);
      }
    });
    tx();
    return rows.length;
  }

  close(): void {
    this.db.close();
  }
}
