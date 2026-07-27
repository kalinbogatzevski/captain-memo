// tests/unit/dream-stats.test.ts
//
// Tests for the audit-log digestion that feeds the DREAM section of
// `captain-memo stats`. Exercise: zero state (no file), populated state
// (real JSONL), corrupt-line tolerance, pair-counting correctness, and
// the mtime-keyed cache.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, utimesSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getDreamStats, _resetDreamStatsCache } from '../../src/worker/dream-stats.ts';

let workDir: string;
let auditPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-dream-stats-'));
  auditPath = join(workDir, 'recall-audit.jsonl');
  _resetDreamStatsCache();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test('getDreamStats — missing audit log returns zeroed shape', async () => {
  const s = await getDreamStats(auditPath);
  expect(s.audit_log.bytes).toBe(0);
  expect(s.audit_log.entries).toBe(0);
  expect(s.audit_log.last_entry_epoch_ms).toBeNull();
  expect(s.co_retrieval.pairs).toBe(0);
  expect(s.co_retrieval.docs_covered).toBe(0);
});

test('getDreamStats — counts entries and last timestamp from real audit lines', async () => {
  const lines = [
    JSON.stringify({ ts: 1000, hits: [{ doc_id: 'a' }] }),
    JSON.stringify({ ts: 2000, hits: [{ doc_id: 'a' }, { doc_id: 'b' }] }),
    JSON.stringify({ ts: 3000, hits: [{ doc_id: 'b' }, { doc_id: 'c' }] }),
    '',                                                       // empty line skipped
    JSON.stringify({ ts: 4000, hits: [{ doc_id: 'a' }, { doc_id: 'c' }] }),
  ];
  writeFileSync(auditPath, lines.join('\n') + '\n');

  const s = await getDreamStats(auditPath);
  expect(s.audit_log.entries).toBe(4);
  expect(s.audit_log.last_entry_epoch_ms).toBe(4000);
  // Pairs: (a,b), (b,c), (a,c) — 3 unique unordered pairs.
  expect(s.co_retrieval.pairs).toBe(3);
  // Docs covered: a, b, c — all three appeared in at least one pair.
  expect(s.co_retrieval.docs_covered).toBe(3);
});

test('getDreamStats — duplicate doc_ids within one hit list collapse to one', async () => {
  // Same doc_id twice in one entry must not create a (a,a) self-pair.
  writeFileSync(auditPath, JSON.stringify({
    ts: 1, hits: [{ doc_id: 'a' }, { doc_id: 'a' }, { doc_id: 'b' }],
  }) + '\n');
  const s = await getDreamStats(auditPath);
  expect(s.co_retrieval.pairs).toBe(1);
  expect(s.co_retrieval.docs_covered).toBe(2);
});

test('getDreamStats — singleton hits contribute no pair', async () => {
  // One-hit and zero-hit entries contribute no pair signal but still count.
  writeFileSync(auditPath, [
    JSON.stringify({ ts: 1, hits: [{ doc_id: 'a' }] }),
    JSON.stringify({ ts: 2, hits: [] }),
    JSON.stringify({ ts: 3 }),                                // no hits field
  ].join('\n') + '\n');
  const s = await getDreamStats(auditPath);
  expect(s.audit_log.entries).toBe(3);
  expect(s.co_retrieval.pairs).toBe(0);
  expect(s.co_retrieval.docs_covered).toBe(0);
});

test('getDreamStats — corrupt JSON lines are skipped without throwing', async () => {
  writeFileSync(auditPath, [
    JSON.stringify({ ts: 1, hits: [{ doc_id: 'a' }, { doc_id: 'b' }] }),
    '{this is not json',
    JSON.stringify({ ts: 2, hits: [{ doc_id: 'a' }, { doc_id: 'c' }] }),
  ].join('\n') + '\n');
  const s = await getDreamStats(auditPath);
  expect(s.audit_log.entries).toBe(3);
  expect(s.co_retrieval.pairs).toBe(2);             // (a,b) and (a,c)
});

