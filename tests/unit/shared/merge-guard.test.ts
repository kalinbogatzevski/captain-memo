import { describe, test, expect } from 'bun:test';
import { mergeBlocked } from '../../../src/shared/merge-guard.ts';

describe('mergeBlocked', () => {
  // Rule 1 — negation polarity. One title asserts absence/failure, the other doesn't.
  test('blocks negation-polarity mismatch (the verified bug)', () => {
    expect(mergeBlocked('Inspected users table', 'users table missing')).toBe(true);
  });

  // Rule 2 — load-bearing identifiers that DON'T overlap (30s vs 5s, tenant A vs B).
  test('blocks differing load-bearing identifiers', () => {
    expect(mergeBlocked('timeout 30s tenant A', 'timeout 5s tenant B')).toBe(true);
  });

  // Genuine near-duplicate phrasing — must merge (no negation mismatch, no identifiers).
  test('allows genuine near-duplicate phrasings', () => {
    expect(mergeBlocked('Updated the Aelita knowledge base', 'Update Aelita knowledge base')).toBe(false);
  });

  // mergeBlocked must be symmetric.
  test('symmetric', () => {
    expect(mergeBlocked('a missing', 'a present')).toBe(mergeBlocked('a present', 'a missing'));
  });

  // --- additional cases locking the balance ---

  // Two genuine paraphrases with no identifiers and matched (zero) negation → allow.
  test('allows paraphrases with no identifiers', () => {
    expect(mergeBlocked('Refactored the cron scheduler loop', 'Cron scheduler loop refactor')).toBe(false);
  });

  // Same file path on both → shared identifier → allow.
  test('allows when both share the same file path', () => {
    expect(mergeBlocked('Edited src/worker/index.ts handler', 'Updated src/worker/index.ts handler')).toBe(false);
  });

  // Different #refs → identifier mismatch → block.
  test('blocks different #refs', () => {
    expect(mergeBlocked('Closed issue #123', 'Closed issue #456')).toBe(true);
  });

  // BOTH sides carry a negation word → rule 1 only fires on a MISMATCH, so no block on rule 1.
  // Neither carries identifiers, so rule 2 can't fire either → allow.
  test('does not block when both titles contain a negation word', () => {
    expect(mergeBlocked('config file missing', 'config value missing')).toBe(false);
  });

  // Neither side has a negation word and neither has identifiers → allow (sanity floor).
  test('allows plain titles with neither negation nor identifiers', () => {
    expect(mergeBlocked('Reviewed the deployment plan', 'Review deployment plan')).toBe(false);
  });

  // --- Rule 1 contraction coverage: "n't" must read as negation ---
  // The token-splitter shatters "isn't" → ["isn","t"], so without a contraction
  // detector these opposite-polarity pairs would silently fold. Regression for a
  // reachable silent bad merge.
  test('blocks isn\'t vs is (n\'t contraction is negation)', () => {
    expect(mergeBlocked("reindex isn't resumable after crash", 'reindex is resumable after crash')).toBe(true);
  });

  test('blocks wasn\'t vs was', () => {
    expect(mergeBlocked("the deploy wasn't successful", 'the deploy was successful')).toBe(true);
  });

  // Curly apostrophe (U+2019) variant must trip the same rule.
  test('blocks curly-apostrophe contraction vs positive', () => {
    expect(mergeBlocked('reindex isn’t resumable after crash', 'reindex is resumable after crash')).toBe(true);
  });

  // BOTH sides carry the SAME contraction → same polarity → rule 1 must NOT fire
  // (a genuine dup that merely shares a contraction stays mergeable).
  test('does not block when both sides share a contraction (same polarity)', () => {
    expect(mergeBlocked("reindex isn't resumable", "reindex isn't resumable yet")).toBe(false);
  });

  // --- Rule 2: a dotted version must not leak its own components as bare numbers ---
  // identifierSet ran /\b\d+\b/ over the raw title, so "0.10.1" contributed 0, 10 and 1 on top of
  // the dotted identifier itself. Any two version bumps then shared a component — nearly always
  // "0" or "1" — and rule 2 reads ONE shared identifier as "not blocked". The guard was therefore
  // inert on exactly the titles it matters most for.
  //
  // Found on a live corpus: this group was one merge away from collapsing ten distinct release
  // events into one row. Version facts are supersede's job (older gets demoted, both survive),
  // never dedup's (the member is archived and the history is gone).
  describe('dotted versions', () => {
    test('blocks two different version bumps that merely share a component digit', () => {
      expect(mergeBlocked(
        'Bump captain-memo version from 0.10.1 to 0.12.0',
        'Bump captain-memo version from 0.7.0 to 0.7.1',
      )).toBe(true);
    });

    test('blocks 0.5.3 -> 0.5.4 against 0.12.1 (shares 0 and 1)', () => {
      expect(mergeBlocked(
        'Bump captain-memo version 0.5.3 → 0.5.4',
        'Bump captain-memo plugin version to 0.12.1',
      )).toBe(true);
    });

    test('still merges two phrasings of the SAME bump', () => {
      expect(mergeBlocked(
        'Bump captain-memo version to 0.5.4',
        'Bumped captain-memo to version 0.5.4',
      )).toBe(false);
    });

    // A bare number that is genuinely bare must keep working as a shared identifier.
    test('does not block when the shared identifier is a real bare number', () => {
      expect(mergeBlocked('Retry the request 3 times', 'Retries the request 3 times')).toBe(false);
    });

    // Consecutive bumps CHAIN: the "to" of one is the "from" of the next, so they legitimately
    // share a version and rule 2 reads any shared identifier as permission to merge. Two adjacent
    // releases are still two events. A differing version SET is decisive on its own.
    test('blocks a chained bump that shares its boundary version', () => {
      expect(mergeBlocked(
        'Bump erp-calendar.css import version from 3.11 to 3.12',
        'Bump erp-calendar.css import version from 3.12 to 3.13',
      )).toBe(true);
    });

    test('blocks when one side names a version the other does not', () => {
      expect(mergeBlocked(
        'Merge OSS 0.10.1 into federation branch and push',
        'Merge OSS 0.10.0 into federation branch, FF live worktree',
      )).toBe(true);
    });

    // Identical version sets = the same release event described twice. Must still merge.
    test('still merges two phrasings carrying the SAME version set', () => {
      expect(mergeBlocked(
        'Bump erp-calendar.css from 3.11 to 3.12',
        'Bumped erp-calendar.css 3.11 → 3.12',
      )).toBe(false);
    });

    // "v1.30" is a version too. The \b before the digit failed inside it, so rule 3 never saw it and the shared code
    // AF00030 satisfied rule 2: a field user's corpus folded the v1.30 and v1.32 findings together.
    test('blocks v-prefixed versions that differ even when a record code is shared', () => {
      expect(mergeBlocked(
        'v1.30 route analyzer causes regression in AF00030',
        'v1.32 route analyzer causes regression in flow AF00030',
      )).toBe(true);
    });

    test('a leading v does not make the same version a different one', () => {
      expect(mergeBlocked(
        'v1.30 route analyzer causes regression in AF00030',
        'route analyzer 1.30 regression in AF00030',
      )).toBe(false);
      expect(mergeBlocked(
        'v1.30 route analyzer causes regression in AF00030',
        'V1.30 route analyzer regression found in AF00030',
      )).toBe(false);
    });

    test('a word that merely ends in v is not read as a v-prefixed version', () => {
      expect(mergeBlocked('Deployed dev1.2 to staging', 'Deployed dev1.2 to staging again')).toBe(false);
    });

    // Only ONE side carries a version ⇒ rule 3 has nothing to compare; fall through to rule 2.
    test('does not fire when only one side carries a version', () => {
      expect(mergeBlocked('Deploy the calendar stylesheet', 'Deploy the calendar stylesheet v3.12')).toBe(false);
    });
  });
});

