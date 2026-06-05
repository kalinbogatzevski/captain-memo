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

test('renderStats — renders the wordmark, double-rule header, and all sections', () => {
  const lines = renderStats(SAMPLE).map(stripAnsi);
  const text = lines.join('\n');
  expect(text).toContain('CAPTAIN MEMO');
  expect(text).toContain('Corpus');
  expect(text).toContain('Efficiency');
  expect(text).toContain('observation');
  expect(text).toContain('13.1×');
  expect(text).toContain('92%');
  expect(text).toContain('47 calls');
  // Header is now two lines: wordmark, then a double-rule '═' line.
  const wordmarkLine = lines.find(l => l.includes('⚓'))!;
  const ruleLine = lines.find(l => l.startsWith('  ═'))!;
  expect(wordmarkLine).toBeDefined();
  expect(ruleLine).toBeDefined();
  // The double-rule extends to the panel width minus the 2-char indent.
  // We don't pin an exact byte count here since UTF-8 width of '═' is 3.
  expect(ruleLine.length).toBeGreaterThan(wordmarkLine.length / 2);
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
  expect(text).toContain('Corpus');
  expect(text).not.toContain('Efficiency');
});

const EMPTY_RECALL: NonNullable<StatsResponse['recall']> = {
  surfaced_count: 0,
  recalled_count: 0,
  totals: { auto: 0, search: 0, drill: 0 },
  top_surfaced: [],
  top_recalled: [],
};

test('renderStats — Recall section shows empty-state hint when no retrievals yet', () => {
  const empty: StatsResponse = { ...SAMPLE, recall: EMPTY_RECALL };
  const text = renderStats(empty).map(stripAnsi).join('\n');
  expect(text).toContain('Recall');
  expect(text).toContain('Surfaced');
  expect(text).toContain('no retrievals yet');
});

test('renderStats — Recall section carries a one-line "what this is" subheader', () => {
  // Same explainer in both populated and empty states.
  const populated: StatsResponse = {
    ...SAMPLE,
    recall: {
      surfaced_count: 5,
      recalled_count: 2,
      totals: { auto: 10, search: 3, drill: 2 },
      top_surfaced: [{ id: 1, type: 'feature', title: 't',
        from_auto: 9, from_search: 0, from_drill: 0, last_surfaced_at: 1 }],
      top_recalled: [{ id: 1, type: 'feature', title: 't',
        from_auto: 9, from_search: 0, from_drill: 2, last_surfaced_at: 1 }],
    },
  };
  const populatedText = renderStats(populated).map(stripAnsi).join('\n');
  expect(populatedText).toContain('how memory actually gets used');

  const empty: StatsResponse = { ...SAMPLE, recall: EMPTY_RECALL };
  const emptyText = renderStats(empty).map(stripAnsi).join('\n');
  expect(emptyText).toContain('how memory actually gets used');
});

test('renderStats — RECALL section shows surfaced + recalled + drill-in rate, with provenance per entry', () => {
  const populated: StatsResponse = {
    ...SAMPLE,
    recall: {
      surfaced_count: 4200,
      recalled_count: 42,
      totals: { auto: 9876, search: 314, drill: 42 },
      top_surfaced: [
        { id: 16776, type: 'discovery', title: 'Team filter implementation in calendar UI',
          from_auto: 138, from_search: 3, from_drill: 1, last_surfaced_at: 1779877819 },
      ],
      top_recalled: [
        { id: 16786, type: 'bugfix', title: 'parseModelName preserves haiku-4-5 version',
          from_auto: 0, from_search: 1, from_drill: 5, last_surfaced_at: 1779877800 },
      ],
    },
  };
  const text = renderStats(populated).map(stripAnsi).join('\n');
  expect(text).toContain('Recall');
  expect(text).toContain('Surfaced');
  expect(text).toContain('4 200');                  // grouped count
  expect(text).toContain('Recalled');
  expect(text).toContain('Drill-in rate');
  expect(text).toContain('Top surfaced');
  expect(text).toContain('Top recalled');
  expect(text).toContain('142×');                   // 138 + 3 + 1
  expect(text).toContain('[discovery]');
  expect(text).toContain('Team filter implementation');
  expect(text).toContain('auto: 138');
  expect(text).toContain('search: 3');
  expect(text).toContain('drill: 1');
  expect(text).toContain('6×');                     // 0 + 1 + 5
  expect(text).toContain('[bugfix]');
  expect(text).not.toContain('no retrievals yet');
});

test('renderStats — Recall shows a live "Last surfaced" pulse from recent_surfaced[0]', () => {
  const nowS = Math.floor(Date.now() / 1000);
  const stats: StatsResponse = {
    ...SAMPLE,
    recall: {
      surfaced_count: 5, recalled_count: 2,
      totals: { auto: 10, search: 3, drill: 2 },
      top_surfaced: [{ id: 1, type: 'feature', title: 'A',
        from_auto: 5, from_search: 0, from_drill: 0, last_surfaced_at: nowS }],
      top_recalled: [],
      recent_surfaced: [
        { id: 9, type: 'discovery', title: 'team filter in calendar',
          last_surfaced_at: nowS - 4, source: 'auto' },
      ],
    },
  };
  const text = renderStats(stats).map(stripAnsi).join('\n');
  expect(text).toContain('Last surfaced');
  expect(text).toContain('team filter in calendar');
  expect(text).toContain('4s');  // age of the most recent surfacing
});

