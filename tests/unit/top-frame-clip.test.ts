// tests/unit/top-frame-clip.test.ts — `top` must never draw more rows than the
// terminal has.
//
// Origin (2026-07-27): top.ts wrote every frame line from HOME with no slice to
// dims.rows. The alt-screen buffer scrolls gracefully, so a panel taller than the
// terminal silently pushed its own wordmark off the top and the user saw the BOTTOM
// of their dashboard, assuming that was the dashboard. It also meant any change to
// the panel's row count moved everything on screen — which is how a queue row that
// appears when work arrives read as "the entire screen shifts".
import { test, expect, setSystemTime } from 'bun:test';
import { buildFrame, clipFrame, frameBytes, frameScrollRange, screenBytes, type FrameData } from '../../src/cli/tui/frame.ts';
import { initialState, scrollsFrame, type Mode } from '../../src/cli/tui/state.ts';
import { renderStats, type StatsResponse } from '../../src/cli/stats-render.ts';
import { visibleWidth } from '../../src/shared/ansi.ts';
import {
  fullStats, fullHomework, FULL_PAGE_ROWS, FULL_DETAIL, FULL_SESSIONS, LONG_PROJECT, SHORT_PROJECT, type BudgetState,
} from '../support/top-full-stats.ts';

const frameOf = (n: number): string[] => [
  '  ⚓  CAPTAIN MEMO   corpus statistics · v0.27.20',
  '  ══════════════════',
  ...Array.from({ length: n - 3 }, (_, i) => `  body ${i}`),
  '  [s]urfaced  [q]uit',
];

test('a frame that already fits is returned untouched', () => {
  const frame = frameOf(20);
  expect(clipFrame(frame, 40)).toEqual(frame);
  expect(clipFrame(frame, 20)).toEqual(frame);
});

test('a frame taller than the terminal is clipped to exactly that many rows', () => {
  expect(clipFrame(frameOf(60), 24)).toHaveLength(24);
  expect(clipFrame(frameOf(60), 40)).toHaveLength(40);
});

test('the wordmark and the hint bar survive clipping', () => {
  const clipped = clipFrame(frameOf(60), 24);
  expect(clipped[0]).toContain('CAPTAIN MEMO');
  expect(clipped[clipped.length - 1]).toContain('[q]uit');
});

test('clipping drops from the bottom of the body, not the top', () => {
  const clipped = clipFrame(frameOf(60), 24);
  expect(clipped[2]).toBe('  body 0');
  expect(clipped.join('\n')).not.toContain('body 56');
});

test('a terminal too short for even the header degrades without throwing', () => {
  // Rather than emit head+tail and overflow anyway, take what fits from the top.
  for (const rows of [0, 1, 2, 3, 4]) {
    expect(clipFrame(frameOf(60), rows).length).toBeLessThanOrEqual(Math.max(0, rows));
    expect(clipFrame(frameOf(60), rows).join('\n')).not.toContain('j/k scroll');
    expect(frameScrollRange(60, rows)).toEqual({ max: 0, page: 1 });
  }
});

// Scrolling (2026-09-17, Windows report): only the observation table could scroll; the
// dashboard / sources / tokens / help panels were cut at the terminal height with no
// way to see the rest. clipFrame now takes a body offset and adds a position line above
// the pinned tail — only while the frame overflows, so a frame that fits is untouched.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('a frame that fits ignores the offset and gets no position line', () => {
  const frame = frameOf(20);
  expect(clipFrame(frame, 24, 5)).toEqual(frame);
  expect(clipFrame(frame, 24, 5).join('\n')).not.toContain('j/k scroll');
  expect(frameScrollRange(20, 24)).toEqual({ max: 0, page: 1 });
});

