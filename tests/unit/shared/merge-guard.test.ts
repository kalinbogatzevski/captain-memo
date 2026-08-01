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

    // Only ONE side carries a version ⇒ rule 3 has nothing to compare; fall through to rule 2.
    test('does not fire when only one side carries a version', () => {
      expect(mergeBlocked('Deploy the calendar stylesheet', 'Deploy the calendar stylesheet v3.12')).toBe(false);
    });
  });
});
