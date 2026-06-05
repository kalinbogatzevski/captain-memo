import { Database } from 'bun:sqlite';
import type { Observation, ObservationType, RetrievalSource } from '../shared/types.ts';
import { applyMigrations } from './migrations.ts';
import type { Migration } from './migrations.ts';
import type { TideConfig, TideRow, TideState } from './tide.ts';
import { groupBySimilarity, DEFAULT_SIMILARITY_THRESHOLD } from '../shared/title-similarity.ts';

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
  {
    // v7 — record WHICH source drove the most recent surfacing, so the live
    // "last surfaced … via auto/search/drill" pulse can name the path. NULL for
    // history (pre-v7 last_surfaced_at bumps didn't capture the source).
    version: 7,
    name: 'add_last_surfaced_source',
    up: (db) => {
      db.exec('ALTER TABLE observations ADD COLUMN last_surfaced_source TEXT');
    },
  },
  {
    // v8 — Tide memory-lifecycle scaffold (A7). Adds the per-row stability and
    // lifecycle-state columns the Tide model needs. INERT until
    // CAPTAIN_MEMO_TIDE_ENABLED=1: every column has a benign default
    // (tide_state='active', is_anchored=0, stability_days=NULL ⇒ seed from the
    // channel S0 at read time), so a migrated DB behaves exactly as before until
    // Tide is switched on. Partial index mirrors the v6 archived trick — only the
    // non-active minority is indexed, so the default 'active' path stays index-free.
    //
    // Spec: docs/tide-quartermaster.md (Track A7).
    version: 8,
    name: 'add_tide_lifecycle',
    up: (db) => {
      db.exec('ALTER TABLE observations ADD COLUMN stability_days REAL');
      db.exec("ALTER TABLE observations ADD COLUMN tide_state TEXT NOT NULL DEFAULT 'active'");
      db.exec('ALTER TABLE observations ADD COLUMN tide_state_changed_at INTEGER');
      db.exec('ALTER TABLE observations ADD COLUMN is_anchored INTEGER NOT NULL DEFAULT 0');
      db.exec("CREATE INDEX IF NOT EXISTS idx_obs_tide_state ON observations(tide_state) WHERE tide_state != 'active'");
    },
  },
  {
    // v9 — append-only merge ledger. One row per folded member, written in the
    // SAME tx as mergeDuplicateGroup, capturing that member's contributed counts
    // so a second merge into a hot survivor can never clobber the first's record.
    // unmerge reads WHERE survivor_id=? AND undone=0. theme_member_ids kept for
    // display only. Spec: docs/tide-quartermaster.md (Risks — nested-merge clobber).
    version: 9,
    name: 'add_merge_events',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS merge_events (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          survivor_id   INTEGER NOT NULL,
          member_id     INTEGER NOT NULL,
          summed_auto   INTEGER NOT NULL DEFAULT 0,
          summed_search INTEGER NOT NULL DEFAULT 0,
          summed_drill  INTEGER NOT NULL DEFAULT 0,
          merged_at     INTEGER NOT NULL,
          job           TEXT NOT NULL DEFAULT 'dedup',
          undone        INTEGER NOT NULL DEFAULT 0
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_merge_events_survivor ON merge_events(survivor_id) WHERE undone = 0');
    },
  },
];

export type NewObservation = Omit<
  Observation,
  'id' | 'stored_tokens'
  | 'retrieval_count' | 'last_retrieved_at'
  | 'from_auto' | 'from_search' | 'from_drill'
  | 'last_surfaced_at' | 'last_surfaced_source'
  | 'archived' | 'archived_into_theme_id' | 'theme_member_ids'
  | 'stability_days' | 'tide_state' | 'tide_state_changed_at' | 'is_anchored'
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
  /** How many near-duplicate observations were collapsed into this entry.
   *  1 = no collapse; >1 means the counts above are summed across `variants`
   *  near-identical rows. Display shows "(+N similar)". */
  variants: number;
}

/** One row of the live "recently surfaced" pulse — ordered by recency, not
 *  count. `source` names the path that drove the most recent surfacing. */
export interface RecentSurfacedEntry {
  id: number;
  type: ObservationType;
  title: string;
  last_surfaced_at: number;
  source: RetrievalSource | null;
}

/** Shape returned by getRecallStats — drives the RECALL section of /stats. */
export interface RecallStats {
  /** Distinct observations with at least one bump from any source. */
  surfaced_count: number;
  /** Distinct observations with at least one /get_full bump (drilled-in). */
  recalled_count: number;
  /** Grand totals across the corpus, per source — useful for sanity checks. */
  totals: { auto: number; search: number; drill: number };
  /** Top by (from_auto + from_search + from_drill), ties broken by last_surfaced_at.
   *  Near-duplicate titles are collapsed (see RecallTopEntry.variants). */
  top_surfaced: RecallTopEntry[];
  /** Top by from_drill, ties broken by last_surfaced_at — the strongest signal. */
  top_recalled: RecallTopEntry[];
  /** Most-recently-surfaced observations (recency order), for the live pulse. */
  recent_surfaced: RecentSurfacedEntry[];
}

