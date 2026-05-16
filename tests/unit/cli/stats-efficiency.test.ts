import { test, expect } from 'bun:test';
import { formatEfficiencyLines } from '../../../src/cli/commands/stats.ts';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('formatEfficiencyLines — renders compression, embedder and dedup', () => {
  const lines = formatEfficiencyLines({
    corpus: {
      work_tokens: 184320, stored_tokens: 11240,
      ratio: 16.4, saved_pct: 94,
      coverage: { with_data: 312, total: 340 },
    },
    embedder: { calls: 47, avg_latency_ms: 690, tokens_per_s: 4100 },
    dedup: { docs_seen: 512, skipped_unchanged: 488, skip_pct: 95 },
  }).map(stripAnsi);

  expect(lines.some(l => l.includes('16.4×'))).toBe(true);
  expect(lines.some(l => l.includes('94% saved') && l.includes('312/340'))).toBe(true);
  expect(lines.some(l => l.includes('47 calls') && l.includes('690 ms'))).toBe(true);
  expect(lines.some(l => l.includes('95%') && l.includes('488/512'))).toBe(true);
});

test('formatEfficiencyLines — null ratio shows reindex hint', () => {
  const lines = formatEfficiencyLines({
    corpus: {
      work_tokens: 0, stored_tokens: 0, ratio: null, saved_pct: null,
      coverage: { with_data: 0, total: 40 },
    },
    embedder: { calls: 0, avg_latency_ms: 0, tokens_per_s: 0 },
    dedup: { docs_seen: 0, skipped_unchanged: 0, skip_pct: 0 },
  }).map(stripAnsi);

  expect(lines.some(l => l.includes("run 'captain-memo reindex'"))).toBe(true);
});
