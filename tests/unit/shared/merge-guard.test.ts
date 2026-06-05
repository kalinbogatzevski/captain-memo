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
});