// An outside user's corpus names every record after a code (AF00034.001, AF00020.001). The guard read the digits as
// bare numbers and the letters not at all: "AF00034.001" yielded only "001", which both titles carry, so a shared
// "identifier" let `dedup --apply` fold two different records into one.
describe('mergeBlocked — letters-and-digits codes are identifiers', () => {
  test('two different record codes block the fold (the reported case)', () => {
    expect(mergeBlocked(
      'Inspected AF00034.001 route analysis record structure',
      'Inspected AF00020.001 flow record from route analysis CSV',
    )).toBe(true);
  });
  test('the same code on both sides still folds a plain rephrasing', () => {
    expect(mergeBlocked(
      'Inspected AF00034.001 route analysis record structure',
      'Inspected AF00034.001 route analysis record layout',
    )).toBe(false);
  });
  test('p95 vs p50, v2 vs v3: different codes are different facts', () => {
    expect(mergeBlocked('p95 latency regressed after the index rebuild', 'p50 latency regressed after the index rebuild')).toBe(true);
    expect(mergeBlocked('Updated config to v2 format', 'Updated config to v3 format')).toBe(true);
  });
  test('titles with no code are untouched', () => {
    expect(mergeBlocked('Fixed the retry loop in the summarizer', 'Fixed the summarizer retry loop')).toBe(false);
  });
});


