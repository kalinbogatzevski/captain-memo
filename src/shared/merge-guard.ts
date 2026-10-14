// src/shared/merge-guard.ts
//
// Pure predicate guarding the dedup grouper from folding rows that share many
// tokens but mean different (or opposite) things. Four veto rules, no I/O:
//   1. Negation polarity — exactly ONE title asserts absence/failure.
//   2. Identifier mismatch — both titles carry load-bearing identifiers
//      (paths, letters-and-digits codes, numbers-with-units, #refs, ALL-CAPS /
//      uppercase single-letter tags) and they share NONE.
//   3. Version mismatch — both titles name dotted versions and not the same ones.
//   4. Number mismatch — both titles state numbers and EACH states one the other
//      does not (312 checks vs 517 checks).
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

// A clock time: 14:56, 22:14:57, 19:00-21:00 (each end), the 22:14:57 of 2026-07-05T22:14:57Z. Read as numbers it was two of
// them, so one event reported a minute apart ("... at 14:56" / "... at 14:57") was blocked by rule 4. The lookarounds keep a
// port after an address ("192.168.1.5:22") out of it. Measured on 9,085 folds of a live corpus: 5 blocks freed, none added,
// and none of the 5 a wrong fold. ISO DATES are deliberately NOT treated this way: ignoring them as well freed 4 more, and
// those were different days (the same check on two consecutive days; a page for two different dates).
const CLOCK_TIME = /(?<![\d.:])\d{1,2}:\d{2}(?::\d{2})?(?!\d|[.:]\d)/g;