/** Shape returned by getTideStats — drives the TIDE section of /stats. Meaningful
 *  even when Tide is disabled (then `strengthened` stays 0 and everything is active). */
export interface TideStats {
  /** Observations whose `stability_days` has been written — i.e. recalled at least
   *  once with Tide on (the writer's bumpRetrieval strengthening fired). */
  strengthened: number;
  /** Lifecycle-tier breakdown. The MVP never leaves `active`; dormant/archived
   *  populate once Phase 2 (Tide tiering) lands. */
  by_state: { active: number; dormant: number; archived: number };
  /** Observations pinned with `is_anchored = 1` — they never ebb. */
  anchored: number;
  /** Largest `stability_days` in the corpus (days), or null if none strengthened. */
  max_stability_days: number | null;
}

/** Which population the `top` table is showing. */
export type RecallView = 'surfaced' | 'recalled' | 'recent';
/** Column the `top` table is sorted by. */
export type RecallSort = 'total' | 'auto' | 'search' | 'drill' | 'recency';

export interface RecallQuery {
  view: RecallView;
  sort: RecallSort;
  type?: string;          // exact observation type filter
  q?: string;             // case-insensitive title substring
  limit: number;
  offset: number;
  collapse: boolean;      // fold near-duplicate titles (sum counts)
}

export interface RecallRow {
  id: number;
  type: ObservationType;
  title: string;
  from_auto: number;
  from_search: number;
  from_drill: number;
  total: number;
  last_surfaced_at: number | null;
  last_surfaced_source: RetrievalSource | null;
  variants: number;       // 1 unless collapsed
}

export interface RecallPage {
  rows: RecallRow[];
  total: number;          // full match count (pre-paging)
}

/** One entry in a duplicate group (survivor or member). */
export interface DuplicateEntry {
  id: number;
  type: ObservationType;
  title: string;
  total: number;
}

/** A set of near-identical observations the dedup command can fold together.
 *  `survivor` is the highest-count phrasing; `members` would be archived into it. */
export interface DuplicateGroup {
  survivor: DuplicateEntry;
  members: DuplicateEntry[];
}

/** Narrow an unknown DB cell to a RetrievalSource. */
function isRetrievalSource(v: unknown): v is RetrievalSource {
  return v === 'auto' || v === 'search' || v === 'drill';
}

/** Upper bound on rows pulled into the in-memory near-dup collapse. */
const CANDIDATE_CAP = 200;

interface RawTopRow {
  id: number; type: string; title: string;
  from_auto: number; from_search: number; from_drill: number;
  last_surfaced_at: number | null;
}

const totalMetric = (e: RecallTopEntry): number => e.from_auto + e.from_search + e.from_drill;
const drillMetric = (e: RecallTopEntry): number => e.from_drill;

interface RawRecallRow extends RawTopRow {
  last_surfaced_source: unknown;
}

/** Map a raw DB row to a RecallRow (no collapse → variants 1). */
function rawToRecallRow(r: RawRecallRow): RecallRow {
  return {
    id: r.id,
    type: r.type as ObservationType,
    title: r.title,
    from_auto: r.from_auto,
    from_search: r.from_search,
    from_drill: r.from_drill,
    total: r.from_auto + r.from_search + r.from_drill,
    last_surfaced_at: r.last_surfaced_at,
    last_surfaced_source: isRetrievalSource(r.last_surfaced_source) ? r.last_surfaced_source : null,
    variants: 1,
  };
}

/** Fold a similarity group (representative leads) into one RecallRow with
 *  summed counts. last_surfaced_* come from the most-recently-surfaced member,
 *  so the row's recency reflects the group's freshest activity. */
function collapseToRecallRow(group: RawRecallRow[]): RecallRow {
  const rep = group[0]!;
  let auto = 0, search = 0, drill = 0;
  let freshest = rep;
  for (const r of group) {
    auto += r.from_auto; search += r.from_search; drill += r.from_drill;
    // Explicit null handling (matches collapseTop): a null timestamp is never
    // "fresher" than a real one, and never coerced to a sentinel like 0 or -1.
    if (r.last_surfaced_at !== null
      && (freshest.last_surfaced_at === null || r.last_surfaced_at > freshest.last_surfaced_at)) {
      freshest = r;
    }
  }
  return {
    id: rep.id,
    type: rep.type as ObservationType,
    title: rep.title,
    from_auto: auto,
    from_search: search,
    from_drill: drill,
    total: auto + search + drill,
    last_surfaced_at: freshest.last_surfaced_at,
    last_surfaced_source: isRetrievalSource(freshest.last_surfaced_source) ? freshest.last_surfaced_source : null,
    variants: group.length,
  };
}

