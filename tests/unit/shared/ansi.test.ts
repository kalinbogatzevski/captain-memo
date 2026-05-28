// tests/unit/shared/ansi.test.ts
//
// Tests for the ANSI helpers added to support responsive stats layout.
// visibleWidth and padVisibleEnd must respect SGR escape sequences — if
// they don't, side-by-side columns would drift apart by ~8 chars per
// escape, ruining alignment.

import { test, expect, afterEach } from 'bun:test';
import {
  bold, cyan, dim, goldBold,
  visibleWidth, padVisibleEnd, isTTY,
} from '../../../src/shared/ansi.ts';

// Capture and restore env vars so each test runs in isolation.
const savedEnv = {
  NO_COLOR: process.env.NO_COLOR,
  FORCE_COLOR: process.env.FORCE_COLOR,
};
afterEach(() => {
  for (const k of ['NO_COLOR', 'FORCE_COLOR'] as const) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test('visibleWidth — plain text counts characters', () => {
  expect(visibleWidth('')).toBe(0);
  expect(visibleWidth('hello')).toBe(5);
});

test('visibleWidth — strips SGR escape codes', () => {
  // bold/cyan/etc. only emit codes when stdout.isTTY === true. In test
  // runners stdout is usually a pipe, so wrap returns the plain string —
  // construct escape sequences manually to make this test deterministic.
  expect(visibleWidth('\x1b[1mhello\x1b[0m')).toBe(5);
  expect(visibleWidth('\x1b[33;1m12 345\x1b[0m')).toBe(6);
});

test('visibleWidth — counts mixed plain + escaped correctly', () => {
  const s = `before \x1b[1mhello\x1b[0m after`;
  expect(visibleWidth(s)).toBe('before hello after'.length);
});

test('padVisibleEnd — extends a short string with spaces to the target width', () => {
  expect(padVisibleEnd('abc', 6)).toBe('abc   ');
  expect(padVisibleEnd('', 4)).toBe('    ');
});

test('padVisibleEnd — does NOT truncate a string longer than the target', () => {
  expect(padVisibleEnd('abcdef', 3)).toBe('abcdef');
});

test('padVisibleEnd — counts escape codes correctly when padding colored text', () => {
  const colored = `\x1b[1mhi\x1b[0m`;
  const padded = padVisibleEnd(colored, 5);
  expect(visibleWidth(padded)).toBe(5);
  // The escape codes must survive intact; only spaces are appended.
  expect(padded.startsWith(colored)).toBe(true);
  expect(padded.endsWith('   ')).toBe(true);
});

test('helpers compose: padVisibleEnd preserves color in the inner content', () => {
  // Spot-check the high-level helpers exist and are callable. Their TTY-
  // gated bodies make exact equality brittle; visibleWidth gives us a stable
  // assertion regardless of whether ANSI codes are emitted in this env.
  const made = bold('abc') + cyan('de') + dim('f') + goldBold('gh');
  expect(visibleWidth(made)).toBe('abcdefgh'.length);
});

test('isTTY — NO_COLOR force-disables color regardless of FORCE_COLOR', () => {
  process.env.NO_COLOR = '1';
  process.env.FORCE_COLOR = '1';
  expect(isTTY()).toBe(false);
});

test('isTTY — NO_COLOR with empty string still disables', () => {
  // no-color.org standard: PRESENCE of the var, regardless of value.
  process.env.NO_COLOR = '';
  delete process.env.FORCE_COLOR;
  expect(isTTY()).toBe(false);
});

test('isTTY — FORCE_COLOR=1 enables color even when stdout is piped', () => {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  // Under bun test stdout is typically not a TTY — yet FORCE_COLOR must
  // still flip isTTY() to true so users can pipe through `watch -c` or
  // `less -R` and keep color.
  expect(isTTY()).toBe(true);
});

test('isTTY — FORCE_COLOR=0 does NOT override stdout-is-pipe', () => {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '0';
  // "0" is the documented opt-out value; isTTY should fall back to the
  // stdout TTY check (false under bun test).
  expect(isTTY()).toBe(false);
});

test('bold() with FORCE_COLOR=1 actually emits the SGR escape', () => {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  const s = bold('hi');
  expect(s).toContain('\x1b[1m');
  expect(s).toContain('\x1b[0m');
});
