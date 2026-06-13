import { test, expect } from 'bun:test';
import {
  renderFrontmatter, deterministicFrontmatter, slugify, prefixForType,
} from '../../src/worker/memory-writer.ts';
import { chunkMemoryFile } from '../../src/worker/chunkers/memory-file.ts';

test('renderFrontmatter — round-trips through chunkMemoryFile', () => {
  const doc = renderFrontmatter(
    { name: 'Use bun test', description: 'always run bun test', type: 'decision' },
    'Body line one.\n\n## A section\ndetails',
  );
  const chunks = chunkMemoryFile(doc, '/x/decision_use-bun-test.md');
  const meta = chunks[0]!.metadata as Record<string, unknown>;
  expect(meta.name).toBe('Use bun test');
  expect(meta.description).toBe('always run bun test');
  expect(meta.memory_type).toBe('decision');
  expect(chunks.some(c => (c.metadata as Record<string, unknown>).section_title === 'A section')).toBe(true);
});

test('deterministicFrontmatter — name=first non-empty line, type=given, slug=slugified', () => {
  const fm = deterministicFrontmatter(
    '\n\n  Prefer pnpm over npm here  \nmore detail follows on the next lines',
    'preference',
  );
  expect(fm.name).toBe('Prefer pnpm over npm here');
  expect(fm.type).toBe('preference');
  expect(fm.slug).toBe('prefer-pnpm-over-npm-here');
  expect(fm.description.length).toBeGreaterThan(0);
});

test('deterministicFrontmatter — truncates an overlong first line for name', () => {
  const long = 'x'.repeat(300);
  const fm = deterministicFrontmatter(long, 'reference');
  expect(fm.name.length).toBeLessThanOrEqual(120);
});

test('slugify — lowercases, dashes non-alnum, trims edges, no doubles', () => {
  expect(slugify('  Use Bun, Not Node!! ')).toBe('use-bun-not-node');
  expect(slugify('123net_aelita')).toBe('123net-aelita');
});

test('prefixForType — maps known types, falls back to the type itself', () => {
  expect(prefixForType('preference')).toBe('feedback');
  expect(prefixForType('feedback')).toBe('feedback');
  expect(prefixForType('decision')).toBe('decision');
  expect(prefixForType('reference')).toBe('reference');
  expect(prefixForType('wild')).toBe('wild');
});
