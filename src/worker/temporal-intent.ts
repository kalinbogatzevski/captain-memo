// src/worker/temporal-intent.ts — query-time temporal-intent detection + a
// gentle, bounded recency blend over the returned top-N. Pure, no I/O, no LLM
// (the detector runs on every auto-inject). Gated: a no-op unless cfg.temporalIntent
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
 * Blend a gentle recency factor into the top-N when the query is temporal and
 * cfg.temporalIntent is on: final = score · factor, then sort by final.
 *
 * factor is a bounded multiplier in [temporalFloor, 1]:
 *   factor = temporalFloor + (1 - temporalFloor) · exp(-ln2 · ageDays / halfLife)
 * so a maximally-stale observation still keeps ≥ temporalFloor of its relevance —
 * recency reorders near-ties but never buries a much-more-relevant older fact.
 *
 * Channel-aware: only the `observation` channel decays. Curated memory/skill (and
 * remote) are exempt (factor 1) so authoritative references are never pushed below
 * fresh observations. Undated (no created_at_epoch), halfLife ≤ 0, or a future
 * timestamp → factor 1 (neutral, never a penalty).
 */
export function applyTemporalRerank<T extends TemporalHit>(
  hits: T[], query: string, cfg: RankConfig, nowMs: number,
): T[] {
  if (!cfg.temporalIntent || hits.length <= 1 || !detectTemporalIntent(query)) return hits;
  const n = Math.min(cfg.temporalTopN, hits.length);
  if (n <= 1) return hits;
  const pool = hits.slice(0, n);
  const tail = hits.slice(n);
  const halfMs = cfg.temporalHalfLifeDays * 86_400_000;
  const floor = cfg.temporalFloor;
  const scored = pool.map((h, i) => {
    let factor = 1;
    if (h.channel === 'observation' && halfMs > 0) {
      const epochS = typeof h.metadata.created_at_epoch === 'number' ? h.metadata.created_at_epoch : null;
      if (epochS !== null) {
        const ageMs = nowMs - epochS * 1000;
        if (ageMs > 0) factor = floor + (1 - floor) * Math.exp(-Math.LN2 * ageMs / halfMs);
      }
    }
    return { h: { ...h, score: h.score * factor }, score: h.score * factor, i };
  });
  // Gentle blend: sort by blended score desc, stable tie-break on original index.
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return [...scored.map(s => s.h), ...tail];
}
