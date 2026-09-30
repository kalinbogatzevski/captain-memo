// tests/unit/dream-stats.test.ts
//
// Tests for the audit-log digestion that feeds the DREAM section of
// `captain-memo stats`. Exercise: zero state (no file), populated state
// (real JSONL), corrupt-line tolerance, pair-counting correctness, and
// the mtime-keyed cache.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from 'fs';
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

test('getDreamStats — incremental: an APPEND is reflected immediately (fresh), digesting only the tail', async () => {
  writeFileSync(auditPath, JSON.stringify({ ts: 1, hits: [{ doc_id: 'a' }, { doc_id: 'b' }] }) + '\n');
  const first = await getDreamStats(auditPath);
  expect(first.co_retrieval.pairs).toBe(1);
  expect(first.audit_log.entries).toBe(1);

  // Append a new line (normal recall). Incremental digest must pick it up IMMEDIATELY
  // — no TTL staleness — while only processing the appended tail, not re-reading the file.
  appendFileSync(auditPath, JSON.stringify({ ts: 2, hits: [{ doc_id: 'a' }, { doc_id: 'c' }] }) + '\n');
  const grown = await getDreamStats(auditPath);
  expect(grown.co_retrieval.pairs).toBe(2);          // a|b and a|c
  expect(grown.co_retrieval.docs_covered).toBe(3);   // a, b, c
  expect(grown.audit_log.entries).toBe(2);
  expect(grown.audit_log.bytes).toBe(statSync(auditPath).size);
});

test('getDreamStats — incremental: a partial trailing line (write in flight) is not counted until completed', async () => {
  writeFileSync(auditPath, JSON.stringify({ ts: 1, hits: [{ doc_id: 'a' }, { doc_id: 'b' }] }) + '\n');
  await getDreamStats(auditPath);   // seed: entries=1, pairs=1

  // Append a line WITHOUT a trailing newline — mid-write.
  appendFileSync(auditPath, JSON.stringify({ ts: 2, hits: [{ doc_id: 'a' }, { doc_id: 'c' }] }));
  const midWrite = await getDreamStats(auditPath);
  expect(midWrite.audit_log.entries).toBe(1);         // partial line not yet counted
  expect(midWrite.co_retrieval.pairs).toBe(1);

  // Complete the line (append the newline). Now it counts.
  appendFileSync(auditPath, '\n');
  const completed = await getDreamStats(auditPath);
  expect(completed.audit_log.entries).toBe(2);
  expect(completed.co_retrieval.pairs).toBe(2);
});

test('getDreamStats — truncation/rotation (file shrinks) resets the digest and recomputes', async () => {
  writeFileSync(auditPath, [
    JSON.stringify({ ts: 1, hits: [{ doc_id: 'a' }, { doc_id: 'b' }] }),
    JSON.stringify({ ts: 2, hits: [{ doc_id: 'a' }, { doc_id: 'c' }] }),
  ].join('\n') + '\n');
  const before = await getDreamStats(auditPath);
  expect(before.co_retrieval.pairs).toBe(2);

  // Rotate: the log is replaced with a smaller one (offset now past EOF → reset).
  writeFileSync(auditPath, JSON.stringify({ ts: 3, hits: [{ doc_id: 'x' }, { doc_id: 'y' }] }) + '\n');
  const after = await getDreamStats(auditPath);
  expect(after.audit_log.entries).toBe(1);
  expect(after.co_retrieval.pairs).toBe(1);
  expect(after.co_retrieval.docs_covered).toBe(2);   // x, y — old a/b/c gone
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

test('injected — accumulates across incremental reads without double-counting', async () => {
  const T0 = 1_800_000_000_000;
  writeFileSync(auditPath, JSON.stringify({ ts: T0, injected_tokens: 100, hits: [] }) + '\n');
  const first = await getDreamStats(auditPath);
  expect(first.injected.tokens).toBe(100);
  appendFileSync(auditPath, JSON.stringify({ ts: T0 + 1, injected_tokens: 250, hits: [] }) + '\n');
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

test('two overlapping digests of one log count it ONCE, not twice', async () => {
  // The boot pre-warm and the ~10s corpus poll both call this, and /stats/lite has no
  // single-flight guard, so they genuinely overlap. Read position was captured after the
  // awaits and advanced with `+=`, so both reads digested the same bytes and each advanced
  // the offset — measured at exactly 2.00x entries and tokens against the live 24.5 MB audit
  // log, and the phantom offset then skipped the next chunk permanently.
  const dir = mkdtempSync(join(tmpdir(), 'cm-dream-race-'));
  const log = join(dir, 'recall-audit.jsonl');
  try {
    const line = (i: number) => JSON.stringify({
      ts: Date.now(), session_id: `s${i}`, project_id: 'p', query: 'q',
      hits: [{ doc_id: `observation:${i}:x`, channel: 'observation', score: 1, snippet: 's' }],
    }) + '\n';
    writeFileSync(log, Array.from({ length: 10 }, (_, i) => line(i)).join(''));

    _resetDreamStatsCache?.();
    const [a, b] = await Promise.all([getDreamStats(log), getDreamStats(log)]);
    // Whichever resolves, neither may report more than the file contains.
    for (const r of [a, b]) {
      expect(r.audit_log.entries).toBeLessThanOrEqual(10);
    }
    // And the settled state must still be exact — not doubled, not short.
    const after = await getDreamStats(log);
    expect(after.audit_log.entries).toBe(10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
