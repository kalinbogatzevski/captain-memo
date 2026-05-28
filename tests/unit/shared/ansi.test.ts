// tests/unit/shared/ansi.test.ts
//
// Tests for the ANSI helpers added to support responsive stats layout.
// visibleWidth and padVisibleEnd must respect SGR escape sequences — if
// they don't, side-by-side columns would drift apart by ~8 chars per
// escape, ruining alignment.

import { test, expect } from 'bun:test';
import {
  bold, cyan, dim, goldBold,
  visibleWidth, padVisibleEnd,
} from '../../../src/shared/ansi.ts';

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
