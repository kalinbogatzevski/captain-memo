// src/shared/merge-guard.ts
//
// Pure predicate guarding the dedup grouper from folding rows that share many
// tokens but mean different (or opposite) things. Two veto rules, no I/O:
//   1. Negation polarity — exactly ONE title asserts absence/failure.
//   2. Identifier mismatch — both titles carry load-bearing identifiers
//      (paths, numbers-with-units, #refs, ALL-CAPS / uppercase single-letter
//      tags) and they share NONE.
// Title-only by design: the standalone `dedup` CLI has no vector DB; the
// cosine-≥0.98 confirm rides with the Quartermaster (Release 2).
//
// Safety asymmetry: a false block merely leaves a dup un-merged (mild); a false
// allow corrupts the survivor (the bug). So both rules lean toward blocking on a
// genuine mismatch — but the identifier patterns stay deliberately narrow
// (uppercase-only single letters, no lone articles) so plain near-dup phrasings
// still merge.
import { normalizeTitle } from './title-similarity.ts';

// Absence / negation / failure tokens. Matched on the lowercased, normalized
// title against whole tokens only (so "noteworthy" never trips "no").
const NEGATION = new Set([
  'missing', 'absent', 'absence', 'fails', 'failing', 'failed', 'fail',
  'broken', 'none', 'empty', 'removed', 'deleted', 'disabled', 'off',
  'false', 'unavailable', 'cannot', 'without', 'lacks', 'lacking', 'no', 'not',
]);

// The "n't" suffix is exclusively the negation contraction in English, so a
// regex over the normalized (apostrophe-preserving) title is sound. The token
// splitter shatters "isn't" → ["isn","t"], which would otherwise read as ZERO
// negation; this fires first to catch the contraction directly. Handles both the
// straight (U+0027) and curly (U+2019) apostrophe.
const NT_CONTRACTION = /[a-z]+n['’]t\b/;  // isn't, couldn't, won't, can't, wasn't, doesn't, ...

/** Whether the normalized title contains at least one absence/negation token. */
function hasNegation(norm: string): boolean {
  if (NT_CONTRACTION.test(norm)) return true;
  for (const tok of norm.split(/[^a-z0-9]+/)) {
    if (NEGATION.has(tok)) return true;
  }
  return false;
}

// Load-bearing identifiers that descriptive titles use to distinguish instances.
// Run against the RAW title (case preserved) so ALL-CAPS and uppercase tags
// survive; results are lowercased into a comparable set.
//
// Order matters only for de-dup of the SAME substring across patterns — the
// final set comparison is order-independent.
function identifierSet(raw: string): Set<string> {
  const out = new Set<string>();
  const patterns: RegExp[] = [
    /\b[\w-]+(?:\/[\w-]+)*\.[a-z][a-z0-9]{1,4}\b/gi, // file.ext, a/b/c.ts, foo.json
    /#\d+\b/g,                                        // #123
    /\b\d+(?:\.\d+)+\b/g,                             // dotted version 1.2.3
    /\b\d+\s?(?:[a-z]{1,3}|%)\b/gi,                   // number+unit: 30s, 80%, 5ms
    /\b\d+\b/g,                                       // bare number: 5, 200
    /\b[A-Z]{2,}\b/g,                                 // ALL-CAPS entity: API, DINX
    /\b[A-Z]\b/g,                                     // uppercase single-letter tag: tenant A
  ];
  for (const re of patterns) {
    for (const m of raw.matchAll(re)) out.add(m[0].toLowerCase());
  }
  return out;
}

/**
 * True when titleA and titleB must NOT be folded into one dedup group.
 * Symmetric by construction: both rules are computed from per-title sets and
 * compared symmetrically.
 */
export function mergeBlocked(titleA: string, titleB: string): boolean {
  const na = normalizeTitle(titleA);
  const nb = normalizeTitle(titleB);

  // Rule 1 — negation polarity mismatch (exactly one side asserts absence).
  if (hasNegation(na) !== hasNegation(nb)) return true;

  // Rule 2 — both sides carry identifiers, but they overlap in none.
  const ia = identifierSet(titleA);
  const ib = identifierSet(titleB);
  if (ia.size > 0 && ib.size > 0) {
    for (const x of ia) if (ib.has(x)) return false; // shared identifier ⇒ not blocked by rule 2
    return true; // both have identifiers, zero shared ⇒ block
  }
  return false;
}
