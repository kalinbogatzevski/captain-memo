// src/worker/dream-stats.ts
//
// Cheap precursor stats for the DREAM section of `captain-memo stats`.
//
// Computes file-level and pair-level diagnostics for the recall audit log
// WITHOUT running clustering. Those diagnostics are the leading indicator
// of when `captain-memo dream --dry-run` will produce meaningful output:
//   - audit log size + entry count + last entry → "is the audit alive?"
//   - co-retrieval pair count + doc coverage   → "is the signal dense yet?"
//
// Result is cached against the audit log's mtime, so repeated /stats hits
// against an unchanged file return in microseconds. The cache is per-process
// (not shared across workers); a fresh worker rebuilds on first hit.
//
// Why doc-level coverage (not observation-level): for the observation
// channel every observation has exactly one chunk, so doc_id count and
// observation_id count are identical in the dimension we care about — and
// counting docs avoids the meta-DB join that observation-id mapping would
// require. Same number, cheaper path.

import { stat, readFile } from 'fs/promises';

export interface DreamStats {
  audit_log: {
    path: string;
    /** File size in bytes. 0 if file is missing (audit was never enabled). */
    bytes: number;
    /** Total non-empty JSON lines in the audit log. */
    entries: number;
    /** Epoch ms of the most recent audit entry; null if file is empty/missing. */
    last_entry_epoch_ms: number | null;
  };
  co_retrieval: {
    /** Distinct (doc_a, doc_b) pairs that have ever co-occurred. */
    pairs: number;
    /** Distinct doc_ids that participated in at least one pair (i.e. were
     *  surfaced alongside at least one other doc). */
    docs_covered: number;
  };
}

interface CacheEntry {
  mtimeMs: number;
  result: DreamStats;
}

const CACHE = new Map<string, CacheEntry>();

interface AuditEntry {
  ts?: number;
  hits?: Array<{ doc_id?: string }>;
}

/**
 * Read and digest the audit log, returning summary stats. Idempotent and
 * read-only. Failures (file missing, parse errors mid-file) degrade
 * gracefully — they yield zeros, never throw.
 */
export async function getDreamStats(auditLogPath: string): Promise<DreamStats> {
  let bytes = 0;
  let mtimeMs = 0;
  try {
    const st = await stat(auditLogPath);
    bytes = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return {
      audit_log: { path: auditLogPath, bytes: 0, entries: 0, last_entry_epoch_ms: null },
      co_retrieval: { pairs: 0, docs_covered: 0 },
    };
  }

  const cached = CACHE.get(auditLogPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.result;

  let text = '';
  try {
    text = await readFile(auditLogPath, 'utf8');
  } catch {
    return {
      audit_log: { path: auditLogPath, bytes, entries: 0, last_entry_epoch_ms: null },
      co_retrieval: { pairs: 0, docs_covered: 0 },
    };
  }

  let entries = 0;
  let lastTs: number | null = null;
  const pairs = new Set<string>();
  const docsCovered = new Set<string>();

  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) continue;
    entries++;
    let entry: AuditEntry;
    try {
      entry = JSON.parse(rawLine) as AuditEntry;
    } catch {
      continue;  // Corrupt line — skip but still counted in entries.
    }
    if (typeof entry.ts === 'number') lastTs = entry.ts;
    const hits = entry.hits ?? [];
    if (hits.length < 2) continue;
    const docs = Array.from(new Set(
      hits.map(h => h.doc_id).filter((d): d is string => typeof d === 'string'),
    ));
    if (docs.length < 2) continue;
    // Canonical pair keys: sort the two doc_ids so direction doesn't matter.
    for (let i = 0; i < docs.length; i++) {
      for (let j = i + 1; j < docs.length; j++) {
        const a = docs[i]!, b = docs[j]!;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        pairs.add(key);
        docsCovered.add(a);
        docsCovered.add(b);
      }
    }
  }

  const result: DreamStats = {
    audit_log: { path: auditLogPath, bytes, entries, last_entry_epoch_ms: lastTs },
    co_retrieval: { pairs: pairs.size, docs_covered: docsCovered.size },
  };
  CACHE.set(auditLogPath, { mtimeMs, result });
  return result;
}

/** Test-only: clears the per-process cache. Used by unit tests that
 *  exercise consecutive computations against a mutated audit log. */
export function _resetDreamStatsCache(): void {
  CACHE.clear();
}