// An outside user's corpus folded two test-suite results that differ only in the count: "312/312 checks" and
// "517 checks". Both carried the ALL-CAPS word TUI, and rule 2 reads ONE shared identifier as permission to merge, so
// the numbers were never compared. Each title pair below shares an ALL-CAPS anchor (CLI, GLAB) on purpose: with it rule 2
// allows the pair, so only rule 4 can decide.
describe('mergeBlocked — differing numbers (rule 4)', () => {
  test('two counts of the same kind of result block the fold (the reported shape)', () => {
    const a = 'Full CLI test suite passes: 312/312 checks across six workflows';
    const b = 'Complete test suite passes: 517 checks across all CLI and core flows';
    expect(mergeBlocked(a, b)).toBe(true);
    expect(mergeBlocked(b, a)).toBe(true);
  });

  test('the same number worded two ways still folds', () => {
    expect(mergeBlocked(
      'CLI suite passes: 394 tests across 20 files',
      'CLI suite: all 394 tests pass across 20 files',
    )).toBe(false);
  });

  // One side only adds a detail number: the same fact, not a second one.
  test('a number one side adds does not block (257 tests / 257 tests, 0 errors)', () => {
    expect(mergeBlocked('CLI suite passes all 257 tests', 'CLI suite passes 257 tests, 0 errors')).toBe(false);
  });

  test('numbers on only one side are nothing to compare', () => {
    expect(mergeBlocked('CLI suite passes: 312 checks', 'CLI suite passes all its checks')).toBe(false);
  });

  test('titles with no numbers are untouched', () => {
    expect(mergeBlocked('CLI test suite passes across all workflows', 'Full CLI test suite passes in every workflow')).toBe(false);
  });

  // Each side has a number the other lacks even though they overlap: 2->4 and 4->8 are two different bumps.
  // "2 to" is also read as a number+unit span by identifierSet, so the digits have to be taken from the span.
  test('overlapping but neither-contains-the-other sets block, including a number+unit span', () => {
    expect(mergeBlocked('Raised CLI workers from 2 to 4', 'Raised CLI workers from 4 to 8')).toBe(true);
  });

  test('a number with a unit counts: 80% vs 95%', () => {
    expect(mergeBlocked('CLI coverage reached 80% on the exporter', 'CLI coverage reached 95% on the exporter')).toBe(true);
  });

  // "#123", "123" and "0123" are one number; only rule 4 is under test, the ALL-CAPS anchor lets rule 2 through.
  test('#123, 123 and 0123 are the same number', () => {
    const t = (n: string) => `Fixed GLAB issue ${n} in the exporter`;
    expect(mergeBlocked(t('#123'), t('123'))).toBe(false);
    expect(mergeBlocked(t('#123'), t('0123'))).toBe(false);
    expect(mergeBlocked(t('123'), t('0123'))).toBe(false);
    expect(mergeBlocked(t('#123'), t('#124'))).toBe(true);
  });

  // "30 s" is read as a number+unit span, "30 seconds" as a bare number: the digits are what is compared.
  test('30 s and 30 seconds are the same number', () => {
    expect(mergeBlocked('CLI exporter timeout set to 30 s', 'CLI exporter timeout set to 30 seconds')).toBe(false);
  });

  // Versions stay rule 3's: the dotted version's components are not numbers here, and a version bump that
  // differs only in its version is blocked by rule 3 as before.
  test('a dotted version is not read as numbers; the same version still folds', () => {
    expect(mergeBlocked('Bumped CLI exporter to 3.12 after 4 retries', 'Bumped CLI exporter to v3.12 after 4 retries')).toBe(false);
    expect(mergeBlocked('Bumped CLI exporter to 3.12', 'Bumped CLI exporter to 3.13')).toBe(true);
  });
});

// #666 — a clock time ("14:56") was read as two numbers, so two messages about one event a minute apart were
// blocked by rule 4. Measured on 9,085 folds of a live corpus: ignoring clock times frees 5 blocks, adds none, and
// none of the 5 is a wrong fold. Ignoring ISO dates as well frees 4 more, and those are different days
// (the same check on two consecutive days, a page for two different dates): wrong, so dates stay numbers.
describe('mergeBlocked — clock times are not numbers', () => {
  test('one event reported a minute apart folds (14:56 / 14:57)', () => {
    expect(mergeBlocked(
      'Sync worker log is empty or missing at 14:56 UTC+2',
      'Sync worker log not yet written at 14:57',
    )).toBe(false);
  });

  test('seconds, a sentence-final period and a time after an ISO T are clock times too', () => {
    expect(mergeBlocked('Nightly backup finished at 22:14:57', 'Nightly backup finished at 22:15:30')).toBe(false);
    expect(mergeBlocked('Nightly backup finished at 22:14.', 'Nightly backup finished at 22:15.')).toBe(false);
    expect(mergeBlocked('Backup finished 2026-07-05T22:14:57Z', 'Backup finished 2026-07-05T22:15:30Z')).toBe(false);
  });

  // Counted as an identifier, a shared "14:56" would let rule 2 through for two different services.
  test('a clock time is no identifier either: a shared time cannot vouch for two different subjects', () => {
    expect(mergeBlocked('Restarted CRON at 14:56', 'Restarted NGINX at 14:56')).toBe(true);
  });

  test('other numbers beside a clock time are still compared', () => {
    expect(mergeBlocked('Backup of 12 volumes finished at 22:14', 'Backup of 15 volumes finished at 22:14')).toBe(true);
  });

  test('a port after an address is not a clock time', () => {
    expect(mergeBlocked('Opened 192.168.1.5:22 to the office', 'Opened 192.168.1.5:80 to the office')).toBe(true);
  });

  test('different dates still block', () => {
    expect(mergeBlocked('Rotated the log archive on 2026-03-02', 'Rotated the log archive on 2026-03-04')).toBe(true);
  });
});
