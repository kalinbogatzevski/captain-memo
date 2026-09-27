// tests/unit/top-frame-clip.test.ts — `top` must never draw more rows than the
// terminal has.
//
// Origin (2026-07-27): top.ts wrote every frame line from HOME with no slice to
// dims.rows. The alt-screen buffer scrolls gracefully, so a panel taller than the
// terminal silently pushed its own wordmark off the top and the user saw the BOTTOM
// of their dashboard, assuming that was the dashboard. It also meant any change to
// the panel's row count moved everything on screen — which is how a queue row that
// appears when work arrives read as "the entire screen shifts".
import { test, expect } from 'bun:test';
import { clipFrame, frameScrollRange } from '../../src/cli/tui/frame.ts';

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