// Load-bearing identifiers that descriptive titles use to distinguish instances.
// Run against the RAW title (case preserved) so ALL-CAPS and uppercase tags
// survive; results are lowercased into a comparable set.
//
// Order matters only for de-dup of the SAME substring across patterns — the
// final set comparison is order-independent.
function identifierSet(raw: string): { ids: Set<string>; nums: Set<string> } {
  const out = new Set<string>();
  // The numbers among them, for rule 4: digits only, so `#123`, `123` and `0123` are one number and
  // `30s` is 30. Collected here, in the same pass, because only here is it known which pattern matched
  // — a code like `3d` or a version's components must not be read as numbers.
  const nums = new Set<string>();
  // Ordered most-specific first. Each pattern BLANKS the spans it consumes before the next runs,
  // so a broad pattern can never re-match inside a specific one's territory.
  //
  // Without that, the bare-number rule read the components of a dotted version: "0.10.1" yielded
  // 0, 10 and 1 alongside the version itself. Rule 2 treats ONE shared identifier as grounds to
  // allow the merge, and any two versions share a "0" or a "1" — so the guard was inert on exactly
  // the titles it exists for, and ten distinct release events grouped as one duplicate cluster.
  const patterns: Array<{ re: RegExp; num?: true }> = [
    // Letters-and-digits CODE, taken whole: AF00034.001, p95, k8s, CVE-2026-1234, abc1234. Without this the digits
    // were read as bare numbers and the letters were not read at all: "AF00034.001" yielded only "001", so two
    // titles about different records (AF00034.001 vs AF00020.001) SHARED an identifier and the guard let the fold
    // through (field: an outside user's corpus of per-record titles, dry run proposed 105 groups).
    { re: /\b(?=[\w.-]*\d)(?=[\w.-]*[a-z])[a-z0-9]+(?:[.-][a-z0-9]+)*\b/gi },
    { re: /\b[\w-]+(?:\/[\w-]+)*\.[a-z][a-z0-9]{1,4}\b/gi }, // file.ext, a/b/c.ts, foo.json
    { re: /#\d+\b/g, num: true },                       // #123
    { re: /\b\d+(?:\.\d+)+\b/g },                       // dotted version 1.2.3
    { re: /\b\d+\s?(?:[a-z]{1,3}|%)\b/gi, num: true },  // number+unit: 30s, 80%, 5ms
    { re: /\b\d+\b/g, num: true },                      // bare number: 5, 200
    { re: /\b[A-Z]{2,}\b/g },                            // ALL-CAPS entity: API, DINX
    { re: /\b[A-Z]\b/g },                                // uppercase single-letter tag: tenant A
  ];
  // split('') gives UTF-16 code units, which is the same unit RegExp match indices use — so a
  // title carrying an emoji cannot shift the blanking off by one.
  // Clock times are blanked before anything runs and added to neither set: as an identifier a shared "14:56" would let
  // rule 2 vouch for two different subjects ("Restarted CRON at 14:56" / "Restarted NGINX at 14:56").
  let rest = raw.replace(CLOCK_TIME, t => ' '.repeat(t.length));
  for (const { re, num } of patterns) {
    const spans: Array<[number, number]> = [];
    for (const m of rest.matchAll(re)) {
      out.add(m[0].toLowerCase());
      if (num) nums.add(/\d+/.exec(m[0])![0].replace(/^0+(?=\d)/, ''));
      spans.push([m.index, m.index + m[0].length]);
    }
    if (spans.length === 0) continue;
    const chars = rest.split('');
    for (const [start, end] of spans) for (let i = start; i < end; i++) chars[i] = ' ';
    rest = chars.join('');
  }
  return { ids: out, nums };
}

/**
 * True when titleA and titleB must NOT be folded into one dedup group.
 * Symmetric by construction: both rules are computed from per-title sets and
 * compared symmetrically.
 */
/** Dotted versions in a title, e.g. "3.11 to 3.12" → {"3.11","3.12"}. A leading "v" is read as part of the version
 *  and dropped, so "v1.30" and "1.30" are the same one. Without it the \b before the digit failed inside "v1.30": the
 *  version went unseen, rule 2 read it as an opaque code, and "v1.30 … AF00030" folded into "v1.32 … AF00030" on the
 *  shared AF00030 (field: an outside user's corpus, 2026-10-13). */
function versionSet(raw: string): Set<string> {
  const out = new Set<string>();
  for (const m of raw.matchAll(/\bv?(\d+(?:\.\d+)+)\b/gi)) out.add(m[1]!);
  return out;
}

export function mergeBlocked(titleA: string, titleB: string): boolean {
  const na = normalizeTitle(titleA);
  const nb = normalizeTitle(titleB);

  // Rule 1 — negation polarity mismatch (exactly one side asserts absence).
  if (hasNegation(na) !== hasNegation(nb)) return true;

  // Rule 3 — both sides name dotted versions, and not the SAME ones. Checked before rule 2
  // because rule 2 is satisfied by a single shared identifier, and consecutive releases chain:
  // the "to" of one bump is the "from" of the next, so "3.11 → 3.12" and "3.12 → 3.13" really do
  // share 3.12 while being two distinct events. Version facts are supersede's job — it demotes the
  // older and BOTH rows survive — never dedup's, which archives the member and loses the history.
  // Only fires when both sides carry a version; one-sided means there is nothing to compare.
  const va = versionSet(titleA);
  const vb = versionSet(titleB);
  if (va.size > 0 && vb.size > 0) {
    if (va.size !== vb.size) return true;
    for (const v of va) if (!vb.has(v)) return true;
  }

  const { ids: ia, nums: xa } = identifierSet(titleA);
  const { ids: ib, nums: xb } = identifierSet(titleB);

  // Rule 4 — both sides state numbers and each states one the other does not: 312 checks against 517
  // checks are two measurements, not one fact worded twice. Before rule 2 for the same reason as rule 3:
  // rule 2 lets ANY single shared identifier through, and here an ALL-CAPS word (TUI) was enough to fold
  // them (field: an outside user's corpus, 2026-10-14). "Each side has a number the other lacks" rather
  // than "the sets differ": when one side merely adds a number ("257 tests" / "257 tests, 0 failures")
  // it is the same fact with more detail, and that must still fold. Measured on a live corpus's 9,085
  // folds: a plain set-difference blocked 25 more folds than this, and about 20 of those 25 were that
  // rewording. Versions are rule 3's; letters-and-digits codes are rule 2's; neither is read here.
  if (xa.size > 0 && xb.size > 0
    && [...xa].some(n => !xb.has(n)) && [...xb].some(n => !xa.has(n))) return true;

  // Rule 2 — both sides carry identifiers, but they overlap in none. Letters-and-digits codes that differ in their
  // digits alone (p95/p99, mx1/mx2, 28px/24px) still fold when the titles share any other identifier. A rule for
  // that (differing codes with one letter skeleton) was measured on the same 9,085 folds: 9 more blocked, 7 of them
  // different things (mx1/mx2, v10/v12, 28px/24px), 2 the same finding under a 1.5s/1.4s wait. Not shipped: a
  // false block is the milder error, but the rule is not free of them.
  if (ia.size > 0 && ib.size > 0) {
    for (const x of ia) if (ib.has(x)) return false; // shared identifier ⇒ not blocked by rule 2
    return true; // both have identifiers, zero shared ⇒ block
  }
  return false;
}