/** Collapse near-identical titles among already-metric-sorted candidate rows,
 *  sum each group's counts into its representative (the highest-count phrasing,
 *  which leads the group), then re-rank by the metric and take the top N. */
function collapseTop(
  rows: RawTopRow[],
  metric: (e: RecallTopEntry) => number,
  topN: number,
): RecallTopEntry[] {
  const groups = groupBySimilarity(rows, r => r.title, DEFAULT_SIMILARITY_THRESHOLD);
  const collapsed: RecallTopEntry[] = groups.map(group => {
    const rep = group[0]!;
    let auto = 0, search = 0, drill = 0, maxTs: number | null = null;
    for (const r of group) {
      auto += r.from_auto; search += r.from_search; drill += r.from_drill;
      if (r.last_surfaced_at !== null && (maxTs === null || r.last_surfaced_at > maxTs)) {
        maxTs = r.last_surfaced_at;
      }
    }
    return {
      id: rep.id,
      type: rep.type as ObservationType,
      title: rep.title,
      from_auto: auto,
      from_search: search,
      from_drill: drill,
      last_surfaced_at: maxTs,
      variants: group.length,
    };
  });
  collapsed.sort((a, b) =>
    metric(b) - metric(a)
    || (b.last_surfaced_at ?? 0) - (a.last_surfaced_at ?? 0)
    || b.id - a.id);   // id tiebreaker → deterministic order on full ties
  return collapsed.slice(0, topN);
}

export class ObservationsStore {
  private db: Database;
  private tideConfig: TideConfig | null;

