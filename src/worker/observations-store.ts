import { Database } from 'bun:sqlite';
import type { Observation, ObservationType, RetrievalSource } from '../shared/types.ts';
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
  {
    version: 4,
    name: 'add_retrieval_tracking',
    up: (db) => {
      db.exec('ALTER TABLE observations ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE observations ADD COLUMN last_retrieved_at INTEGER');
    },
  },
  {
    // v5 — retrieval provenance: split the single retrieval_count into three
    // per-source counters (auto = /inject/context; search = /search/*; drill =
    // /get_full) plus a last_surfaced_at stamp. Pre-v5 bumps came exclusively
    // from /search/* and /get_full, so we backfill them into from_search (the
    // dominant pre-v5 path) to preserve the historical signal without losing
    // it. Going forward, retrieval_count and last_retrieved_at are vestigial
    // — readers consult the new columns; the worker no longer writes them.
    version: 5,
    name: 'add_retrieval_provenance',
    up: (db) => {
      db.exec('ALTER TABLE observations ADD COLUMN from_auto INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE observations ADD COLUMN from_search INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE observations ADD COLUMN from_drill INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE observations ADD COLUMN last_surfaced_at INTEGER');
      db.exec(`
        UPDATE observations
           SET from_search = retrieval_count,
               last_surfaced_at = last_retrieved_at
         WHERE retrieval_count > 0
      `);
    },
  },
  {
    // v6 — Local Dreaming scaffold: archived flag + theme back-references.
    // No semantic change for live behavior; columns are inert until the
    // `captain-memo dream` command writes them. `archived` is a soft-delete:
    // archived rows stay in place (queryable with ?include_archived=1) so the
    // operation is reversible by a single UPDATE.
    //
    // Partial index keeps the default search path (archived = FALSE) cheap
    // by indexing only the small archived subset.
    //
    // Spec: docs/specs/2026-05-27-local-dreaming-design.md (revised 2026-05-28).
    version: 6,
    name: 'add_dreaming_scaffold',
    up: (db) => {
      db.exec('ALTER TABLE observations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE observations ADD COLUMN archived_into_theme_id INTEGER');
      db.exec('ALTER TABLE observations ADD COLUMN theme_member_ids TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_obs_archived ON observations(archived) WHERE archived = 1');
    },
  },
];

export type NewObservation = Omit<
  Observation,
  'id' | 'stored_tokens'
  | 'retrieval_count' | 'last_retrieved_at'
  | 'from_auto' | 'from_search' | 'from_drill' | 'last_surfaced_at'
  | 'archived' | 'archived_into_theme_id' | 'theme_member_ids'
>;

/** Per-source breakdown for one observation in the top lists. */
export interface RecallTopEntry {
  id: number;
  type: ObservationType;
  title: string;
  from_auto: number;
  from_search: number;
  from_drill: number;
  last_surfaced_at: number | null;
}