test('the position line sits above the pinned tail and says how much is below', () => {
  const clipped = clipFrame(frameOf(60), 24).map(stripAnsi);
  expect(clipped).toHaveLength(24);
  // 24 rows = 2 head + 20 body + position + tail; body 0..56 is 57 lines, so 37 are hidden.
  expect(frameScrollRange(60, 24)).toEqual({ max: 37, page: 20 });
  expect(clipped[21]).toBe('  body 19');
  expect(clipped[22]).toBe('  ▼ 37 more · j/k scroll');
  expect(clipped[23]).toContain('[q]uit');
});

test('an offset scrolls the body between the pinned head and tail, and ▲ shows when scrolled', () => {
  const clipped = clipFrame(frameOf(60), 24, 5).map(stripAnsi);
  expect(clipped).toHaveLength(24);
  expect(clipped[0]).toContain('CAPTAIN MEMO');
  expect(clipped[2]).toBe('  body 5');
  expect(clipped[21]).toBe('  body 24');
  expect(clipped[22]).toBe('  ▲ 5 · ▼ 32 more · j/k scroll');
  expect(clipped[23]).toContain('[q]uit');
});

test('the offset is clamped at the end: the last body line lands just above the position line', () => {
  const clipped = clipFrame(frameOf(60), 24, 999).map(stripAnsi);
  expect(clipped).toHaveLength(24);
  expect(clipped[21]).toBe('  body 56');
  expect(clipped[22]).toBe('  ▲ 37 · j/k scroll');   // nothing below → no ▼
  expect(clipFrame(frameOf(60), 24, -3)).toEqual(clipFrame(frameOf(60), 24, 0));
});

test('a panel that pages itself (offset null: table, detail) is clipped as before — no position line, no lost row', () => {
  const clipped = clipFrame(frameOf(60), 24, null).map(stripAnsi);
  expect(clipped).toHaveLength(24);
  expect(clipped[2]).toBe('  body 0');
  expect(clipped[22]).toBe('  body 20');   // the row the scrolling path gives to the position line
  expect(clipped[23]).toContain('[q]uit');
  expect(clipped.join('\n')).not.toContain('j/k scroll');
});

test('the pinned tail is whatever the shell put last (the worker-error line), not always the hint bar', () => {
  const frame = [...frameOf(60), '  (worker: timed out)'];
  const clipped = clipFrame(frame, 24, 3).map(stripAnsi);
  expect(clipped).toHaveLength(24);
  expect(clipped[22]).toContain('j/k scroll');
  expect(clipped[23]).toBe('  (worker: timed out)');
});

