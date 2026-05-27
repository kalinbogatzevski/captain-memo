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
  // header content line's visible width matches the border (⚓ is 1 string
  // char but 2 display columns, so the stripped mid-line is 1 char shorter).
  const mid = lines.find(l => l.startsWith('│'))!;
  expect(mid.length).toBe(top.length - 1);
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

test('renderStats — RECALL section shows empty-state hint when no retrievals yet', () => {
  const empty: StatsResponse = {
    ...SAMPLE,
    recall: { ever_retrieved: 0, top: [] },
  };
  const text = renderStats(empty).map(stripAnsi).join('\n');
  expect(text).toContain('RECALL');
  expect(text).toContain('Ever recalled');
  expect(text).toContain('no retrievals yet');
});

test('renderStats — RECALL section carries a one-line "what this is" subheader', () => {
  // Same explainer in both populated and empty states — anyone glancing at
  // the section can map "RECALL" to the concept without leaving the panel.
  const populated: StatsResponse = {
    ...SAMPLE,
    recall: {
      ever_retrieved: 5,
      top: [{ id: 1, type: 'feature', title: 't', retrieval_count: 3, last_retrieved_at: 1 }],
    },
  };
  const populatedText = renderStats(populated).map(stripAnsi).join('\n');
  expect(populatedText).toContain('tracks which observations you keep coming back to');

  const empty: StatsResponse = {
    ...SAMPLE,
    recall: { ever_retrieved: 0, top: [] },
  };
  const emptyText = renderStats(empty).map(stripAnsi).join('\n');
  expect(emptyText).toContain('tracks which observations you keep coming back to');
});

test('renderStats — RECALL section lists top retrieved with count and type', () => {
  const populated: StatsResponse = {
    ...SAMPLE,
    recall: {
      ever_retrieved: 42,
      top: [
        { id: 16776, type: 'discovery', title: 'Team filter implementation in calendar UI',
          retrieval_count: 8, last_retrieved_at: 1779877819 },
        { id: 16786, type: 'bugfix', title: 'parseModelName preserves haiku-4-5 version',
          retrieval_count: 5, last_retrieved_at: 1779877800 },
      ],
    },
  };
  const text = renderStats(populated).map(stripAnsi).join('\n');
  expect(text).toContain('RECALL');
  expect(text).toContain('42');
  expect(text).toContain('Top retrieved');
  expect(text).toContain('8×');
  expect(text).toContain('[discovery]');
  expect(text).toContain('Team filter implementation');
  expect(text).toContain('5×');
  expect(text).toContain('[bugfix]');
  expect(text).not.toContain('no retrievals yet');
});

test('renderStats — RECALL section is omitted entirely when recall field absent', () => {
  // Spread-omit rather than `recall: undefined` to satisfy
  // exactOptionalPropertyTypes — optional ≠ explicit undefined.
  const { recall: _unused, ...noRecall } = SAMPLE as StatsResponse & {
    recall?: StatsResponse['recall'];
  };
  void _unused;
  const text = renderStats(noRecall as StatsResponse).map(stripAnsi).join('\n');
  expect(text).not.toContain('RECALL');
});

test('renderStats — RECALL title trim guards against 200-char observation titles', () => {
  const long = 'X'.repeat(120);
  const populated: StatsResponse = {
    ...SAMPLE,
    recall: {
      ever_retrieved: 1,
      top: [{ id: 1, type: 'feature', title: long, retrieval_count: 1, last_retrieved_at: 1 }],
    },
  };
  const text = renderStats(populated).map(stripAnsi).join('\n');
  // Trimmed to <= 48 chars (47 + '…'); no raw 100-char run survives.
  expect(text).not.toContain('X'.repeat(50));
  expect(text).toContain('…');
});
