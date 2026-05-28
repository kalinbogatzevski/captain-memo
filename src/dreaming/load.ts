// src/dreaming/load.ts
//
// Read-only data loader for the dry-run pipeline. Pulls observations from
// observations.db, parses the recall-audit.jsonl co-occurrence trail, and
// joins them via the chunks.metadata.observation_id index in meta.sqlite3.
// No writes anywhere. No worker contact — operates directly on the on-disk
// stores so it can run while the worker is up.

import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

export interface DreamObservation {
  id: number;
  type: string;
  title: string;
  created_at_epoch: number;
  project_id: string;
  /** Total surfaces across all sources (from v0.1.12 provenance counters). */
  surfaces: number;
}

export interface DreamInputs {
  observations: DreamObservation[];
  /** Map "min:max" → co-occurrence count, where min/max are observation_ids.
   *  Keyed by sorted pair so lookups are direction-independent. */
  coOccurrence: Map<string, number>;
  /** Pair key helper — exported so callers don't reinvent the canonical form. */
  pairKey: (a: number, b: number) => string;
}

/** Canonical, direction-independent pair key. */
export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Resolve the data dir at call time so CAPTAIN_MEMO_DATA_DIR overrides
 *  set in tests are honored — same pattern as recall-audit.ts. */
function dataDir(): string {
  return process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo');
}

/**
 * Build the input package for the dry-run. Pure I/O — no clustering, no
 * decisions. Steps:
 *
 *   1. Open observations.db, list non-archived rows in [sinceEpoch, ∞).
 *   2. Open meta.sqlite3, build doc_id → observation_id map.
 *   3. Stream recall-audit.jsonl, for each entry compute pairs of co-surfaced
 *      observation_ids and increment the co-occurrence counter.
 *
 * If the audit log doesn't exist (CAPTAIN_MEMO_RECALL_AUDIT was never on),
 * we return observations + an empty co-occurrence map. Clustering then falls
 * back to temporal-only — degraded but useful.
 */
export async function loadDreamInputs(
  sinceEpoch: number,
  projectId?: string,
): Promise<DreamInputs> {
  const dir = dataDir();
  const obsPath = join(dir, 'observations.db');
  const metaPath = join(dir, 'meta.sqlite3');
  const auditPath = join(dir, 'recall-audit.jsonl');

  if (!existsSync(obsPath)) {
    throw new Error(`observations.db not found at ${obsPath}`);
  }

  const observations = readObservations(obsPath, sinceEpoch, projectId);
  const docToObs = existsSync(metaPath) ? readDocToObsMap(metaPath) : new Map<string, number>();
  const coOccurrence = existsSync(auditPath)
    ? await buildCoOccurrence(auditPath, docToObs, sinceEpoch, projectId)
    : new Map<string, number>();

  return { observations, coOccurrence, pairKey };
}

function readObservations(
  path: string,
  sinceEpoch: number,
  projectId: string | undefined,
): DreamObservation[] {
  const db = new Database(path, { readonly: true });
  try {
    const sql = projectId
      ? `SELECT id, type, title, created_at_epoch, project_id,
                (from_auto + from_search + from_drill) AS surfaces
           FROM observations
          WHERE archived = 0
            AND created_at_epoch >= ?
            AND project_id = ?
          ORDER BY created_at_epoch ASC, id ASC`
      : `SELECT id, type, title, created_at_epoch, project_id,
                (from_auto + from_search + from_drill) AS surfaces
           FROM observations
          WHERE archived = 0
            AND created_at_epoch >= ?
          ORDER BY created_at_epoch ASC, id ASC`;
    const rows = (projectId
      ? db.query(sql).all(sinceEpoch, projectId)
      : db.query(sql).all(sinceEpoch)) as Array<DreamObservation>;
    return rows;
  } finally {
    db.close();
  }
}

function readDocToObsMap(path: string): Map<string, number> {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .query(
        `SELECT chunk_id,
                CAST(json_extract(metadata, '$.observation_id') AS INTEGER) AS observation_id
           FROM chunks
          WHERE json_extract(metadata, '$.observation_id') IS NOT NULL`,
      )
      .all() as Array<{ chunk_id: string; observation_id: number }>;
    const map = new Map<string, number>();
    for (const r of rows) {
      if (Number.isInteger(r.observation_id) && r.observation_id > 0) {
        map.set(r.chunk_id, r.observation_id);
      }
    }
    return map;
  } finally {
    db.close();
  }
}

interface AuditLine {
  ts: number;          // epoch ms
  project_id?: string;
  hits?: Array<{ doc_id?: string; channel?: string }>;
}

async function buildCoOccurrence(
  path: string,
  docToObs: Map<string, number>,
  sinceEpoch: number,
  projectId: string | undefined,
): Promise<Map<string, number>> {
  const text = await readFile(path, 'utf8');
  const sinceMs = sinceEpoch * 1000;
  const result = new Map<string, number>();

  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) continue;
    let entry: AuditLine;
    try {
      entry = JSON.parse(rawLine) as AuditLine;
    } catch {
      continue;  // corrupt line — skip silently, audit log is best-effort.
    }
    if (entry.ts < sinceMs) continue;
    if (projectId && entry.project_id !== projectId) continue;

    // Extract observation_ids from this audit entry's hits.
    const obsIds: number[] = [];
    for (const h of entry.hits ?? []) {
      if (!h.doc_id) continue;
      const oid = docToObs.get(h.doc_id);
      if (oid !== undefined) obsIds.push(oid);
    }
    if (obsIds.length < 2) continue;

    // Increment every unordered pair. O(k²) per entry where k = hit count;
    // k is bounded by /inject/context's top_k (typically 5), so this is cheap.
    const unique = Array.from(new Set(obsIds));
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = pairKey(unique[i]!, unique[j]!);
        result.set(key, (result.get(key) ?? 0) + 1);
      }
    }
  }

  return result;
}
