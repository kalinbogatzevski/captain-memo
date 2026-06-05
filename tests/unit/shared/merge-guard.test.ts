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
});
