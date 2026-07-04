// src/worker/worknote-semantic.ts — the SEMANTIC half of the work-coordination board.
//
// `overlapsAgainst` (work-notes.ts) catches two agents touching the same FILES. This catches two agents working
// on the same THING by MEANING in DIFFERENT files — they share no glob, so the file pass is blind to them. We
// embed each live claim's meaning text (its `what`, enriched from the session's latest observation) and flag
// pairs whose cosine similarity clears a threshold.
//
// HOT-PATH CONTRACT: /worknote/set runs on the PreToolUse hook's critical path (every Edit/Write), under a tight
// timeout. So this pass NEVER awaits the embedder inline. It compares only vectors ALREADY in the in-process
// cache and returns instantly; embedding of any newly-seen meaning is fired-and-forgotten to warm the cache for
// the NEXT call. The result is eventually-consistent: a brand-new claim's semantic overlap surfaces a click or
// two later, not on the very first edit. For a 30-min advisory lease that is invisible and the price of never
// risking the hook's budget. Embedder down/slow ⇒ cache simply never warms ⇒ file overlap still works. Fail-open.

import { semanticOverlaps, type WorkNote, type ClaimVec, type OverlapHit } from './work-notes.ts';

export const SEMANTIC_ENABLED = (process.env.CAPTAIN_MEMO_WORKNOTE_SEMANTIC ?? '1') !== '0';
// Empirically tunable. The board's philosophy is "over-warn, never under-warn", so this sits a touch below the
// ~0.85 "near-duplicate" gate. The warning prints the score so an operator can tighten/loosen from observed hits.
export const SEMANTIC_THRESHOLD = clampThreshold(Number(process.env.CAPTAIN_MEMO_WORKNOTE_SEMANTIC_THRESHOLD ?? 0.80));
const VEC_CACHE_MAX = 512;   // distinct meaning texts cached at once (LRU). A small fleet has far fewer.

function clampThreshold(n: number): number {
  return Number.isFinite(n) ? Math.min(0.99, Math.max(0.5, n)) : 0.80;
}

// what-text (trimmed) -> embedding vector. In-process, process-lifetime, miss-is-safe (just recomputed).
const VEC_CACHE = new Map<string, number[]>();
const inflight = new Set<string>();   // texts currently being embedded — de-dupes concurrent warms

function key(text: string): string { return String(text ?? '').trim(); }

/** Cached vector for a meaning text, or undefined if not yet embedded. LRU-bumps on hit. */
export function getWorknoteVec(text: string): number[] | undefined {
  const k = key(text);
  if (!k) return undefined;
  const v = VEC_CACHE.get(k);
  if (v) { VEC_CACHE.delete(k); VEC_CACHE.set(k, v); }   // move to MRU end
  return v;
}

function put(text: string, vec: number[]): void {
  const k = key(text);
  if (!k || !Array.isArray(vec) || vec.length === 0) return;
  VEC_CACHE.set(k, vec);
  while (VEC_CACHE.size > VEC_CACHE_MAX) {
    const oldest = VEC_CACHE.keys().next().value;   // insertion-order = LRU
    if (oldest === undefined) break;
    VEC_CACHE.delete(oldest);
  }
}

// Fail-open is correct (degrade to file-only overlap), but a SILENT fail-open diverges from every other embedder
// path in the worker, which logs. So we surface ONE line per outage: log on the first failure, and re-arm on the
// next success — so a persistent misconfig (rotated key, moved endpoint) is visible instead of dying silently,
// without spamming a line on every edit. Mirrors the worker's other once-only diagnostics.
let embedWarned = false;

/** Embed any of `texts` not already cached/in-flight and store them. AWAITED — used by warmWorknoteVecs (fire-
 *  and-forget) in production and directly by tests. De-dupes concurrent embeds of the same text. Fail-open: an
 *  embedder error leaves the texts uncached, to be retried on the next call (logged once per outage). */
export async function embedAndCache(texts: string[], embed: (t: string[]) => Promise<number[][]>): Promise<void> {
  const want = [...new Set(texts.map(key).filter(Boolean))].filter((t) => !VEC_CACHE.has(t) && !inflight.has(t));
  if (want.length === 0) return;
  for (const t of want) inflight.add(t);
  try {
    const vecs = await embed(want);
    for (let i = 0; i < want.length; i++) put(want[i]!, vecs[i] ?? []);
    embedWarned = false;   // recovered — re-arm so a later outage logs again
  } catch (err) {
    if (!embedWarned) {
      embedWarned = true;
      console.warn(`[worknote-semantic] warm embed failed; semantic overlap degraded to file-only: ${(err as Error)?.message ?? String(err)}`);
    }
  } finally { for (const t of want) inflight.delete(t); }
}

/** Fire-and-forget cache warm. Returns immediately; never throws into the caller. */
export function warmWorknoteVecs(texts: string[], embed: (t: string[]) => Promise<number[][]>): void {
  void embedAndCache(texts, embed).catch(() => { /* unreachable: embedAndCache swallows */ });
}

/** A claim carries real declared intent worth embedding + matching: flagged `meaningful` (explicit `what`, or a
 *  `what` enriched from an observation) AND non-empty. The hook's generic "editing N file(s) in X" placeholder is
 *  NOT meaningful — two such placeholders are byte-identical and would false-match at cosine ~1. Gate warm AND
 *  compare on this so the generic boilerplate never enters the semantic pass. */
export function hasIntent(note: WorkNote): boolean {
  return note.meaningful === true && typeof note.what === 'string' && note.what.trim().length > 0;
}

/** Semantic overlaps for `mine` against `others`, using ONLY already-cached vectors (instant, no embed). Skips
 *  any session in `fileSessions` (already warned via file overlap), and any claim without real declared intent
 *  (hasIntent). [] when mine carries no intent or isn't cached yet. */
export function semanticOverlapPass(mine: WorkNote, others: WorkNote[], fileSessions: Set<string>): OverlapHit[] {
  if (!SEMANTIC_ENABLED || !hasIntent(mine)) return [];
  const mineVec = getWorknoteVec(mine.what);
  if (!mineVec) return [];
  const claimVecs: ClaimVec[] = others.filter(hasIntent).map((o) => ({ note: o, vec: getWorknoteVec(o.what) ?? [] }));
  return semanticOverlaps({ session_id: mine.session_id, vec: mineVec }, claimVecs, SEMANTIC_THRESHOLD, fileSessions);
}

/** Test-only: drop all cached vectors + re-arm the embed-failure log so cache-dependent tests don't leak. */
export function __clearWorknoteVecCache(): void { VEC_CACHE.clear(); inflight.clear(); embedWarned = false; }
