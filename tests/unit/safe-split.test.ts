import { test, expect } from 'bun:test';
import { splitForEmbed } from '../../src/worker/chunkers/safe-split.ts';
import { countTokens } from '../../src/shared/tokens.ts';
import type { ChunkInput } from '../../src/shared/types.ts';

const SMALL_LIMIT = 100; // splitter's internal target = 0.75 × 100 = 75 tokens

function chunk(text: string, position = 0, metadata: Record<string, unknown> = {}): ChunkInput {
  return { text, position, metadata };
}

test('splitForEmbed — passes through chunks already under target', () => {
  const out = splitForEmbed([chunk('hello world')], SMALL_LIMIT);
  expect(out).toHaveLength(1);
  expect(out[0]!.text).toBe('hello world');
  expect(out[0]!.metadata.split_index).toBeUndefined();
});

test('splitForEmbed — splits on H2 headings when oversized', () => {
  const big = [
    '## Section 1',
    'the quick brown fox '.repeat(60),
    '',
    '## Section 2',
    'jumps over the lazy dog '.repeat(60),
  ].join('\n');
  const out = splitForEmbed([chunk(big)], SMALL_LIMIT);
  expect(out.length).toBeGreaterThanOrEqual(2);
  for (const c of out) {
    expect(countTokens(c.text)).toBeLessThanOrEqual(SMALL_LIMIT);
  }
  // First fragment should still start with a heading marker
  expect(out[0]!.text.startsWith('## Section')).toBe(true);
});

test('splitForEmbed — falls back to H3 when no H2 boundaries', () => {
  const big = [
    '### Sub 1',
    'word '.repeat(120),
    '### Sub 2',
    'word '.repeat(120),
  ].join('\n');
  const out = splitForEmbed([chunk(big)], SMALL_LIMIT);
  expect(out.length).toBeGreaterThanOrEqual(2);
  expect(out.every(c => countTokens(c.text) <= SMALL_LIMIT)).toBe(true);
});

test('splitForEmbed — falls back to paragraphs when no headings', () => {
  const big = [
    'word '.repeat(60),
    'word '.repeat(60),
    'word '.repeat(60),
  ].join('\n\n');
  const out = splitForEmbed([chunk(big)], SMALL_LIMIT);
  expect(out.length).toBeGreaterThanOrEqual(2);
  expect(out.every(c => countTokens(c.text) <= SMALL_LIMIT)).toBe(true);
});

test('splitForEmbed — falls back to sentences when no paragraphs', () => {
  // Single paragraph with several sentences, total > limit
  const sentence = 'this is a moderately long sentence about cats and dogs and turtles. ';
  const big = sentence.repeat(30);
  const out = splitForEmbed([chunk(big)], SMALL_LIMIT);
  expect(out.length).toBeGreaterThan(1);
  expect(out.every(c => countTokens(c.text) <= SMALL_LIMIT)).toBe(true);
});

test('splitForEmbed — char-level chop ultimate fallback for one giant token-blob', () => {
  // A single line with no whitespace at all → no sentence/line/paragraph
  // boundaries. Splitter must still produce fitting fragments.
  const blob = 'x'.repeat(2000);
  const out = splitForEmbed([chunk(blob)], SMALL_LIMIT);
  expect(out.length).toBeGreaterThan(1);
  expect(out.every(c => countTokens(c.text) <= SMALL_LIMIT)).toBe(true);
  // Concatenation should be lossless (modulo trim, but blob has no whitespace)
  expect(out.map(c => c.text).join('')).toBe(blob);
});

test('splitForEmbed — preserves metadata and adds split_index / split_total when divided', () => {
  const big = [
    '## A',
    'word '.repeat(60),
    '## B',
    'word '.repeat(60),
  ].join('\n');
  const out = splitForEmbed(
    [chunk(big, 0, { doc_type: 'memory_file', source_path: '/foo' })],
    SMALL_LIMIT,
  );
  expect(out.length).toBeGreaterThan(1);
  for (let i = 0; i < out.length; i++) {
    expect(out[i]!.metadata.doc_type).toBe('memory_file');
    expect(out[i]!.metadata.source_path).toBe('/foo');
    expect(out[i]!.metadata.split_index).toBe(i);
    expect(out[i]!.metadata.split_total).toBe(out.length);
  }
});

test('splitForEmbed — does NOT add split_index when chunk fits as-is', () => {
  const out = splitForEmbed(
    [chunk('hello', 0, { doc_type: 'memory_file' })],
    SMALL_LIMIT,
  );
  expect(out[0]!.metadata.split_index).toBeUndefined();
  expect(out[0]!.metadata.split_total).toBeUndefined();
});

test('splitForEmbed — renumbers positions sequentially across the output', () => {
  const small = chunk('first', 0);
  const big = chunk(['## A', 'word '.repeat(60), '## B', 'word '.repeat(60)].join('\n'), 1);
  const last = chunk('last', 2);
  const out = splitForEmbed([small, big, last], SMALL_LIMIT);
  // Positions should be 0, 1, 2, ..., N-1 with no gaps
  for (let i = 0; i < out.length; i++) {
    expect(out[i]!.position).toBe(i);
  }
});

test('splitForEmbed — recurses into oversized fragments after first split', () => {
  // One H2 section that's STILL too big after the H2 split → must drop
  // through paragraph/sentence/line until it fits.
  const big = [
    '## Big Section',
    'word '.repeat(200), // single paragraph, well over limit
  ].join('\n');
  const out = splitForEmbed([chunk(big)], SMALL_LIMIT);
  expect(out.length).toBeGreaterThan(1);
  expect(out.every(c => countTokens(c.text) <= SMALL_LIMIT)).toBe(true);
});

test('splitForEmbed — handles empty chunk list', () => {
  expect(splitForEmbed([], SMALL_LIMIT)).toEqual([]);
});