// The last row must not take a CRLF (2026-10-22, tester on Windows Terminal 156x46 and Linux):
// `top` wrote `line + \r\n` for every line, the last included. A CRLF on the bottom row
// scrolls the alt screen by one, and clipFrame returns EXACTLY `rows` lines for an overflowing
// frame, so the wordmark row went off the top and the `═` rule was the first thing on screen
// (`captain-memo stats` was fine). These tests feed the real write path's bytes to a tiny
// terminal model: CRLF at the bottom row scrolls, ESC[K / ESC[J erase from the cursor.
// With `cols` it also wraps like a real terminal (auto-margin): a character that does not fit in
// the remaining cells goes onto the next row, scrolling at the bottom; widths are the repo's
// visibleWidth (the anchor emoji is 2 cells). That is the second way a frame gains a row.
const paint = (bytes: string, rows: number, stale = '', cols = 0): string[] => {
  const screen: string[] = Array.from({ length: rows }, (_, i) => (stale ? `${stale} ${i}` : ''));
  let r = 0, c = 0;
  const lf = () => { if (r === rows - 1) { screen.shift(); screen.push(''); } else r++; };
  for (const m of bytes.matchAll(/\x1b\[([0-9;?]*)([A-Za-z])|\r|\n|[^\x1b\r\n]+/g)) {
    const [tok, , cmd] = m;
    if (cmd === 'H') { r = 0; c = 0; }
    else if (cmd === 'K') screen[r] = screen[r]!.slice(0, c);
    else if (cmd === 'J') { screen[r] = screen[r]!.slice(0, c); for (let i = r + 1; i < rows; i++) screen[i] = ''; }
    else if (cmd) { /* SGR and the like: no cursor movement */ }
    else if (tok === '\r') c = 0;
    else if (tok === '\n') lf();
    else if (cols) {   // rows are written once onto a blank screen, so appending is enough
      for (const ch of tok) {
        const w = visibleWidth(ch);
        if (c + w > cols) { c = 0; lf(); }
        screen[r] += ch; c += w;
      }
    }
    else { screen[r] = screen[r]!.slice(0, c) + tok + screen[r]!.slice(c + tok.length); c += tok.length; }
  }
  return screen.map(stripAnsi);
};
const lfCount = (s: string) => (s.match(/\n/g) ?? []).length;

test('a frame of exactly `rows` lines never scrolls: no CRLF after the bottom row, wordmark stays first', () => {
  for (const rows of [5, 24, 46]) {
    const bytes = frameBytes(clipFrame(frameOf(rows), rows, 0));
    expect(lfCount(bytes)).toBeLessThanOrEqual(rows - 1);
    const screen = paint(bytes, rows);
    expect(screen[0]).toContain('CAPTAIN MEMO');
    expect(screen[rows - 1]).toContain('[q]uit');
  }
});

test('an overflowing frame (rows + 10 lines, clipped) never scrolls either, and keeps its position line', () => {
  for (const rows of [24, 46]) {
    const bytes = frameBytes(clipFrame(frameOf(rows + 10), rows, 0));
    expect(lfCount(bytes)).toBeLessThanOrEqual(rows - 1);
    const screen = paint(bytes, rows);
    expect(screen[0]).toContain('CAPTAIN MEMO');
    expect(screen[rows - 2]).toMatch(/▼ \d+ more · j\/k scroll/);
    expect(screen[rows - 1]).toContain('[q]uit');
  }
});

test('a short frame starts with the wordmark and erases what the last frame left below and to the right', () => {
  const rows = 24;
  const screen = paint(frameBytes(frameOf(10)), rows, 'STALE FRAME TEXT THAT IS LONGER THAN ANY NEW LINE');
  expect(screen[0]).toContain('CAPTAIN MEMO');
  expect(screen[9]).toContain('[q]uit');
  expect(screen.join('\n')).not.toContain('STALE');
  expect(screen.slice(10).every((row) => row === '')).toBe(true);
  expect(frameBytes([])).toBe('\x1b[H\x1b[J');   // no lines: just wipe the screen
});

// Same pipeline as render() in commands/top.ts: buildFrame → clipFrame (dashboard scrolls, offset 0
// on entry) → frameBytes. The exact-fit height is DERIVED from the frame so a dashboard that grows
// or shrinks can't quietly turn the "exactly rows lines" case into a short-frame case that cannot fail.
const STATS: StatsResponse = {
  total_chunks: 24551,
  by_channel: { memory: 279, observation: 24272 },
  observations: { total: 10593, queue_pending: 0, queue_processing: 0 },
  indexing: { status: 'ready', total: 279, done: 279, errors: 0, started_at_epoch: 0, finished_at_epoch: 0, last_error: null, elapsed_s: 0, percent: 100 },
  project_id: 'default',
  version: '0.1.16',
  embedder: { model: 'voyage-4-lite', endpoint: 'https://api.voyageai.com/v1/embeddings' },
  recall: { surfaced_count: 242, recalled_count: 3, totals: { auto: 900, search: 12, drill: 3 }, top_surfaced: [], top_recalled: [], recent_surfaced: [] },
};
const writeDashboard = (data: FrameData, cols: number, rows: number, errLine?: string) => {
  const lines = buildFrame(initialState(), data, { cols, rows });
  if (errLine) lines.push(errLine);
  return { lines, screen: paint(frameBytes(clipFrame(lines, rows, 0)), rows) };
};

test('dashboard: the wordmark is the first row on screen when the frame is shorter than, exactly as tall as, and taller than the terminal', () => {
  for (const cols of [100, 156]) {
    const fit = buildFrame(initialState(), { stats: STATS }, { cols, rows: 46 }).length;
    for (const rows of [fit + 6, fit, fit - 6]) {
      const { lines, screen } = writeDashboard({ stats: STATS }, cols, rows);
      if (rows === fit) expect(lines).toHaveLength(rows);   // really the exact-fit case
      expect(screen[0]).toContain('CAPTAIN MEMO');
      expect(screen[Math.min(rows, lines.length) - 1]).toContain('[q]uit');
    }
  }
});

test('dashboard with the worker down: the banner stays the first row and the worker-error line the last, at exact fit', () => {
  const data: FrameData = { stats: STATS, workerUnreachable: true, lastOkAtMs: null };
  const err = '  (worker: timed out)';
  const fit = buildFrame(initialState(), data, { cols: 100, rows: 46 }).length + 1;
  const { lines, screen } = writeDashboard(data, 100, fit, err);
  expect(lines).toHaveLength(fit);
  expect(screen[0]).toContain('WORKER UNREACHABLE');
  expect(screen[fit - 1]).toBe(err);
});

// The title row must stay ONE row (2026-10-22, wave 12): headerPanel put the live stamp after the
// title with a filler that floors at one space, so below 82 columns the line outgrew the terminal
// and wrapped onto a second row; the frame was then a row too tall and the first row scrolled off
// (80x24 in tmux: the first visible row was "s", the tail of "every 2s"). The stamp now steps down:
// the full stamp, else the bare time, else nothing, always leaving a filler of one space and the
// last column free. The title itself is never cut. The fixture's title (v0.1.16) is 48 cells wide.
const CLOCK = new Date(2026, 9, 22, 10, 47, 27);   // local time, so the expected strings hold in any timezone
const atClock = <T>(fn: () => T): T => { setSystemTime(CLOCK); try { return fn(); } finally { setSystemTime(); } };
const titleOf = (cols: number) => renderStats(STATS, { panelWidth: cols })[0]!;   // no stamp: the title alone
const firstLine = (cols: number) => buildFrame(initialState(), { stats: STATS }, { cols, rows: 46 })[0]!;
const FULL_STAMP = '⟳ 2026-10-22 10:47:27 · every 2s';

test('dashboard title row: fits in cols-1 cells at every width from 40 to 160, title intact, never glued to the stamp', () => {
  const bad: string[] = [];
  atClock(() => {
    for (let cols = 40; cols <= 160; cols++) {
      const first = firstLine(cols), title = titleOf(cols);
      if (!stripAnsi(first).startsWith(stripAnsi(title))) bad.push(`${cols}: title cut`);
      else if (visibleWidth(title) > cols - 1) { if (first !== title) bad.push(`${cols}: title alone is too wide, stamp should go`); }
      else if (visibleWidth(first) > cols - 1) bad.push(`${cols}: ${visibleWidth(first)} cells`);
      else if (first !== title && !/\S {1,}⟳ /.test(stripAnsi(first))) bad.push(`${cols}: no filler before the stamp`);
    }
  });
  expect(bad).toEqual([]);
});

test('dashboard title row: the stamp steps down full -> time only -> none at exactly the widths it stops fitting', () => {
  const stampAt = (cols: number) => atClock(() => stripAnsi(firstLine(cols)).slice(stripAnsi(titleOf(cols)).length).trim());
  expect(stampAt(156)).toBe(FULL_STAMP);
  expect(stampAt(82)).toBe(FULL_STAMP);   // 48 title + 1 filler + 32 stamp = 81 = cols - 1
  expect(stampAt(81)).toBe('⟳ 10:47:27');
  expect(stampAt(60)).toBe('⟳ 10:47:27');   // 48 + 1 + 10 = 59 = cols - 1
  expect(stampAt(59)).toBe('');
  expect(stampAt(40)).toBe('');   // narrower than the title: only the stamp can go
});

test('dashboard title row, wide terminals: byte-identical to before the step-down (120 and 156 columns)', () => {
  const env = { FORCE_COLOR: process.env.FORCE_COLOR, NO_COLOR: process.env.NO_COLOR };
  process.env.FORCE_COLOR = '1'; delete process.env.NO_COLOR;   // pin the colour codes too
  try {
    const head = '  \x1b[33;1m⚓  CAPTAIN MEMO\x1b[0m   \x1b[2mcorpus statistics\x1b[0m \x1b[2m·\x1b[0m \x1b[1mv0.1.16\x1b[0m';
    const stamp = `\x1b[2m${FULL_STAMP}\x1b[0m`;
    atClock(() => {
      expect(firstLine(120)).toBe(head + ' '.repeat(39) + stamp);
      expect(firstLine(156)).toBe(head + ' '.repeat(75) + stamp);
      // `captain-memo stats` passes no stamp: the title line is just the title, at any width
      for (const cols of [40, 80, 120]) expect(titleOf(cols)).toBe(head);
    });
  } finally {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// Real pipeline bytes into the wrapping terminal model. The dashboard's Embedder row is 67 cells
// with this fixture, so below 68 columns the BODY wraps too (not this change's business: other
// lines are never truncated); the title-and-rule pair is therefore also checked on its own, which
// is what reaches 60.
test('the title row is the first row of an exact-fit screen: title and rule alone at 60..90, whole dashboard from 80', () => {
  atClock(() => {
    for (const cols of [60, 80, 81, 85, 89, 90]) {
      const pair = buildFrame(initialState(), { stats: STATS }, { cols, rows: 46 }).slice(0, 2);
      const screen = paint(frameBytes(pair), 2, '', cols);
      expect(screen[0]).toContain('CAPTAIN MEMO');
      expect(screen[1]).toContain('══');
    }
    for (const cols of [80, 81, 85, 89, 90]) {
      const fit = buildFrame(initialState(), { stats: STATS }, { cols, rows: 46 }).length;
      const lines = buildFrame(initialState(), { stats: STATS }, { cols, rows: fit });
      expect(lines).toHaveLength(fit);   // really the exact-fit case
      const screen = paint(frameBytes(clipFrame(lines, fit, 0)), fit, '', cols);
      expect(screen[0]).toContain('CAPTAIN MEMO');
      expect(screen[fit - 1]).toContain('[q]uit');
    }
  });
});

// No line of a frame may be wider than the terminal (2026-10-22, wave 12 part 8: 0.58.4 still lost its title row).
// At 146x37 against a real worker the dashboard's Efficiency column put the 94-cell "Embed budget" sentence in the right
// half of a two-column row; the line came out 170 cells wide, the terminal wrapped it onto a second row, the frame was a
// row too tall and the alt screen scrolled the title off. The test above had no embedder_usage in its fixture, so it never
// met the line. FULL (tests/support/top-full-stats.ts) carries every optional block the dashboard can draw, and the checks
// below call screenBytes, the one function render() writes through, at every width from 60 to 200.
const WIDTHS = Array.from({ length: 141 }, (_, i) => 60 + i);
const SIZES = [24, 37, 46];
const NOW = CLOCK.getTime();
const ERR_LINE = '  \x1b[2m(worker: ' + 'connect ECONNREFUSED 127.0.0.1:39888 '.repeat(5).trim() + ')\x1b[0m';
// Building a dashboard frame costs ~15 ms, so each (width, variant) is built once and shared by the tests below: every width
// gets two variants, every tenth width all six budget states, with the long and the short project name between them.
const MAIN: Array<[BudgetState, string]> = [['ok', LONG_PROJECT], ['tripped', SHORT_PROJECT]];
const REST: Array<[BudgetState, string]> = [['over', LONG_PROJECT], ['off', SHORT_PROJECT], ['off-local', LONG_PROJECT], ['none', SHORT_PROJECT]];
const variantsAt = (cols: number) => (cols % 10 === 0 ? [...MAIN, ...REST] : MAIN);
const withColor = <T>(fn: () => T): T => {
  const env = { FORCE_COLOR: process.env.FORCE_COLOR, NO_COLOR: process.env.NO_COLOR };
  process.env.FORCE_COLOR = '1'; delete process.env.NO_COLOR;   // the escapes are part of what is measured
  try { return fn(); } finally { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const frames = new Map<string, string[]>();
const dashLines = (cols: number, budget: BudgetState, project: string, down = false): string[] => {
  const key = `${cols}|${budget}|${project}|${down}`;
  let lines = frames.get(key);
  if (!lines) {
    const data: FrameData = {
      stats: fullStats({ budget, project, paused: budget === 'ok', nowMs: NOW }), homework: fullHomework(NOW),
      ...(down ? { workerUnreachable: true, lastOkAtMs: NOW } : {}),
    };
    lines = withColor(() => atClock(() => buildFrame(initialState(), data, { cols, rows: 46 })));
    frames.set(key, lines);
  }
  return lines;
};
/** The lines screenBytes wrote, as the terminal received them: HOME, rows each ending in erase-to-end-of-line, CRLF between, erase-below. */
const writtenLines = (bytes: string): string[] =>
  bytes.slice('\x1b[H'.length, -'\x1b[J'.length).split('\r\n').map((l) => l.slice(0, -'\x1b[K'.length));

test('dashboard: no written line is wider than the terminal, at every width 60..200 and every budget state, long and short project name', () => {
  const bad: string[] = [];
  for (const cols of WIDTHS) for (const [budget, project] of variantsAt(cols)) {
    const lines = dashLines(cols, budget, project);
    for (const rows of SIZES) {
      const wide = writtenLines(screenBytes(lines, { cols, rows }, 0)).filter((l) => visibleWidth(l) > cols);
      if (wide.length) bad.push(`${cols}x${rows} ${budget} ${project}: ${wide.length} wide, first ${visibleWidth(wide[0]!)} cells`);
    }
  }
  expect(bad).toEqual([]);
}, 120_000);

test('dashboard: the title is the first row of the screen at every width 60..200 and height, for clipped, exact-fit and short frames', () => {
  const bad: string[] = [];
  for (const cols of WIDTHS) for (const [budget, project] of variantsAt(cols)) {
    const lines = dashLines(cols, budget, project);
    const heights = [...SIZES.map((rows) => ['clipped', rows] as const), ['exact', lines.length] as const, ['short', lines.length + 6] as const];
    for (const [kind, rows] of heights) {
      if (kind === 'clipped' && lines.length <= rows) { bad.push(`${cols}x${rows}: frame of ${lines.length} is not taller than the terminal`); continue; }
      const screen = paint(screenBytes(lines, { cols, rows }, 0), rows, '', cols);
      if (!screen[0]!.includes('CAPTAIN MEMO')) bad.push(`${cols}x${rows} ${kind} ${budget}: first row is ${JSON.stringify(screen[0]!.slice(0, 40))}`);
      else if (!screen[Math.min(rows, lines.length) - 1]!.includes('[q]uit')) bad.push(`${cols}x${rows} ${kind} ${budget}: last row is not the hint bar`);
      else if (kind === 'clipped' && !/▼ \d+ more/.test(screen[rows - 2]!)) bad.push(`${cols}x${rows} ${budget}: no position line`);
    }
  }
  expect(bad).toEqual([]);
}, 120_000);

test('dashboard with the worker down: the banner is the first row and the (long) worker-error line the last, cut to the terminal, at every width', () => {
  const bad: string[] = [];
  for (const cols of WIDTHS) {
    const lines = [...dashLines(cols, 'ok', LONG_PROJECT, true), ERR_LINE];
    for (const rows of [24, lines.length]) {
      const bytes = screenBytes(lines, { cols, rows }, 0);
      if (writtenLines(bytes).some((l) => visibleWidth(l) > cols)) bad.push(`${cols}x${rows}: a line is wider than the terminal`);
      const screen = paint(bytes, rows, '', cols);
      if (!screen[0]!.includes('WORKER UNREACHABLE')) bad.push(`${cols}x${rows}: first row is ${JSON.stringify(screen[0]!.slice(0, 40))}`);
      if (!screen[rows - 1]!.startsWith('  (worker: ')) bad.push(`${cols}x${rows}: last row is ${JSON.stringify(screen[rows - 1]!.slice(0, 40))}`);
    }
  }
  expect(bad).toEqual([]);
}, 120_000);

test('every other panel (sources, tokens, homework, table, detail, help) fits the terminal too, and its first row stays first', () => {
  const bad: string[] = [];
  const data: FrameData = {
    stats: fullStats({ nowMs: NOW }), homework: fullHomework(NOW), sessions: FULL_SESSIONS(NOW),
    page: { rows: FULL_PAGE_ROWS(Math.floor(NOW / 1000)), total: 30 }, detail: FULL_DETAIL(Math.floor(NOW / 1000)),
  };
  const modes: Mode[] = ['sources', 'tokens', 'homework', 'table', 'detail', 'help'];
  withColor(() => atClock(() => {
    for (const mode of modes) for (const cols of WIDTHS) {
      const base = initialState();
      const state = { ...base, mode, pageSize: 30, hw: { ...base.hw, sel: 3 } };
      const lines = buildFrame(state, data, { cols, rows: 46 });
      for (const rows of [24, lines.length]) {
        const bytes = screenBytes(lines, { cols, rows }, scrollsFrame(mode) ? 0 : null);
        const written = writtenLines(bytes);
        if (written.some((l) => visibleWidth(l) > cols)) { bad.push(`${mode} ${cols}x${rows}: a line is wider than the terminal`); continue; }
        if (paint(bytes, rows, '', cols)[0] !== stripAnsi(written[0]!)) bad.push(`${mode} ${cols}x${rows}: the first row scrolled off`);
      }
    }
  }));
  expect(bad).toEqual([]);
}, 120_000);

test('a line that fits is left alone; one that does not is cut one column short of the edge and ends in an ellipsis', () => {
  const cols = 40;
  const line = (n: number) => `  \x1b[36;1m${'x'.repeat(n - 2)}\x1b[0m`;
  const lines = [line(cols - 1), line(cols), line(cols + 1), line(cols + 60)];
  const out = writtenLines(screenBytes(lines, { cols, rows: 10 }, 0));
  expect(out.slice(0, 2)).toEqual(lines.slice(0, 2));
  expect(out.slice(2).map(visibleWidth)).toEqual([cols - 1, cols - 1]);
  for (const l of out.slice(2)) expect(l).toBe(`  \x1b[36;1m${'x'.repeat(cols - 4)}…\x1b[0m`);
});

// The Efficiency column's "Embed budget" sentence is 94 cells, which only a 196+ column terminal has room for in the right
// half of a two-column row. It now steps down to the first wording that fits its column (screenBytes would cut it otherwise,
// which loses the end of the sentence, the state). Checked on renderStats itself, i.e. without the clip underneath, over just
// the blocks that carry the row.
const budgetRows = (panelWidth: number, budget: BudgetState): string => {
  const { efficiency, embedder_usage } = fullStats({ budget, nowMs: NOW });
  const stats: StatsResponse = { ...STATS, efficiency, ...(embedder_usage ? { embedder_usage } : {}) };
  const text = renderStats(stats, { panelWidth }).filter((l) => stripAnsi(l).includes('Embed budget')).map(stripAnsi);
  return text.map((t) => `${visibleWidth(t)}|${t.slice(t.indexOf('Embed budget')).trim().replace(/\s+/g, ' ')}`).join('\n');
};

test('the Embed budget row fits its column at every panel width from 60 to 240, in every state', () => {
  const bad: string[] = [];
  atClock(() => {
    for (let panelWidth = 60; panelWidth <= 240; panelWidth++) for (const budget of ['ok', 'tripped', 'over', 'off', 'off-local'] as const) {
      const row = budgetRows(panelWidth, budget);
      if (!row) bad.push(`${panelWidth} ${budget}: no Embed budget row`);
      else if (Number(row.split('|')[0]) > panelWidth) bad.push(`${panelWidth} ${budget}: ${row.split('|')[0]} cells`);
    }
    expect(budgetRows(240, 'none')).toBe('');   // a worker older than the budget draws no row
  });
  expect(bad).toEqual([]);
}, 120_000);

test('the Embed budget wording steps down with the room, keeps its state meaningful, and the wide wording is unchanged', () => {
  const at = (panelWidth: number, budget: BudgetState) => atClock(() => budgetRows(panelWidth, budget).split('|')[1]);
  expect(at(200, 'ok')).toBe('Embed budget 12.3 k tok searches + recalls, last hour · limit 500.0 k per engine, not tripped');
  expect(at(146, 'ok')).toBe('Embed budget 12.3 k tok/h · limit 500.0 k per engine');
  expect(at(100, 'ok')).toBe('Embed budget 12.3 k · limit 500.0 k');
  expect(at(146, 'tripped')).toMatch(/^Embed budget 640\.0 k tok\/h · TRIPPED until \d\d:\d\d: keyword-only$/);
  expect(at(100, 'tripped')).toMatch(/^Embed budget 640\.0 k · TRIPPED until \d\d:\d\d$/);
  expect(at(146, 'over')).toBe('Embed budget 640.0 k tok/h · OVER THE LIMIT: next search refused');
  expect(at(100, 'over')).toBe('Embed budget 640.0 k · OVER THE LIMIT');
  expect(at(146, 'off-local')).toBe('Embed budget 12.3 k tok/h · budget off: local endpoint');
  expect(at(100, 'off-local')).toBe('Embed budget 12.3 k · off: local endpoint');
  expect(at(146, 'off')).toBe('Embed budget 12.3 k tok searches + recalls, last hour · budget off');
});

test('wide terminals are byte-identical to 0.58.4: the four Efficiency rows at 200 columns, colours included', () => {
  const rows = withColor(() => atClock(() => renderStats(fullStats({ budget: 'ok', nowMs: NOW }), { panelWidth: 200 })));
  const cells = [
    '\x1b[2mEmbedder      \x1b[0m\x1b[36;1m12345\x1b[0m calls \x1b[2m·\x1b[0m ~85 ms \x1b[2m·\x1b[0m 123 456 tok/s \x1b[2msince worker start\x1b[0m',
    '\x1b[2mEmbed tokens  \x1b[0m\x1b[36;1m98.8 M\x1b[0m tok sent \x1b[2m·\x1b[0m \x1b[33m1.2 M in unfinished requests\x1b[0m \x1b[2msince worker start\x1b[0m',
    '\x1b[2mEmbed budget  \x1b[0m\x1b[36;1m12.3 k\x1b[0m tok \x1b[2msearches + recalls, last hour ·\x1b[0m \x1b[2mlimit 500.0 k per engine, not tripped\x1b[0m',
    '\x1b[2mDedup         \x1b[0m\x1b[36;1m97%\x1b[0m   \x1b[2m1 200 000 / 1 234 567 unchanged since worker start\x1b[0m',
  ];
  for (const cell of cells) expect(rows.filter((l) => l.endsWith(cell))).toHaveLength(1);
});
