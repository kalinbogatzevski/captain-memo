import { test, expect } from 'bun:test';
import { initialState, reduce, type TopState, type Event } from '../../../../src/cli/tui/state.ts';
import type { Key } from '../../../../src/cli/tui/keys.ts';

const k = (key: Key): Event => ({ type: 'key', key });
const ch = (value: string): Event => ({ type: 'key', key: { type: 'char', value } });
const run = (s: TopState, ...events: Event[]): TopState => events.reduce(reduce, s);

test('initialState — dashboard defaults', () => {
  const s = initialState();
  expect(s.mode).toBe('dashboard');
  expect(s.refreshMs).toBe(2000);
  expect(s.view).toBe('surfaced');
  expect(s.sort).toBe('total');
  expect(s.collapse).toBe(false);
  expect(s.selection).toBe(0);
  expect(s.quit).toBe(false);
});

test('dashboard — s/r/n open the table on the chosen view with its natural sort', () => {
  expect(run(initialState(), ch('s')).mode).toBe('table');
  expect(run(initialState(), ch('s')).view).toBe('surfaced');
  expect(run(initialState(), ch('s')).sort).toBe('total');
  expect(run(initialState(), ch('r')).view).toBe('recalled');
  expect(run(initialState(), ch('r')).sort).toBe('drill');
  expect(run(initialState(), ch('n')).view).toBe('recent');
  expect(run(initialState(), ch('n')).sort).toBe('recency');   // Recent ⇒ recency, not total
});

test('dashboard — +/- adjust refresh interval within bounds', () => {
  const faster = run(initialState(), ch('-'));
  expect(faster.refreshMs).toBeLessThan(2000);
  let s = initialState();
  for (let i = 0; i < 50; i++) s = run(s, ch('-'));
  expect(s.refreshMs).toBeGreaterThanOrEqual(500);  // clamped floor
});

test('dashboard — q and Ctrl+C quit', () => {
  expect(run(initialState(), ch('q')).quit).toBe(true);
  expect(run(initialState(), k({ type: 'ctrl-c' })).quit).toBe(true);
});

test('table — down/up move selection, clamped to row count', () => {
  let s = run(initialState(), ch('s'), { type: 'data', ids: [10, 20, 30] });
  s = run(s, k({ type: 'down' }));
  expect(s.selection).toBe(1);
  s = run(s, k({ type: 'down' }), k({ type: 'down' }));  // would be 3, clamps at 2
  expect(s.selection).toBe(2);
  s = run(s, k({ type: 'up' }), k({ type: 'up' }), k({ type: 'up' })); // clamps at 0
  expect(s.selection).toBe(0);
});

test('table — g/G jump to top/bottom', () => {
  let s = run(initialState(), ch('s'), { type: 'data', ids: [1, 2, 3, 4, 5] });
  s = run(s, ch('G'));
  expect(s.selection).toBe(4);
  s = run(s, ch('g'));
  expect(s.selection).toBe(0);
});