/** Shape returned by getRecallStats — drives the RECALL section of /stats. */
export interface RecallStats {
  /** Distinct observations with at least one bump from any source. */
  surfaced_count: number;
  /** Distinct observations with at least one /get_full bump (drilled-in). */
  recalled_count: number;
  /** Grand totals across the corpus, per source — useful for sanity checks. */
  totals: { auto: number; search: number; drill: number };
  /** Top by (from_auto + from_search + from_drill), ties broken by last_surfaced_at. */
  top_surfaced: RecallTopEntry[];
  /** Top by from_drill, ties broken by last_surfaced_at — the strongest signal. */
  top_recalled: RecallTopEntry[];
}

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
      retrieval_count: typeof row.retrieval_count === 'number' ? row.retrieval_count : 0,
      last_retrieved_at: typeof row.last_retrieved_at === 'number' ? row.last_retrieved_at : null,
      from_auto: typeof row.from_auto === 'number' ? row.from_auto : 0,
      from_search: typeof row.from_search === 'number' ? row.from_search : 0,
      from_drill: typeof row.from_drill === 'number' ? row.from_drill : 0,
      last_surfaced_at: typeof row.last_surfaced_at === 'number' ? row.last_surfaced_at : null,
      archived: row.archived === 1 || row.archived === true,
      archived_into_theme_id:
        typeof row.archived_into_theme_id === 'number' ? row.archived_into_theme_id : null,
      theme_member_ids: typeof row.theme_member_ids === 'string'
        ? (JSON.parse(row.theme_member_ids) as number[])
        : null,
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

  /**
   * Aggregate retrieval stats for the stats CLI's RECALL section.
   *
   * Returns:
   *  - surfaced_count: distinct observations bumped by ANY source
   *  - recalled_count: distinct observations bumped by /get_full
   *  - totals: grand totals per source (auto/search/drill)
   *  - top_surfaced: top-N by total bumps across all sources
   *  - top_recalled: top-N by drill bumps (strongest "actually used" signal)
   *
   * Three indexed queries, no joins. Safe to call on every /stats hit.
   */
  getRecallStats(topN: number): RecallStats {
    const counts = this.db
      .query(
        `SELECT
           SUM(CASE WHEN (from_auto + from_search + from_drill) > 0 THEN 1 ELSE 0 END) AS surfaced,
           SUM(CASE WHEN from_drill > 0 THEN 1 ELSE 0 END)                              AS recalled,
           COALESCE(SUM(from_auto),   0) AS total_auto,
           COALESCE(SUM(from_search), 0) AS total_search,
           COALESCE(SUM(from_drill),  0) AS total_drill
         FROM observations`,
      )
      .get() as {
        surfaced: number | null;
        recalled: number | null;
        total_auto: number;
        total_search: number;
        total_drill: number;
      };

    const mapRow = (r: {
      id: number; type: string; title: string;
      from_auto: number; from_search: number; from_drill: number;
      last_surfaced_at: number | null;
    }): RecallTopEntry => ({
      id: r.id,
      type: r.type as ObservationType,
      title: r.title,
      from_auto: r.from_auto,
      from_search: r.from_search,
      from_drill: r.from_drill,
      last_surfaced_at: r.last_surfaced_at,
    });

    const topSurfaced = this.db
      .query(
        `SELECT id, type, title, from_auto, from_search, from_drill, last_surfaced_at
           FROM observations
          WHERE (from_auto + from_search + from_drill) > 0
          ORDER BY (from_auto + from_search + from_drill) DESC,
                   last_surfaced_at DESC
          LIMIT ?`,
      )
      .all(topN) as Array<Parameters<typeof mapRow>[0]>;

    const topRecalled = this.db
      .query(
        `SELECT id, type, title, from_auto, from_search, from_drill, last_surfaced_at
           FROM observations
          WHERE from_drill > 0
          ORDER BY from_drill DESC, last_surfaced_at DESC
          LIMIT ?`,
      )
      .all(topN) as Array<Parameters<typeof mapRow>[0]>;

    return {
      surfaced_count: counts.surfaced ?? 0,
      recalled_count: counts.recalled ?? 0,
      totals: {
        auto:   counts.total_auto,
        search: counts.total_search,
        drill:  counts.total_drill,
      },
      top_surfaced: topSurfaced.map(mapRow),
      top_recalled: topRecalled.map(mapRow),
    };
  }

  /**
   * Bump a per-source counter and stamp last_surfaced_at on every supplied id.
   * Empty array is a no-op. Callers should wrap in try/catch — a failure here
   * MUST never fail the originating search request.
   *
   * Source maps to a column:
   *   'auto'   → from_auto    (/inject/context hook)
   *   'search' → from_search  (/search/all|memory|skill|observations)
   *   'drill'  → from_drill   (/get_full)
   *
   * The column name is selected from a closed set (not from the request),
   * so concatenation is safe; the ids themselves use bound parameters.
   */
  bumpRetrieval(ids: number[], source: RetrievalSource): void {
    if (ids.length === 0) return;
    const column: Record<RetrievalSource, 'from_auto' | 'from_search' | 'from_drill'> = {
      auto:   'from_auto',
      search: 'from_search',
      drill:  'from_drill',
    };
    const col = column[source];
    const now = Math.floor(Date.now() / 1000);
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .query(
        `UPDATE observations
            SET ${col} = ${col} + 1,
                last_surfaced_at = ?
          WHERE id IN (${placeholders})`,
      )
      .run(now, ...ids);
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