test('getDreamStats — caches against mtime; mutation invalidates cache', async () => {
  writeFileSync(auditPath, JSON.stringify({
    ts: 1, hits: [{ doc_id: 'a' }, { doc_id: 'b' }],
  }) + '\n');
  const first = await getDreamStats(auditPath);
  expect(first.co_retrieval.pairs).toBe(1);

  // Same file unchanged → cache hit (we can't directly observe the cache, but
  // we can prove correctness by asserting the second call returns the same
  // object identity for the audit_log field — set/Map values are reused).
  const cachedHit = await getDreamStats(auditPath);
  expect(cachedHit).toBe(first);

  // Mutate the file AND push mtime forward to guarantee cache invalidation.
  writeFileSync(auditPath, [
    JSON.stringify({ ts: 1, hits: [{ doc_id: 'a' }, { doc_id: 'b' }] }),
    JSON.stringify({ ts: 2, hits: [{ doc_id: 'a' }, { doc_id: 'c' }] }),
  ].join('\n') + '\n');
  const oldMtime = statSync(auditPath).mtimeMs;
  utimesSync(auditPath, new Date(), new Date(oldMtime + 5000));

  const refreshed = await getDreamStats(auditPath);
  expect(refreshed).not.toBe(first);
  expect(refreshed.co_retrieval.pairs).toBe(2);
});

test('injected — sums tokens and derives the start date from the data', async () => {
  const T0 = 1_800_000_000_000;
  writeFileSync(auditPath, [
    // A search-path line: no injected_tokens, must not count toward either figure.
    JSON.stringify({ ts: T0 - 5000, session_id: 'search', query: 'q', hits: [] }),
    JSON.stringify({ ts: T0, injected_tokens: 400, hits: [] }),
    JSON.stringify({ ts: T0 + 1000, injected_tokens: 600, hits: [] }),
  ].join('\n') + '\n');
  const s = await getDreamStats(auditPath);
  expect(s.injected.tokens).toBe(1000);
  expect(s.injected.injections).toBe(2);
  // The EARLIER search line must not become the start date — only measured
  // injections define when the measurement began.
  expect(s.injected.since_epoch_ms).toBe(T0);
});

test('injected — a genuine zero-token injection still counts as one', async () => {
  // Guarding on truthiness instead of presence would silently drop these and
  // inflate the per-injection average.
  writeFileSync(auditPath, JSON.stringify({ ts: 1_800_000_000_000, injected_tokens: 0, hits: [] }) + '\n');
  const s = await getDreamStats(auditPath);
  expect(s.injected.injections).toBe(1);
  expect(s.injected.tokens).toBe(0);
});

test('injected — totals stay correct after the log is appended to', async () => {
  const T0 = 1_800_000_000_000;
  writeFileSync(auditPath, JSON.stringify({ ts: T0, injected_tokens: 100, hits: [] }) + '\n');
  const first = await getDreamStats(auditPath);
  expect(first.injected.tokens).toBe(100);
  appendFileSync(auditPath, JSON.stringify({ ts: T0 + 1, injected_tokens: 250, hits: [] }) + '\n');
  // Force a distinct mtime: this line's digest is mtime-keyed, and both writes can
  // land inside the same millisecond, which would serve the cached pre-append result.
  // Same technique the pair-counting cache test above uses.
  utimesSync(auditPath, new Date(), new Date(statSync(auditPath).mtimeMs + 5000));
  const second = await getDreamStats(auditPath);
  expect(second.injected.tokens).toBe(350);        // 100 counted once, not twice
  expect(second.injected.injections).toBe(2);
  expect(second.injected.since_epoch_ms).toBe(T0); // start date survives the incremental read
});

test('injected — zeroed when the audit log does not exist', async () => {
  const s = await getDreamStats(auditPath);
  expect(s.injected.tokens).toBe(0);
  expect(s.injected.injections).toBe(0);
  expect(s.injected.since_epoch_ms).toBeNull();
});
