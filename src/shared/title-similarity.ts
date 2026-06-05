// src/shared/title-similarity.ts
//
// Pure title-similarity primitives shared by the dashboard's near-dup collapse
// (getRecallStats) and the `captain-memo dedup` command. No I/O, no deps.
//
// The summarizer routinely emits several near-identical phrasings of one fact
// (e.g. five variants of "update-status skill is available"). These helpers let
// callers group such phrasings by token-set overlap so the user sees distinct
// concepts, not five rows of one.

export const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

// Small, conservative stopword set. Kept deliberately short — over-aggressive
// stopword removal would erase the signal that distinguishes near-dupes from
// genuinely different titles.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'into', 'from',
  'was', 'were', 'are', 'has', 'have', 'had', 'its', 'but', 'not',
  'you', 'your', 'our', 'out', 'via', 'per', 'all', 'any', 'can',
  'did', 'does',
]);

/** Lowercase, strip a trailing ellipsis (… or ...), collapse internal
 *  whitespace, trim. The trailing-ellipsis strip matters because display code
 *  truncates titles with "…" — we never want that artifact to affect matching. */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/(\.\.\.|…)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Significant tokens of a title: split on non-alphanumerics, drop tokens
 *  shorter than 3 chars and the curated stopwords. Returns a Set for O(1)
 *  intersection. Tradeoff: short identifiers (db, ui) are dropped — acceptable
 *  for descriptive observation titles. */
export function significantTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const tok of normalizeTitle(s).split(/[^a-z0-9]+/)) {
    if (tok.length < 3) continue;
    if (STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/** Jaccard overlap |a ∩ b| / |a ∪ b|. Empty union returns 0 so title-less
 *  rows never merge on similarity alone. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Greedy single-pass grouping by token-set similarity. Items are consumed in
 *  the order given — callers pre-sort by count (desc) so each group's first
 *  element (the representative) is the highest-count phrasing. An item joins an
 *  existing group when its Jaccard against the group's representative meets the
 *  threshold AND the optional `blocked` veto does not reject the pair (so a
 *  semantic guard can keep opposite-meaning titles apart even when their tokens
 *  overlap). Omitting `blocked` preserves the pure-Jaccard behavior exactly.
 *  Returns groups in representative order. */
export function groupBySimilarity<T>(
  items: T[],
  getTitle: (item: T) => string,
  threshold: number,
  blocked?: (repTitle: string, candidateTitle: string) => boolean,
): T[][] {
  const tokens = items.map((it) => significantTokens(getTitle(it)));
  const groups: T[][] = [];
  const taken = new Array<boolean>(items.length).fill(false);

  for (let i = 0; i < items.length; i++) {
    if (taken[i]) continue;
    // Open a new group with item i as its representative.
    const group: T[] = [items[i]!];
    taken[i] = true;
    const repTokens = tokens[i]!;
    const repTitle = getTitle(items[i]!);
    for (let j = i + 1; j < items.length; j++) {
      if (taken[j]) continue;
      if (jaccard(repTokens, tokens[j]!) >= threshold
        && !(blocked && blocked(repTitle, getTitle(items[j]!)))) {
        group.push(items[j]!);
        taken[j] = true;
      }
    }
    groups.push(group);
  }
  return groups;
}