test('table — scroll follows selection within the page window', () => {
  let s = run(initialState(), ch('s'),
    { type: 'resize', pageSize: 3 },
    { type: 'data', ids: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
  for (let i = 0; i < 4; i++) s = run(s, k({ type: 'down' }));  // selection → 4
  expect(s.selection).toBe(4);
  expect(s.scroll).toBe(2);   // window [2,3,4]
});

test('table — Tab cycles the view and resets selection', () => {
  let s = run(initialState(), ch('s'), { type: 'data', ids: [1, 2, 3] }, k({ type: 'down' }));
  expect(s.selection).toBe(1);
  s = run(s, k({ type: 'tab' }));
  expect(s.view).toBe('recalled');
  expect(s.selection).toBe(0);
  s = run(s, k({ type: 'tab' }));
  expect(s.view).toBe('recent');
  s = run(s, k({ type: 'tab' }));
  expect(s.view).toBe('surfaced');  // wraps
});

test('table — s/r/n switch the view in place (consistent with the dashboard)', () => {
  const s = run(initialState(), ch('s'));   // in table, Surfaced
  expect(run(s, ch('n')).view).toBe('recent');
  expect(run(s, ch('r')).view).toBe('recalled');
  expect(run(s, ch('n')).sort).toBe('recency');   // adopts the view's natural sort
});

test('table — o cycles the sort column', () => {
  let s = run(initialState(), ch('s'));
  expect(s.sort).toBe('total');
  s = run(s, ch('o')); expect(s.sort).toBe('auto');
  s = run(s, ch('o')); expect(s.sort).toBe('search');
  s = run(s, ch('o')); expect(s.sort).toBe('drill');
  s = run(s, ch('o')); expect(s.sort).toBe('recency');
  s = run(s, ch('o')); expect(s.sort).toBe('total');  // wraps
});

test('table — c toggles collapse', () => {
  let s = run(initialState(), ch('s'));
  expect(s.collapse).toBe(false);
  s = run(s, ch('c'));
  expect(s.collapse).toBe(true);
});

test('table — t cycles the type filter starting from all (null)', () => {
  let s = run(initialState(), ch('s'));
  expect(s.typeFilter).toBeNull();
  s = run(s, ch('t'));
  expect(s.typeFilter).toBe('bugfix');
});

test('table — / opens filter input; typing edits; enter applies query', () => {
  let s = run(initialState(), ch('s'), k({ type: 'char', value: '/' }));
  expect(s.filter.active).toBe(true);
  s = run(s, ch('c'), ch('a'), ch('l'));   // chars go to the buffer, not commands
  expect(s.filter.buffer).toBe('cal');
  s = run(s, k({ type: 'backspace' }));
  expect(s.filter.buffer).toBe('ca');
  s = run(s, k({ type: 'enter' }));
  expect(s.filter.active).toBe(false);
  expect(s.query).toBe('ca');
});

test('table — Escape cancels an active filter without applying it', () => {
  let s = run(initialState(), ch('s'), ch('/'), ch('x'));
  s = run(s, k({ type: 'escape' }));
  expect(s.filter.active).toBe(false);
  expect(s.query).toBe('');   // not applied
});

test('table — Escape (no filter) returns to the dashboard', () => {
  let s = run(initialState(), ch('s'));
  s = run(s, k({ type: 'escape' }));
  expect(s.mode).toBe('dashboard');
});

test('table — Enter drills into the selected row by id', () => {
  let s = run(initialState(), ch('s'), { type: 'data', ids: [10, 20, 30] }, k({ type: 'down' }));
  s = run(s, k({ type: 'enter' }));
  expect(s.mode).toBe('detail');
  expect(s.detailId).toBe(20);
});

test('help — ? opens help from dashboard or table; Esc returns to where you were', () => {
  let s = run(initialState(), ch('?'));
  expect(s.mode).toBe('help');
  expect(run(s, k({ type: 'escape' })).mode).toBe('dashboard');

  let t = run(initialState(), ch('s'), ch('?'));
  expect(t.mode).toBe('help');
  expect(run(t, k({ type: 'escape' })).mode).toBe('table');
});

test('help — ? toggles closed, q quits', () => {
  const s = run(initialState(), ch('?'));
  expect(run(s, ch('?')).mode).toBe('dashboard');
  expect(run(s, ch('q')).quit).toBe(true);
});

test('detail — Escape returns to the table, q quits', () => {
  let s = run(initialState(), ch('s'), { type: 'data', ids: [10] }, k({ type: 'enter' }));
  expect(s.mode).toBe('detail');
  const back = run(s, k({ type: 'escape' }));
  expect(back.mode).toBe('table');
  expect(run(s, ch('q')).quit).toBe(true);
});

test("AI-sources tab — 'a' opens it; a/Esc close it; s/r/n jump to the table", () => {
  expect(run(initialState(), ch('a')).mode).toBe('sources');
  const s = run(initialState(), ch('a'));
  expect(run(s, ch('a')).mode).toBe('dashboard');
  expect(run(s, k({ type: 'escape' })).mode).toBe('dashboard');
  expect(run(initialState(), ch('s'), ch('a')).mode).toBe('sources'); // from a table view too
  expect(run(s, ch('s')).mode).toBe('table');
});
