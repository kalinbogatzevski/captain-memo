import { test, expect } from 'bun:test';
import { bar, renderStats, type StatsResponse } from '../../../src/cli/stats-render.ts';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const SAMPLE: StatsResponse = {
  total_chunks: 24551,
  by_channel: { memory: 279, observation: 24272 },
  observations: { total: 10593, queue_pending: 0, queue_processing: 3 },
  indexing: {
    status: 'ready', total: 279, done: 279, errors: 0,
    started_at_epoch: 0, finished_at_epoch: 0, last_error: null,
    elapsed_s: 0, percent: 100,
  },
  project_id: 'default',
  version: '0.1.10',
  embedder: { model: 'voyage-4-lite', endpoint: 'https://api.voyageai.com/v1/embeddings' },
  disk: { bytes: 515_000_000, path: '/home/k/.captain-memo' },
  efficiency: {
    corpus: { work_tokens: 9_300_000, stored_tokens: 710_000, ratio: 13.1, saved_pct: 92,
              coverage: { with_data: 10593, total: 10593 } },
    embedder: { calls: 47, avg_latency_ms: 690, tokens_per_s: 4100 },
    dedup: { docs_seen: 10870, skipped_unchanged: 10870, skip_pct: 100 },
  },
};

test('bar — fills proportionally and clamps out-of-range fractions', () => {
  expect(bar(0, 10)).toBe('▕░░░░░░░░░░▏');
  expect(bar(1, 10)).toBe('▕██████████▏');
  expect(bar(0.5, 10)).toBe('▕█████░░░░░▏');
  expect(bar(-1, 4)).toBe('▕░░░░▏');         // clamped low
  expect(bar(2, 4)).toBe('▕████▏');          // clamped high
});

test('renderStats — renders the framed panel with all sections', () => {
  const lines = renderStats(SAMPLE).map(stripAnsi);
  const text = lines.join('\n');
  expect(text).toContain('CAPTAIN MEMO');
  expect(text).toContain('CORPUS');
  expect(text).toContain('EFFICIENCY');
  expect(text).toContain('observation');
  expect(text).toContain('13.1×');
  expect(text).toContain('92%');
  expect(text).toContain('47 calls');
  // header panel: top and bottom borders are equal width
  const top = lines.find(l => l.startsWith('╭'))!;
  const bot = lines.find(l => l.startsWith('╰'))!;
  expect(top.length).toBe(bot.length);
});

test('renderStats — null ratio shows the populating hint, no bar', () => {
  const noRatio: StatsResponse = {
    ...SAMPLE,
    efficiency: {
      ...SAMPLE.efficiency!,
      corpus: { work_tokens: 0, stored_tokens: 0, ratio: null, saved_pct: null,
                coverage: { with_data: 0, total: 40 } },
    },
  };
  const text = renderStats(noRatio).map(stripAnsi).join('\n');
  expect(text).toContain('populating');
  expect(text).not.toContain('×');
});

test('renderStats — tolerates a worker with no efficiency field', () => {
  const noEff: StatsResponse = { ...SAMPLE, efficiency: undefined };
  const text = renderStats(noEff).map(stripAnsi).join('\n');
  expect(text).toContain('CORPUS');
  expect(text).not.toContain('EFFICIENCY');
});