test('renderStats — Recall shows a "Recently surfaced" list of recent entries', () => {
  const nowS = Math.floor(Date.now() / 1000);
  const stats: StatsResponse = {
    ...SAMPLE,
    recall: {
      surfaced_count: 5, recalled_count: 2,
      totals: { auto: 10, search: 3, drill: 2 },
      top_surfaced: [{ id: 1, type: 'feature', title: 'A',
        from_auto: 5, from_search: 0, from_drill: 0, last_surfaced_at: nowS }],
      top_recalled: [],
      recent_surfaced: [
        { id: 9, type: 'discovery', title: 'team filter in calendar', last_surfaced_at: nowS - 4, source: 'auto' },
        { id: 8, type: 'feature', title: 'split retrieval tracking', last_surfaced_at: nowS - 40, source: 'search' },
        { id: 7, type: 'bugfix', title: 'parseModelName preserves version', last_surfaced_at: nowS - 130, source: 'drill' },
      ],
    },
  };
  const text = renderStats(stats).map(stripAnsi).join('\n');
  expect(text).toContain('Recently surfaced');
  expect(text).toContain('split retrieval tracking');
  // Long titles trim to the column width; assert the surviving prefix.
  expect(text).toContain('parseModelName preserves');
});

test('renderStats — collapsed top entry shows the "(+N similar)" annotation', () => {
  const stats: StatsResponse = {
    ...SAMPLE,
    recall: {
      surfaced_count: 5, recalled_count: 0,
      totals: { auto: 15, search: 0, drill: 0 },
      top_surfaced: [{ id: 1, type: 'discovery', title: 'update-status skill available',
        from_auto: 15, from_search: 0, from_drill: 0, last_surfaced_at: 1, variants: 5 }],
      top_recalled: [],
    },
  };
  const text = renderStats(stats).map(stripAnsi).join('\n');
  expect(text).toContain('(+4 similar)');   // 5 variants → 4 others
  expect(text).toContain('15×');            // summed count
});

test('renderStats — no "(+N similar)" when an entry has variants 1 or undefined', () => {
  const stats: StatsResponse = {
    ...SAMPLE,
    recall: {
      surfaced_count: 1, recalled_count: 0,
      totals: { auto: 3, search: 0, drill: 0 },
      top_surfaced: [{ id: 1, type: 'discovery', title: 'singleton observation',
        from_auto: 3, from_search: 0, from_drill: 0, last_surfaced_at: 1, variants: 1 }],
      top_recalled: [],
    },
  };
  const text = renderStats(stats).map(stripAnsi).join('\n');
  expect(text).not.toContain('similar)');
});

test('renderStats — Recall section is omitted entirely when recall field absent', () => {
  // Spread-omit rather than `recall: undefined` to satisfy
  // exactOptionalPropertyTypes — optional ≠ explicit undefined.
  const { recall: _unused, ...noRecall } = SAMPLE as StatsResponse & {
    recall?: StatsResponse['recall'];
  };
  void _unused;
  const text = renderStats(noRecall as StatsResponse).map(stripAnsi).join('\n');
  expect(text).not.toContain('Recall');
});

test('renderStats — Dream section shows audit log + co-retrieval inputs', () => {
  const stats: StatsResponse = {
    ...SAMPLE,
    dream: {
      audit_log: {
        path: '/tmp/recall-audit.jsonl',
        bytes: 155_000,
        entries: 87,
        last_entry_epoch_ms: Date.now() - 90_000,   // 1.5 minutes ago
      },
      co_retrieval: { pairs: 142, docs_covered: 222 },
    },
  };
  const text = renderStats(stats).map(stripAnsi).join('\n');
  expect(text).toContain('Dream');
  expect(text).toContain('data feeding the Dreams pipeline');
  expect(text).toContain('Audit log');
  expect(text).toContain('87 entries');
  expect(text).toContain('Co-retrieval');
  expect(text).toContain('142');
  expect(text).toContain('222 observations covered');
  expect(text).toContain('captain-memo dream --dry-run');
});

test('renderStats — DREAM section shows OFF state when audit log absent', () => {
  const stats: StatsResponse = {
    ...SAMPLE,
    dream: {
      audit_log: { path: '/tmp/recall-audit.jsonl', bytes: 0, entries: 0, last_entry_epoch_ms: null },
      co_retrieval: { pairs: 0, docs_covered: 0 },
    },
  };
  const text = renderStats(stats).map(stripAnsi).join('\n');
  expect(text).toContain('Dream');
  expect(text).toContain('— off');
  expect(text).toContain('CAPTAIN_MEMO_RECALL_AUDIT=1');
});