  constructor(path: string, opts?: { readonly?: boolean; tideConfig?: TideConfig }) {
    this.db = new Database(path, opts?.readonly ? { readonly: true } : undefined);
    this.tideConfig = opts?.tideConfig ?? null;
    if (!opts?.readonly) {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec(SCHEMA);
      applyMigrations(this.db, OBSERVATIONS_STORE_MIGRATIONS);
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
      stored_tokens: typeof row.stored_tokens === 'number' ? row.stored_tokens : null,
      retrieval_count: typeof row.retrieval_count === 'number' ? row.retrieval_count : 0,
      last_retrieved_at: typeof row.last_retrieved_at === 'number' ? row.last_retrieved_at : null,
      from_auto: typeof row.from_auto === 'number' ? row.from_auto : 0,
      from_search: typeof row.from_search === 'number' ? row.from_search : 0,
      from_drill: typeof row.from_drill === 'number' ? row.from_drill : 0,
      last_surfaced_at: typeof row.last_surfaced_at === 'number' ? row.last_surfaced_at : null,
      last_surfaced_source: isRetrievalSource(row.last_surfaced_source)
        ? row.last_surfaced_source : null,
      archived: row.archived === 1 || row.archived === true,
      archived_into_theme_id:
        typeof row.archived_into_theme_id === 'number' ? row.archived_into_theme_id : null,
      theme_member_ids: typeof row.theme_member_ids === 'string'
        ? (JSON.parse(row.theme_member_ids) as number[])
        : null,
      stability_days: typeof row.stability_days === 'number' ? row.stability_days : null,
      tide_state: row.tide_state === 'dormant' || row.tide_state === 'archived'
        ? row.tide_state : 'active',
      tide_state_changed_at:
        typeof row.tide_state_changed_at === 'number' ? row.tide_state_changed_at : null,
      is_anchored: row.is_anchored === 1 || row.is_anchored === true,
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

  /**
   * Aggregate Tide lifecycle counters for /stats. Cheap by construction: the
   * dormant/archived tallies ride the partial index `idx_obs_tide_state`
   * (WHERE tide_state != 'active'), and `active` is derived by subtraction so the
   * common-case majority is never scanned. `anchored` and the max are simple
   * full-table aggregates (fast on the observation channel; /stats is not hot).
   */
  getTideStats(): TideStats {
    const n = (sql: string): number =>
      (this.db.query(sql).get() as { n: number }).n;
    const total = this.countAll();
    const dormant = n("SELECT COUNT(*) AS n FROM observations WHERE tide_state = 'dormant'");
    const archived = n("SELECT COUNT(*) AS n FROM observations WHERE tide_state = 'archived'");
    const strengthened = n('SELECT COUNT(*) AS n FROM observations WHERE stability_days IS NOT NULL');
    const anchored = n('SELECT COUNT(*) AS n FROM observations WHERE is_anchored = 1');
    const maxRow = this.db
      .query('SELECT MAX(stability_days) AS m FROM observations')
      .get() as { m: number | null };
    return {
      strengthened,
      by_state: { active: total - dormant - archived, dormant, archived },
      anchored,
      max_stability_days: typeof maxRow.m === 'number' ? maxRow.m : null,
    };
  }

  setStoredTokens(id: number, tokens: number): void {
    this.db
      .query('UPDATE observations SET stored_tokens = ? WHERE id = ?')
      .run(tokens, id);
  }

  /**
   * Aggregate retrieval stats for the stats CLI's RECALL section. Archived
   * observations (folded into a survivor by dedup) are excluded everywhere.
   *
   * Returns:
   *  - surfaced_count: distinct (non-archived) observations bumped by ANY source
   *  - recalled_count: distinct (non-archived) observations bumped by /get_full
   *  - totals: grand totals per source (auto/search/drill)
   *  - top_surfaced: top-N by total bumps, with near-duplicate titles COLLAPSED
   *    (counts summed, RecallTopEntry.variants set)
   *  - top_recalled: top-N by drill bumps, same collapse
   *  - recent_surfaced: most-recently-surfaced rows for the live pulse
   *
   * Safe to call on every /stats hit: a few indexed queries plus an in-memory
   * collapse bounded by CANDIDATE_CAP.
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
         FROM observations
         WHERE archived = 0`,
      )
      .get() as {
        surfaced: number | null;
        recalled: number | null;
        total_auto: number;
        total_search: number;
        total_drill: number;
      };

    // Over-fetch candidates, then collapse near-identical titles in memory.
    // The cap bounds the collapse cost; low-count dupes beyond it can't reach
    // the top list anyway.
    const surfacedCandidates = this.db
      .query(
        `SELECT id, type, title, from_auto, from_search, from_drill, last_surfaced_at
           FROM observations
          WHERE archived = 0 AND (from_auto + from_search + from_drill) > 0
          ORDER BY (from_auto + from_search + from_drill) DESC, last_surfaced_at DESC
          LIMIT ?`,
      )
      .all(CANDIDATE_CAP) as RawTopRow[];

    const recalledCandidates = this.db
      .query(
        `SELECT id, type, title, from_auto, from_search, from_drill, last_surfaced_at
           FROM observations
          WHERE archived = 0 AND from_drill > 0
          ORDER BY from_drill DESC, last_surfaced_at DESC
          LIMIT ?`,
      )
      .all(CANDIDATE_CAP) as RawTopRow[];

    return {
      surfaced_count: counts.surfaced ?? 0,
      recalled_count: counts.recalled ?? 0,
      totals: {
        auto:   counts.total_auto,
        search: counts.total_search,
        drill:  counts.total_drill,
      },
      top_surfaced: collapseTop(surfacedCandidates, totalMetric, topN),
      top_recalled: collapseTop(recalledCandidates, drillMetric, topN),
      recent_surfaced: this.getRecentlySurfaced(topN),
    };
  }

  /**
   * Most-recently-surfaced observations (recency order, newest first), for the
   * live pulse. Never-surfaced and archived rows are excluded.
   */
  getRecentlySurfaced(limit: number): RecentSurfacedEntry[] {
    const rows = this.db
      .query(
        `SELECT id, type, title, last_surfaced_at, last_surfaced_source
           FROM observations
          WHERE last_surfaced_at IS NOT NULL AND archived = 0
          ORDER BY last_surfaced_at DESC, id DESC
          LIMIT ?`,
      )
      .all(limit) as Array<{
        id: number; type: string; title: string;
        last_surfaced_at: number; last_surfaced_source: unknown;
      }>;
    return rows.map(r => ({
      id: r.id,
      type: r.type as ObservationType,
      title: r.title,
      last_surfaced_at: r.last_surfaced_at,
      source: isRetrievalSource(r.last_surfaced_source) ? r.last_surfaced_source : null,
    }));
  }

  /**
   * Server-side sort / filter / page / collapse for the `top` table. One
   * population (surfaced | recalled | recent), one sort column, optional type
   * and title-substring filters, optional near-dup collapse. Archived rows are
   * always excluded. `total` is the full match count for paging UIs.
   */
  queryRecall(qy: RecallQuery): RecallPage {
    const popPred: Record<RecallView, string> = {
      surfaced: '(from_auto + from_search + from_drill) > 0',
      recalled: 'from_drill > 0',
      recent:   'last_surfaced_at IS NOT NULL',
    };
    const orderExpr: Record<RecallSort, string> = {
      total:   '(from_auto + from_search + from_drill)',
      auto:    'from_auto',
      search:  'from_search',
      drill:   'from_drill',
      recency: 'COALESCE(last_surfaced_at, 0)',
    };

    const where: string[] = ['archived = 0', popPred[qy.view]];
    const params: Array<string | number> = [];
    if (qy.type) { where.push('type = ?'); params.push(qy.type); }
    if (qy.q)    { where.push('LOWER(title) LIKE ?'); params.push(`%${qy.q.toLowerCase()}%`); }
    const whereSql = where.join(' AND ');
    const orderSql = `${orderExpr[qy.sort]} DESC, COALESCE(last_surfaced_at, 0) DESC, id DESC`;
    const cols = 'id, type, title, from_auto, from_search, from_drill, last_surfaced_at, last_surfaced_source';

    // True match count (pre-collapse) — the RecallPage `total` contract. Used
    // by both paths so paging UIs see the real number of matching rows.
    const total = (this.db
      .query(`SELECT COUNT(*) AS n FROM observations WHERE ${whereSql}`)
      .get(...params) as { n: number }).n;

    if (!qy.collapse) {
      const rows = this.db
        .query(`SELECT ${cols} FROM observations WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
        .all(...params, qy.limit, qy.offset) as RawRecallRow[];
      return { rows: rows.map(rawToRecallRow), total };
    }

    // Collapse path: pull a candidate set large enough to cover the requested
    // window (never fewer than CANDIDATE_CAP), fold near-dupes, re-rank by the
    // requested metric with an id tiebreaker, then page in memory. `total`
    // stays the pre-collapse match count; callers report group count via rows.
    const fetchLimit = Math.max(CANDIDATE_CAP, qy.offset + qy.limit);
    const candidates = this.db
      .query(`SELECT ${cols} FROM observations WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ?`)
      .all(...params, fetchLimit) as RawRecallRow[];
    const groups = groupBySimilarity(candidates, r => r.title, DEFAULT_SIMILARITY_THRESHOLD);
    const collapsed = groups.map(collapseToRecallRow);
    const metricOf = (r: RecallRow): number =>
      qy.sort === 'recency' ? (r.last_surfaced_at ?? 0)
      : qy.sort === 'total' ? r.total
      : qy.sort === 'auto'  ? r.from_auto
      : qy.sort === 'search' ? r.from_search
      : r.from_drill;
    collapsed.sort((a, b) => metricOf(b) - metricOf(a)
      || (b.last_surfaced_at ?? 0) - (a.last_surfaced_at ?? 0)
      || b.id - a.id);
    return {
      rows: collapsed.slice(qy.offset, qy.offset + qy.limit),
      total,
    };
  }

  /**
   * Of the given ids, return the subset that is archived. One indexed query;
   * used by the worker's search post-filter to drop archived hits in a batch
   * (avoids a per-hit findById round-trip). Empty input → empty set.
   */
  archivedAmong(ids: number[]): Set<number> {
    if (ids.length === 0) return new Set();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .query(`SELECT id FROM observations WHERE archived = 1 AND id IN (${placeholders})`)
      .all(...ids) as Array<{ id: number }>;
    return new Set(rows.map(r => r.id));
  }

  /**
   * Of the given ids, return a map id → the buoyancy inputs the Tide re-rank needs
   * (created_at_epoch, last_surfaced_at, stability_days, from_drill, is_anchored).
   * One indexed `WHERE id IN (…)` — the batched accessor the search hot path uses
   * so it never does a per-hit findById round-trip inside the recall budget.
   */
  tideRowsAmong(ids: number[]): Map<number, TideRow> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .query(
        `SELECT id, created_at_epoch, last_surfaced_at, stability_days, from_drill, is_anchored
           FROM observations WHERE id IN (${placeholders})`,
      )
      .all(...ids) as Array<{
        id: number;
        created_at_epoch: number;
        last_surfaced_at: number | null;
        stability_days: number | null;
        from_drill: number;
        is_anchored: number;
      }>;
    return new Map(rows.map(r => [r.id, {
      created_at_epoch: r.created_at_epoch,
      last_surfaced_at: r.last_surfaced_at,
      stability_days: r.stability_days,
      from_drill: r.from_drill,
      is_anchored: r.is_anchored === 1,
    }]));
  }

  /**
   * Of the given ids, return the subset that is *sunk* (tide_state ∈ {dormant,
   * archived}) — the set excluded from the auto-inject default candidate set.
   * Rides the partial index `idx_obs_tide_state` (WHERE tide_state != 'active').
   * Distinct from `archivedAmong` (the v6 dedup `archived` flag, routed through
   * dropArchived); sunk rows stay in /search, down-ranked, one recall from surfacing.
   */
  sunkAmong(ids: number[]): Set<number> {
    if (ids.length === 0) return new Set();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .query(`SELECT id FROM observations WHERE tide_state != 'active' AND id IN (${placeholders})`)
      .all(...ids) as Array<{ id: number }>;
    return new Set(rows.map(r => r.id));
  }

  /** Set a row's lifecycle tier (writer-only). Stamps tide_state_changed_at for the audit trail. */
  setTideState(id: number, state: TideState, atEpoch: number): void {
    this.db
      .query('UPDATE observations SET tide_state = ?, tide_state_changed_at = ? WHERE id = ?')
      .run(state, atEpoch, id);
  }

  /**
   * Restore a sunk row to active (the per-row reversal the CLI exposes). Three-way so
   * the caller can tell a real restore from a harmless no-op from a typo'd id — the
   * last distinction matters because restore is the user's manual recovery lever and a
   * "not found" must never read as "already fine".
   */
  restoreObservation(id: number, atEpoch: number): 'restored' | 'already_active' | 'not_found' {
    const row = this.db.query('SELECT tide_state FROM observations WHERE id = ?').get(id) as
      { tide_state: string } | undefined;
    if (!row) return 'not_found';
    if (row.tide_state === 'active') return 'already_active';
    this.db
      .query("UPDATE observations SET tide_state = 'active', tide_state_changed_at = ? WHERE id = ?")
      .run(atEpoch, id);
    return 'restored';
  }

  /**
   * Bounded, oldest-first candidates for one sweep pass, filtered to a single source
   * tier. The sweep runs two passes — `'active'` rows for the ebb pass, `'dormant'`
   * rows for the archive pass — because a *combined* scan would wedge: once the oldest
   * rows ebb to dormant they'd permanently occupy the oldest-first LIMIT window
   * (dormant rows that can't archive yet are re-returned forever), starving newer
   * active rows of progress. Filtering by the exact source tier means an ebbed row
   * leaves the active scan, so it always advances. Cheap permanent gates (never
   * drilled, not anchored) and the minimum age are pre-filtered in SQL; the precise
   * buoyancy/age gates are applied in JS by tierDecision.
   */
  tierSweepCandidates(
    state: 'active' | 'dormant', limit: number, olderThanEpoch: number,
  ): Array<TideRow & { id: number; tide_state: TideState }> {
    const rows = this.db
      .query(
        `SELECT id, created_at_epoch, last_surfaced_at, stability_days, from_drill, is_anchored
           FROM observations
          WHERE tide_state = ? AND is_anchored = 0 AND from_drill = 0
            AND COALESCE(last_surfaced_at, created_at_epoch) < ?
          ORDER BY COALESCE(last_surfaced_at, created_at_epoch) ASC
          LIMIT ?`,
      )
      .all(state, olderThanEpoch, limit) as Array<{
        id: number;
        created_at_epoch: number;
        last_surfaced_at: number | null;
        stability_days: number | null;
        from_drill: number;
        is_anchored: number;
      }>;
    return rows.map(r => ({
      id: r.id,
      tide_state: state,
      created_at_epoch: r.created_at_epoch,
      last_surfaced_at: r.last_surfaced_at,
      stability_days: r.stability_days,
      from_drill: r.from_drill,
      is_anchored: r.is_anchored === 1,
    }));
  }

  /** List rows in a given lifecycle tier, most-recently-changed first — drives the
   *  `memory --show-archived/--ebbed` CLI. */
  listByTideState(
    state: TideState, limit: number,
  ): Array<{ id: number; type: string; title: string; tide_state: TideState; tide_state_changed_at: number | null; last_surfaced_at: number | null }> {
    return this.db
      .query(
        `SELECT id, type, title, tide_state, tide_state_changed_at, last_surfaced_at
           FROM observations WHERE tide_state = ?
          ORDER BY tide_state_changed_at DESC NULLS LAST, id DESC LIMIT ?`,
      )
      .all(state, limit) as Array<{
        id: number; type: string; title: string; tide_state: TideState;
        tide_state_changed_at: number | null; last_surfaced_at: number | null;
      }>;
  }

  /**
   * Fold `memberIds` into `survivorId`: add the members' per-source counts onto
   * the survivor, advance the survivor's last_surfaced_at to the group max,
   * archive each member (archived=1, archived_into_theme_id=survivorId), and
   * record one append-only `merge_events` row per folded member capturing that
   * member's contributed counts + `atEpoch` + `job`. theme_member_ids is still
   * written, but for display only — the ledger is the reversal source of truth.
   *
   * Reversible via unmergeDuplicateGroup. Reuses the v6 `archived_into_theme_id`
   * column to mean "folded into observation id" — the survivor need not be a
   * synthesized theme for a plain title-dedup.
   *
   * The ledger fixes a data-loss bug: a SECOND merge into the same survivor used
   * to overwrite the first merge's theme_member_ids, so --undo could only
   * recover the last batch. Per-member rows in an append-only table never clobber.
   *
   * Runs in a single transaction so a crash mid-merge can't leave counts summed
   * but members un-archived (or vice-versa).
   */
  mergeDuplicateGroup(survivorId: number, memberIds: number[], atEpoch: number, job = 'dedup'): void {
    const candidates = memberIds.filter(id => id !== survivorId);
    if (candidates.length === 0) return;

    const tx = this.db.transaction(() => {
      // Defense-in-depth: only fold members that share the survivor's
      // (project_id, branch). A caller passing a cross-scope member must never
      // corrupt the survivor's counters. NULL branch compared as ''.
      const survivor = this.db
        .query('SELECT project_id, branch FROM observations WHERE id = ?')
        .get(survivorId) as { project_id: string; branch: string | null } | undefined;
      if (!survivor) return;
      const scopePlaceholders = candidates.map(() => '?').join(',');
      const eligibleRows = this.db
        .query(
          `SELECT id, project_id, branch, from_auto, from_search, from_drill, last_surfaced_at
             FROM observations WHERE id IN (${scopePlaceholders})`,
        )
        .all(...candidates) as Array<{
          id: number; project_id: string; branch: string | null;
          from_auto: number; from_search: number; from_drill: number;
          last_surfaced_at: number | null;
        }>;
      const eligible = eligibleRows.filter(m => m.project_id === survivor.project_id
        && (m.branch ?? '') === (survivor.branch ?? ''));
      if (eligible.length === 0) return;
      const ids = eligible.map(m => m.id);
      const placeholders = ids.map(() => '?').join(',');

      // Aggregate from the per-member values we already hold (single scan).
      let a = 0, s = 0, d = 0, maxts: number | null = null;
      for (const m of eligible) {
        a += m.from_auto; s += m.from_search; d += m.from_drill;
        if (m.last_surfaced_at !== null) {
          maxts = maxts === null ? m.last_surfaced_at : Math.max(maxts, m.last_surfaced_at);
        }
      }

      // Append-only ledger: one row per folded member, with its exact counts.
      const insertEvent = this.db.query(
        `INSERT INTO merge_events
           (survivor_id, member_id, summed_auto, summed_search, summed_drill, merged_at, job, undone)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      );
      for (const m of eligible) {
        insertEvent.run(survivorId, m.id, m.from_auto, m.from_search, m.from_drill, atEpoch, job);
      }

      this.db
        .query(
          // last_surfaced_at advances to the group max, but stays NULL when
          // neither the survivor nor any member was ever surfaced (don't coerce
          // "never" to epoch 0).
          `UPDATE observations
              SET from_auto   = from_auto   + ?,
                  from_search = from_search + ?,
                  from_drill  = from_drill  + ?,
                  last_surfaced_at = CASE
                    WHEN last_surfaced_at IS NULL THEN ?
                    WHEN ? IS NULL THEN last_surfaced_at
                    ELSE MAX(last_surfaced_at, ?)
                  END,
                  theme_member_ids = ?
            WHERE id = ?`,
        )
        .run(a, s, d, maxts, maxts, maxts, JSON.stringify(ids), survivorId);

      this.db
        .query(
          `UPDATE observations
              SET archived = 1, archived_into_theme_id = ?
            WHERE id IN (${placeholders})`,
        )
        .run(survivorId, ...ids);
    });
    tx();
  }

  /**
   * Find groups of near-identical SURFACED observations (total > 0) that the
   * dedup command could fold together. Survivor = highest-count phrasing.
   * Only groups with at least one member (size > 1) are returned. Scans the
   * surfaced subset for speed and because those are the dupes that actually
   * bloat the stats/search surface.
   */
  findDuplicateGroups(threshold: number): DuplicateGroup[] {
    const rows = this.db
      .query(
        `SELECT id, type, title, from_auto, from_search, from_drill, project_id, branch
           FROM observations
          WHERE archived = 0 AND (from_auto + from_search + from_drill) > 0
          ORDER BY (from_auto + from_search + from_drill) DESC, id ASC`,
      )
      .all() as Array<RawTopRow & { project_id: string; branch: string | null }>;
    const toEntry = (r: RawTopRow): DuplicateEntry => ({
      id: r.id, type: r.type as ObservationType, title: r.title,
      total: r.from_auto + r.from_search + r.from_drill,
    });
    // Partition by (project_id, branch) so a dup group never spans two projects
    // or two branches — folding across scopes corrupts the survivor's counters.
    const partitions = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.project_id} ${r.branch ?? ''}`;
      const bucket = partitions.get(key);
      if (bucket) bucket.push(r);
      else partitions.set(key, [r]);
    }
    const out: DuplicateGroup[] = [];
    for (const bucket of partitions.values()) {
      for (const g of groupBySimilarity(bucket, r => r.title, threshold)) {
        if (g.length > 1) out.push({ survivor: toEntry(g[0]!), members: g.slice(1).map(toEntry) });
      }
    }
    return out;
  }

  /** Survivor ids with un-undone ledger rows — the set `dedup --undo` reverses. */
  mergedSurvivorIds(): number[] {
    const rows = this.db
      .query('SELECT DISTINCT survivor_id FROM merge_events WHERE undone = 0 ORDER BY survivor_id ASC')
      .all() as Array<{ survivor_id: number }>;
    return rows.map(r => r.survivor_id);
  }

  /**
   * Reverse every un-undone merge into `survivorId` using the append-only
   * `merge_events` ledger (the reversal source of truth): subtract each member's
   * recorded contributed counts back off the survivor, un-archive the members,
   * clear the survivor's display-only theme_member_ids, and mark those ledger
   * rows undone=1. No-op if there are no open ledger rows. Single transaction.
   *
   * Reading the ledger (not theme_member_ids) makes nested merges into one hot
   * survivor fully reversible — a second merge's row never overwrites the first.
   */
  unmergeDuplicateGroup(survivorId: number): void {
    const events = this.db
      .query(
        `SELECT member_id, summed_auto, summed_search, summed_drill
           FROM merge_events WHERE survivor_id = ? AND undone = 0`,
      )
      .all(survivorId) as Array<{
        member_id: number; summed_auto: number; summed_search: number; summed_drill: number;
      }>;
    if (events.length === 0) return;

    let a = 0, s = 0, d = 0;
    for (const e of events) { a += e.summed_auto; s += e.summed_search; d += e.summed_drill; }
    const memberIds = events.map(e => e.member_id);
    const placeholders = memberIds.map(() => '?').join(',');

    const tx = this.db.transaction(() => {
      this.db
        .query(
          `UPDATE observations
              SET from_auto = from_auto - ?, from_search = from_search - ?, from_drill = from_drill - ?,
                  theme_member_ids = NULL
            WHERE id = ?`,
        )
        .run(a, s, d, survivorId);
      this.db
        .query(`UPDATE observations SET archived = 0, archived_into_theme_id = NULL WHERE id IN (${placeholders})`)
        .run(...memberIds);
      this.db
        .query('UPDATE merge_events SET undone = 1 WHERE survivor_id = ? AND undone = 0')
        .run(survivorId);
    });
    tx();
  }

  /**
   * Bump a per-source counter and stamp last_surfaced_at + last_surfaced_source
   * on every supplied id. Empty array is a no-op. Callers should wrap in
   * try/catch — a failure here MUST never fail the originating search request.
   *
   * Source maps to a column:
   *   'auto'   → from_auto    (/inject/context hook)
   *   'search' → from_search  (/search/all|memory|skill|observations)
   *   'drill'  → from_drill   (/get_full)
   *
   * The column name is selected from a closed set (not from the request),
   * so concatenation is safe; the ids themselves use bound parameters.
   *
   * `atEpoch` is a testability seam — production callers omit it and get
   * Date.now(); tests pass explicit timestamps to make recency provable.
   */
  bumpRetrieval(
    ids: number[],
    source: RetrievalSource,
    atEpoch: number = Math.floor(Date.now() / 1000),
  ): void {
    if (ids.length === 0) return;
    const column: Record<RetrievalSource, 'from_auto' | 'from_search' | 'from_drill'> = {
      auto:   'from_auto',
      search: 'from_search',
      drill:  'from_drill',
    };
    const col = column[source];
    const placeholders = ids.map(() => '?').join(',');
    const tide = this.tideConfig;
    if (tide?.enabled) {
      // Fold the Tide stability strengthening into the SAME single UPDATE. The
      // expression mirrors tide.ts nextStability() exactly: S_new = S·(1 + gain·
      // g(source)·fS), with S = COALESCE(stability_days, S0) and rational
      // saturation fS = cap/(cap+S). Bump ids are always observations, so S0 =
      // s0.observation. Arithmetic-only — no SQL math extension required.
      const S0 = tide.s0.observation;
      const g = tide.src[source];
      // Surface-on-recall: a recall resets recency (last_surfaced_at = now ⇒ buoyancy
      // jumps to ~1), so any sunk row is re-floated to active in this same write. The
      // CASE stamps tide_state_changed_at only on a real transition, preserving the
      // dwell time of rows that were already active. This is the upper hysteresis rail
      // — the only way a row moves UP; the ebb sweep only ever moves rows down.
      this.db
        .query(
          `UPDATE observations
              SET ${col} = ${col} + 1,
                  last_surfaced_at = ?,
                  last_surfaced_source = ?,
                  stability_days = COALESCE(stability_days, ?)
                    * (1 + ? * ? * (? * 1.0 / (? + COALESCE(stability_days, ?)))),
                  tide_state = 'active',
                  tide_state_changed_at = CASE WHEN tide_state != 'active' THEN ? ELSE tide_state_changed_at END
            WHERE id IN (${placeholders})`,
        )
        .run(atEpoch, source, S0, tide.stabilityGain, g, tide.stabilityCapDays, tide.stabilityCapDays, S0, atEpoch, ...ids);
      return;
    }
    this.db
      .query(
        `UPDATE observations
            SET ${col} = ${col} + 1,
                last_surfaced_at = ?,
                last_surfaced_source = ?
          WHERE id IN (${placeholders})`,
      )
      .run(atEpoch, source, ...ids);
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
