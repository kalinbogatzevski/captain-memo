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
  expect(text).toContain('captain-memo.ispcq.com/glossary.html');
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

// ── homework ─────────────────────────────────────────────────────────────────
import { orderHomework } from '../../../../src/cli/tui/frame.ts';
import type { HomeworkView } from '../../../../src/cli/stats-render.ts';

const nowMs = Date.now();
const HW: HomeworkView[] = [
  { id: '4', text: 'port the scroll fix\nsecond line of detail', topics: ['top'], project: 'captain-memo', by: 'sess-x', created_at: nowMs - 3_600_000 },
  { id: '7', text: 'cockpit board', topics: [], by: 'sess-y', created_at: nowMs - 7_200_000, claimed_by: 'sess-a', claimed_at: nowMs - 60_000 },
  { id: '2', text: 'old one', topics: [], by: 'sess-z', created_at: nowMs - 86_400_000, done_at: nowMs - 600_000, done_by: 'sess-z', note: 'shipped in 0.44.9' },
  { id: '3', text: 'older done', topics: [], by: 'sess-z', created_at: nowMs - 86_400_000, done_at: nowMs - 6_000_000, done_by: 'sess-z' },
];
const hwFrame = (s: TopState, homework: HomeworkView[] | null) =>
  buildFrame(s, { homework }, { cols: 100, rows: 40 }).map(stripAnsi);

test('orderHomework — open in filing order, then done, most recently closed first', () => {
  expect(orderHomework([HW[2]!, HW[0]!, HW[3]!, HW[1]!]).map((i) => i.id)).toEqual(['4', '7', '2', '3']);
});

test('homework frame — counts, rows with claim and done state, and the selected item in full', () => {
  const s = run(initialState(), ch('h'), { type: 'homework', rows: orderHomework(HW).map((i) => ({ id: i.id, open: !i.done_at })) });
  const lines = hwFrame(s, orderHomework(HW));
  const all = lines.join('\n');
  expect(all).toContain('2 open · 1 claimed · 2 done this week');
  expect(lines.find((l) => l.includes('#7'))).toContain('claimed by sess-a');
  expect(lines.find((l) => l.includes('#2 '))).toContain('✓ done');
  expect(lines.find((l) => l.startsWith(' ▸'))).toContain('#4');
  expect(all).toContain('#4 · captain-memo · filed by sess-x 1h ago');
  expect(all).toContain('second line of detail');
  expect(all).toContain('#top');
  expect(lines.at(-1)).toContain('[c]laim');
  expect(lines.every((l) => l.length <= 100)).toBe(true);
});

test('homework frame — a done item shows its close note; the prompt shows while typing a note', () => {
  const s = run(initialState(), ch('h'), { type: 'homework', rows: orderHomework(HW).map((i) => ({ id: i.id, open: !i.done_at })) });
  expect(hwFrame(run(s, ch('j'), ch('j')), orderHomework(HW)).join('\n')).toContain('note: shipped in 0.44.9');
  const typing = run(s, ch('d'), ch('o'), ch('k'));
  expect(hwFrame(typing, orderHomework(HW)).join('\n')).toContain('Close #4 with a note (optional). Enter closes it, Esc cancels: ok');
});

test('homework frame — control characters in item text never reach the terminal', () => {
  const evil: HomeworkView[] = [{ id: '9', text: 'hi\x1b[2Jthere', topics: ['x\x1b[31m'], by: 'b\x07', created_at: nowMs }];
  const s = run(initialState(), ch('h'), { type: 'homework', rows: [{ id: '9', open: true }] });
  const raw = buildFrame(s, { homework: evil }, { cols: 100, rows: 40 }).join('\n');
  expect(raw).not.toContain('\x1b[2J');
  expect(raw).not.toContain('\x07');
  expect(stripAnsi(raw)).toContain('hi [2Jthere');
});

test('homework frame — honest when the worker does not report homework, and when nothing is parked', () => {
  const s = run(initialState(), ch('h'));
  expect(hwFrame(s, null).join('\n')).toContain('does not report homework');
  expect(hwFrame(s, []).join('\n')).toContain('nothing parked');
});

test('dashboard frame — the Homework section lists the first open items; absent when not reported', () => {
  const withHw = buildFrame(initialState(), { stats: STATS, homework: orderHomework(HW).filter((i) => !i.done_at) }, { cols: 100, rows: 60 }).map(stripAnsi);
  const at = withHw.findIndex((l) => l.includes('Homework ─'));
  expect(at).toBeGreaterThan(0);
  expect(withHw[at + 1]).toContain('2 open · 1 claimed');
  expect(withHw[at + 2]).toContain('#4');
  expect(withHw[at + 3]).toContain('claimed by sess-a');
  expect(withHw.at(-1)).toContain('[h]omework');
  const without = buildFrame(initialState(), { stats: STATS }, { cols: 100, rows: 60 }).map(stripAnsi);
  expect(without.some((l) => l.includes('Homework ─'))).toBe(false);
});

test('dashboard hint bar — fits the terminal, dropping the rarest keys first; help and quit always stay', () => {
  const at = (cols: number) => stripAnsi(buildFrame(initialState(), { stats: STATS }, { cols, rows: 60 }).at(-1)!);
  expect(at(140)).toContain('[+/-]rate');
  const hundred = at(100);
  expect(hundred.length).toBeLessThanOrEqual(99);
  expect(hundred).toContain('[h]omework');
  expect(hundred).not.toContain('[+/-]rate');
  for (const cols of [60, 80, 100]) {
    expect(at(cols).length).toBeLessThanOrEqual(cols - 1);
    expect(at(cols)).toContain('[?]help');
    expect(at(cols)).toContain('[q]uit');
  }
});