test('renderStats — wide mode places Corpus and Efficiency side by side', () => {
  const lines = renderStats(SAMPLE, { panelWidth: 130 }).map(stripAnsi);
  const ruleLine = lines.find(l => l.includes('Corpus'));
  expect(ruleLine).toBeDefined();
  expect(ruleLine!).toContain('Efficiency');
});

test('renderStats — narrow mode keeps Corpus and Efficiency on their own lines', () => {
  const lines = renderStats(SAMPLE, { panelWidth: 60 }).map(stripAnsi);
  const corpusLine = lines.find(l => l.includes('Corpus'));
  const effLine = lines.find(l => l.includes('Efficiency'));
  expect(corpusLine).toBeDefined();
  expect(effLine).toBeDefined();
  expect(corpusLine).not.toContain('Efficiency');
  expect(effLine).not.toContain('Corpus');
});

test('renderStats — wide mode places Top surfaced and Top recalled side by side', () => {
  const stats: StatsResponse = {
    ...SAMPLE,
    recall: {
      surfaced_count: 5, recalled_count: 2,
      totals: { auto: 10, search: 3, drill: 2 },
      top_surfaced: [{ id: 1, type: 'feature', title: 'A',
        from_auto: 5, from_search: 0, from_drill: 0, last_surfaced_at: 1 }],
      top_recalled: [{ id: 2, type: 'bugfix', title: 'B',
        from_auto: 0, from_search: 1, from_drill: 2, last_surfaced_at: 1 }],
    },
  };
  const lines = renderStats(stats, { panelWidth: 130 }).map(stripAnsi);
  const headerLine = lines.find(l => l.includes('Top surfaced'));
  expect(headerLine).toBeDefined();
  expect(headerLine!).toContain('Top recalled');
});

test('renderStats — Dream section is omitted when dream field absent', () => {
  const { dream: _u, ...noDream } = SAMPLE as StatsResponse & { dream?: StatsResponse['dream'] };
  void _u;
  const text = renderStats(noDream as StatsResponse).map(stripAnsi).join('\n');
  expect(text).not.toContain('Dream');
});

const TIDE_ON: NonNullable<StatsResponse['tide']> = {
  enabled: true,
  relevance_floor: 0.30,
  strengthened: 1234,
  by_state: { active: 10591, dormant: 2, archived: 0 },
  anchored: 0,
  max_stability_days: 142.4,
};

test('renderStats — Tide section (on) shows status, floor, strengthened, tiers, max stability', () => {
  const stats: StatsResponse = { ...SAMPLE, tide: TIDE_ON };
  const text = renderStats(stats).map(stripAnsi).join('\n');
  expect(text).toContain('Tide');
  expect(text).toContain('memory lifecycle');
  expect(text).toContain('on');
  expect(text).toContain('floor 0.30');
  expect(text).toContain('tiering off');           // TIDE_ON omits tiering_enabled ⇒ off
  expect(text).toContain('Strengthened');
  expect(text).toContain('1 234');                 // grouped count
  expect(text).toContain('max stability');
  expect(text).toContain('142.4 d');
  expect(text).toContain('10 591');                // active tier
  expect(text).toContain('dormant');
  expect(text).toContain('archived');
});

test('renderStats — Tide section reflects tiering when enabled', () => {
  const stats: StatsResponse = { ...SAMPLE, tide: { ...TIDE_ON, tiering_enabled: true } };
  const text = renderStats(stats).map(stripAnsi).join('\n');
  expect(text).toContain('tiering on');
});

test('renderStats — Tide section (off) shows the enable hint, no floor', () => {
  const stats: StatsResponse = {
    ...SAMPLE,
    tide: { ...TIDE_ON, enabled: false, strengthened: 0, max_stability_days: null },
  };
  const text = renderStats(stats).map(stripAnsi).join('\n');
  expect(text).toContain('Tide');
  expect(text).toContain('off');
  expect(text).toContain('CAPTAIN_MEMO_TIDE_ENABLED=1');
  expect(text).not.toContain('max stability');     // null max → omitted
});

test('renderStats — Tide section is omitted when tide field absent', () => {
  const { tide: _u, ...noTide } = { ...SAMPLE, tide: TIDE_ON } as StatsResponse & { tide?: StatsResponse['tide'] };
  void _u;
  const text = renderStats(noTide as StatsResponse).map(stripAnsi).join('\n');
  expect(text).not.toContain('Tide');
});

test('renderStats — Recall title trim guards against 200-char observation titles', () => {
  const long = 'X'.repeat(120);
  const populated: StatsResponse = {
    ...SAMPLE,
    recall: {
      surfaced_count: 1,
      recalled_count: 0,
      totals: { auto: 1, search: 0, drill: 0 },
      top_surfaced: [{ id: 1, type: 'feature', title: long,
        from_auto: 1, from_search: 0, from_drill: 0, last_surfaced_at: 1 }],
      top_recalled: [],
    },
  };
  const text = renderStats(populated).map(stripAnsi).join('\n');
  // Trimmed to <= 48 chars (47 + '…'); no raw 100-char run survives.
  expect(text).not.toContain('X'.repeat(50));
  expect(text).toContain('…');
});
