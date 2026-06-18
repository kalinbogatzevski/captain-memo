// src/worker/temporal-intent.ts — query-time temporal-intent detection + a
// recency-dominant re-rank of the returned top-N. Pure, no I/O, no LLM (the
// detector runs on every auto-inject). v2-gated; a no-op unless cfg.temporalIntent
// is on AND the query reads as temporal — so legacy is byte-identical.
import type { RankConfig } from './search-config.ts';

const TEMPORAL_RE = /\b(last|latest|newest|current|most[ -]recent|recent|up[ -]to[ -]date|now)\b/i;

/** True when the query asks for the newest/current state ("last/latest/current …"). */
export function detectTemporalIntent(query: string): boolean {
  return !!query && TEMPORAL_RE.test(query);
}

interface TemporalHit {
  score: number;
  channel: string;
  metadata: Record<string, unknown>;
}

/**
 * Reorder the top-N hits so the newest *relevant* dated hit wins, when the query
 * is temporal and cfg.temporalIntent is on. Reorder-only (never drops/adds).
 * Undated hits (no created_at_epoch — memory/skill) get recency 0, so a dated
 * observation above the relevance floor outranks a stale undated memory file.
 */
export function applyTemporalRerank<T extends TemporalHit>(
  hits: T[], query: string, cfg: RankConfig, nowMs: number,
): T[] {
  if (!cfg.temporalIntent || cfg.temporalHalfLifeDays <= 0 || hits.length <= 1 || !detectTemporalIntent(query)) return hits;
  const n = Math.min(cfg.temporalTopN, hits.length);
  if (n <= 1) return hits;
  const pool = hits.slice(0, n);
  const tail = hits.slice(n);
  const topScore = pool[0]!.score;
  const scored = pool.map((h, i) => {
    const eligible = h.score >= cfg.relevanceFloor * topScore;
    // recency sort key: dated-eligible by exp-decay recency (monotonic in age);
    // eligible-but-undated = 0 (above ineligible, below any dated-eligible);
    // ineligible = -1 (sinks to the bottom of the reordered pool). Higher = earlier.
    let key = -1;
    if (eligible) {
      const epochS = typeof h.metadata.created_at_epoch === 'number' ? h.metadata.created_at_epoch : null;
      if (epochS === null) {
        key = 0;
      } else {
        const ageMs = nowMs - epochS * 1000;
        const halfMs = cfg.temporalHalfLifeDays * 86_400_000;
        key = ageMs > 0 ? Math.exp(-Math.LN2 * ageMs / halfMs) : 1;
      }
    }
    return { h, key, i };
  });
  // Recency-primary: sort by key desc, tie-break original index (stable).
  scored.sort((a, b) => b.key - a.key || a.i - b.i);
  return [...scored.map(s => s.h), ...tail];
}
