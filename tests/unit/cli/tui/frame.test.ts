import { test, expect } from 'bun:test';
import { buildFrame, type FrameData } from '../../../../src/cli/tui/frame.ts';
import { initialState, reduce, type TopState, type Event } from '../../../../src/cli/tui/state.ts';
import type { Key } from '../../../../src/cli/tui/keys.ts';
import type { StatsResponse } from '../../../../src/cli/stats-render.ts';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const ch = (value: string): Event => ({ type: 'key', key: { type: 'char', value } });
const k = (key: Key): Event => ({ type: 'key', key });
const run = (s: TopState, ...events: Event[]): TopState => events.reduce(reduce, s);

const STATS: StatsResponse = {
  total_chunks: 24551,
  by_channel: { memory: 279, observation: 24272 },
  observations: { total: 10593, queue_pending: 0, queue_processing: 0 },
  indexing: {
    status: 'ready', total: 279, done: 279, errors: 0,
    started_at_epoch: 0, finished_at_epoch: 0, last_error: null, elapsed_s: 0, percent: 100,
  },
  project_id: 'default',
  version: '0.1.16',
  embedder: { model: 'voyage-4-lite', endpoint: 'https://api.voyageai.com/v1/embeddings' },
  recall: {
    surfaced_count: 242, recalled_count: 3,
    totals: { auto: 900, search: 12, drill: 3 },
    top_surfaced: [], top_recalled: [],
    recent_surfaced: [
      { id: 9, type: 'discovery', title: 'team filter', last_surfaced_at: Math.floor(Date.now() / 1000) - 4, source: 'auto' },
    ],
  },
};

const nowS = Math.floor(Date.now() / 1000);
const ROWS = [
  { id: 1, type: 'discovery', title: 'first row here', from_auto: 5, from_search: 0, from_drill: 0, total: 5, last_surfaced_at: nowS - 4, last_surfaced_source: 'auto' as const, variants: 1 },
  { id: 2, type: 'feature', title: 'second row here', from_auto: 1, from_search: 2, from_drill: 0, total: 3, last_surfaced_at: nowS - 60, last_surfaced_source: 'search' as const, variants: 1 },
];

test('dashboard frame — renders the stats panel and a hint bar', () => {
  const lines = buildFrame(initialState(), { stats: STATS }, { cols: 100, rows: 40 }).map(stripAnsi);
  const text = lines.join('\n');
  expect(text).toContain('CAPTAIN MEMO');
  expect(text).toContain('[s]urfaced');   // hint bar affordance
  expect(text).toContain('[q]uit');
});

test('table frame — shows view, column headers, rows, and marks the selection', () => {
  const s = run(initialState(), ch('s'), { type: 'data', ids: [1, 2] }, { type: 'resize', pageSize: 10 });
  const data: FrameData = { stats: STATS, page: { rows: ROWS, total: 2 } };
  const lines = buildFrame(s, data, { cols: 100, rows: 30 }).map(stripAnsi);
  const text = lines.join('\n');
  expect(text).toContain('Surfaced');         // active view
  expect(text).toContain('TITLE');            // column header
  expect(text).toContain('first row here');
  expect(text).toContain('second row here');
  // selection marker sits on the first (selected) row
  const firstRowLine = lines.find(l => l.includes('first row here'))!;
  expect(firstRowLine).toContain('▸');
  const secondRowLine = lines.find(l => l.includes('second row here'))!;
  expect(secondRowLine).not.toContain('▸');
});

test('table frame — header and data rows are column-aligned (equal visible width)', () => {
  const s = run(initialState(), ch('s'), { type: 'data', ids: [1, 2] }, { type: 'resize', pageSize: 10 });
  const lines = buildFrame(s, { stats: STATS, page: { rows: ROWS, total: 2 } }, { cols: 100, rows: 30 }).map(stripAnsi);
  const header = lines.find(l => l.includes('TITLE') && l.includes('AUTO'))!;
  const dataRow = lines.find(l => l.includes('first row here'))!;
  expect(header.length).toBe(dataRow.length);   // columns line up to the same width
});

test('table frame — shows a live clock so the refresh is visible', () => {
  const s = run(initialState(), ch('s'), { type: 'data', ids: [1, 2] }, { type: 'resize', pageSize: 10 });
  const text = buildFrame(s, { stats: STATS, page: { rows: ROWS, total: 2 } }, { cols: 100, rows: 30 }).map(stripAnsi).join('\n');
  expect(text).toMatch(/\d{4}-\d\d-\d\d/);  // YYYY-MM-DD date
  expect(text).toMatch(/\d\d:\d\d:\d\d/);   // HH:MM:SS time
  expect(text).toContain('every');          // refresh-interval indicator
});

test('dashboard frame — also shows the live clock', () => {
  const text = buildFrame(initialState(), { stats: STATS }, { cols: 100, rows: 40 }).map(stripAnsi).join('\n');
  expect(text).toMatch(/\d\d:\d\d:\d\d/);
});

test('table frame — filter input is visible while active', () => {
  const s = run(initialState(), ch('s'), ch('/'), ch('c'), ch('a'), ch('l'));
  const lines = buildFrame(s, { stats: STATS, page: { rows: ROWS, total: 2 } }, { cols: 100, rows: 30 }).map(stripAnsi);
  expect(lines.join('\n')).toContain('cal');   // the typed filter buffer
});

test('help frame — lists shortcuts and explains the terms', () => {
  const s = run(initialState(), ch('?'));
  const text = buildFrame(s, {}, { cols: 100, rows: 40 }).map(stripAnsi).join('\n');
  expect(text).toContain('Surfaced');
  expect(text).toContain('Recalled');
  expect(text).toContain('Drill-in rate');
  expect(text).toContain('Tab');           // a shortcut
  expect(text).toContain('cycle');         // explanation text
  expect(text).toContain('drill');         // a term
  // stats glossary + the link to the full one
  expect(text).toContain('Compression');   // a dashboard term now explained
  expect(text).toContain('Tide');
  expect(text).toContain('captain-memo.ispcq.com/glossary');
});

test('detail frame — shows the full observation and a back hint', () => {
  const obs = {
    id: 1, type: 'discovery' as const, title: 'detailed observation',
    narrative: 'the full story of what happened', facts: ['fact one', 'fact two'],
    concepts: ['concept-x'], files_read: ['a.ts'], files_modified: ['b.ts'],
    from_auto: 3, from_search: 0, from_drill: 1,
    last_surfaced_at: nowS - 10, last_surfaced_source: 'drill' as const,
    created_at_epoch: nowS - 86400,
  };
  const s = run(initialState(), ch('s'), { type: 'data', ids: [1] }, k({ type: 'enter' }));
  const lines = buildFrame(s, { detail: obs }, { cols: 100, rows: 30 }).map(stripAnsi);
  const text = lines.join('\n');
  expect(text).toContain('detailed observation');
  expect(text).toContain('the full story of what happened');
  expect(text).toContain('fact one');
  expect(text).toContain('Esc');   // back affordance
});
