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
import { clipFrame } from '../../src/cli/tui/frame.ts';

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
  for (const rows of [0, 1, 2, 3]) {
    expect(clipFrame(frameOf(60), rows).length).toBeLessThanOrEqual(Math.max(0, rows));
  }
});
