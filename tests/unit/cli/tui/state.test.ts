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
  expect(s.view).toBe('themes');    // the Captain's own writing, last in the cycle
  s = run(s, k({ type: 'tab' }));
  expect(s.view).toBe('surfaced');  // wraps
});

// Lowercase t has cycled the TYPE FILTER since before themes existed; the themes view takes
// uppercase T so an existing habit keeps working.
test('table — T opens themes, lowercase t still cycles the type filter', () => {
  let s = run(initialState(), ch('s'), { type: 'data', ids: [1, 2, 3] });
  const afterLower = run(s, ch('t'));
  expect(afterLower.view).toBe('surfaced');       // unchanged
  expect(afterLower.typeFilter).not.toBeUndefined();
  const afterUpper = run(s, ch('T'));
  expect(afterUpper.view).toBe('themes');
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

// Frame scroll (2026-09-17, Windows report): the panels without row navigation of their
// own were cut at the terminal height with no way to see the rest. The shell measures
// the clipped frame after each render ('frame' event); the keys move within that range.
const tall: Event = { type: 'frame', max: 10, page: 4 };

test('frame scroll — j/k ↑/↓ PgUp/PgDn Home/End move the offset within [0, max] on the dashboard', () => {
  let s = run(initialState(), tall);
  s = run(s, ch('j'), ch('j'), k({ type: 'down' }));
  expect(s.frame.scroll).toBe(3);
  s = run(s, k({ type: 'pagedown' }));
  expect(s.frame.scroll).toBe(7);
  s = run(s, k({ type: 'pagedown' }));
  expect(s.frame.scroll).toBe(10);                          // clamped at max
  s = run(s, ch('k'), k({ type: 'up' }));
  expect(s.frame.scroll).toBe(8);
  s = run(s, k({ type: 'pageup' }), k({ type: 'pageup' }), k({ type: 'pageup' }));
  expect(s.frame.scroll).toBe(0);                           // clamped at 0
  expect(run(s, k({ type: 'end' })).frame.scroll).toBe(10);
  expect(run(s, k({ type: 'end' }), k({ type: 'home' })).frame.scroll).toBe(0);
  expect(s.mode).toBe('dashboard');                         // scrolling never leaves the panel
});

test('frame scroll — the same keys scroll the sources, tokens and help panels', () => {
  for (const open of [ch('a'), ch('m'), ch('?')]) {
    const s = run(initialState(), open, tall, ch('j'), k({ type: 'down' }));
    expect(s.frame.scroll).toBe(2);
  }
});

test('frame scroll — the table and the detail view keep their own scroll; the frame offset stays 0', () => {
  const t = run(initialState(), ch('s'), { type: 'data', ids: [1, 2, 3] }, tall, ch('j'), k({ type: 'down' }));
  expect(t.selection).toBe(2);
  expect(t.frame.scroll).toBe(0);
  const d = run(t, k({ type: 'enter' }), tall, ch('j'), k({ type: 'down' }));
  expect(d.mode).toBe('detail');
  expect(d.detailScroll).toBe(2);
  expect(d.frame.scroll).toBe(0);
});

test('frame scroll — the offset resets on every mode change', () => {
  const s = run(initialState(), tall, ch('j'), ch('j'), ch('j'));
  expect(s.frame.scroll).toBe(3);
  expect(run(s, ch('a')).frame.scroll).toBe(0);                          // → sources
  expect(run(s, ch('s')).frame.scroll).toBe(0);                          // → table
  expect(run(s, ch('?')).frame.scroll).toBe(0);                          // → help
  const help = run(s, ch('?'), tall, ch('j'), ch('j'));
  expect(help.frame.scroll).toBe(2);
  expect(run(help, k({ type: 'escape' })).frame.scroll).toBe(0);         // help → back
  expect(run(s, ch('+')).frame.scroll).toBe(3);                          // same panel: kept
});

test("frame scroll — a refresh clamps the offset to the new frame and never jumps a view that still fits", () => {
  let s = run(initialState(), tall, k({ type: 'end' }));
  expect(s.frame.scroll).toBe(10);
  s = run(s, { type: 'frame', max: 12, page: 4 });   // a queue row appeared: view stays put
  expect(s.frame.scroll).toBe(10);
  s = run(s, { type: 'frame', max: 6, page: 4 });    // terminal grew: pulled back into range
  expect(s.frame.scroll).toBe(6);
  s = run(s, { type: 'frame', max: 0, page: 1 });    // frame fits now
  expect(s.frame.scroll).toBe(0);
  expect(run(s, ch('j')).frame.scroll).toBe(0);      // nothing to scroll
});

// ── homework panel ([h]) ─────────────────────────────────────────────────────
const HW_ROWS: Event = { type: 'homework', rows: [
  { id: '4', open: true },
  { id: '7', open: true, claimed_by: 'sess-a' },
  { id: '2', open: false },
] };
const hwState = (...events: Event[]) => run({ ...initialState(), hwBy: 'kalin (top)' }, ch('h'), HW_ROWS, ...events);

test('homework — h opens the panel from the dashboard, table, sources and tokens; h and Esc go back', () => {
  expect(run(initialState(), ch('h')).mode).toBe('homework');
  for (const from of [ch('s'), ch('a'), ch('m')]) expect(run(initialState(), from, ch('h')).mode).toBe('homework');
  expect(run(initialState(), ch('h'), ch('h')).mode).toBe('dashboard');
  expect(run(initialState(), ch('h'), k({ type: 'escape' })).mode).toBe('dashboard');
});

test('homework — j/k and arrows move the selection, clamped to the rows', () => {
  expect(hwState(ch('j'), ch('j'), ch('j'), ch('j')).hw.sel).toBe(2);
  expect(hwState(ch('j'), k({ type: 'up' }), k({ type: 'up' })).hw.sel).toBe(0);
  expect(hwState(ch('G')).hw.sel).toBe(2);
  // A refresh that shrinks the list pulls the selection back inside it.
  expect(run(hwState(ch('G')), { type: 'homework', rows: [{ id: '4', open: true }] }).hw.sel).toBe(0);
  // The panel pages its own list: the frame scroll stays at 0.
  expect(hwState(ch('j')).frame.scroll).toBe(0);
});

test('homework — c claims an open unclaimed item at once', () => {
  expect(hwState(ch('c')).hwRequest).toEqual({ op: 'claim', id: '4' });
});

test('homework — c on someone else\'s claim asks first; the second c takes it over; any other key disarms', () => {
  const armed = hwState(ch('j'), ch('c'));
  expect(armed.hwRequest).toBeNull();
  expect(armed.notice).toContain('claimed by sess-a');
  expect(run(armed, ch('c')).hwRequest).toEqual({ op: 'claim', id: '7' });
  expect(run(armed, ch('k'), ch('j'), ch('c')).hwRequest).toBeNull();     // moved away: armed again, not claimed
});

test('homework — re-claiming your own item needs no confirmation', () => {
  const s = run(hwState(), { type: 'homework', rows: [{ id: '4', open: true, claimed_by: 'kalin (top)' }] }, ch('c'));
  expect(s.hwRequest).toEqual({ op: 'claim', id: '4' });
});

test('homework — d opens the note prompt; Enter closes with the note, Esc cancels', () => {
  const p = hwState(ch('d'));
  expect(p.hw.note).toEqual({ active: true, buffer: '', id: '4' });
  const typed = run(p, ch('s'), ch('h'), ch('i'), ch('p'), k({ type: 'backspace' }), ch('p'));
  expect(typed.mode).toBe('homework');                                   // letters are text, not panel keys
  expect(run(typed, k({ type: 'enter' })).hwRequest).toEqual({ op: 'done', id: '4', note: 'ship' });
  expect(run(p, k({ type: 'enter' })).hwRequest).toEqual({ op: 'done', id: '4' });   // an empty note is no note
  const cancelled = run(typed, k({ type: 'escape' }));
  expect(cancelled.hwRequest).toBeNull();
  expect(cancelled.hw.note.active).toBe(false);
  expect(cancelled.mode).toBe('homework');
});

test('homework — a done item cannot be claimed or closed again', () => {
  const s = hwState(ch('G'), ch('c'));
  expect(s.hwRequest).toBeNull();
  expect(s.notice).toContain('already done');
  expect(run(hwState(ch('G')), ch('d')).hw.note.active).toBe(false);
});

test('homework — acted clears the request and shows the outcome; the next key clears the notice', () => {
  const s = run(hwState(ch('c')), { type: 'acted', notice: 'Claimed #4.' });
  expect(s.hwRequest).toBeNull();
  expect(s.notice).toBe('Claimed #4.');
  expect(run(s, ch('j')).notice).toBeNull();
});
