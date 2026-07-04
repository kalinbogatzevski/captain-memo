import { test, expect } from 'bun:test';
import { globsOverlap } from '../../src/worker/glob-overlap.ts';

test('exact vs exact: same file overlaps, different files do not', () => {
  expect(globsOverlap(['billing/invoice.ts'], ['billing/invoice.ts'])).toEqual(['billing/invoice.ts']);
  expect(globsOverlap(['billing/invoice.ts'], ['billing/credit.ts'])).toEqual([]);
});

test('a dir glob overlaps a file under it (both directions)', () => {
  expect(globsOverlap(['billing/**'], ['billing/invoice.ts'])).toEqual(['billing/**']);
  expect(globsOverlap(['billing/invoice.ts'], ['billing/**'])).toEqual(['billing/invoice.ts']);
});

test('disjoint dirs do not overlap', () => {
  expect(globsOverlap(['billing/**'], ['auth/**'])).toEqual([]);
});

test('nested dirs overlap (ancestor/descendant)', () => {
  expect(globsOverlap(['src/**'], ['src/auth/**'])).toEqual(['src/**']);
  expect(globsOverlap(['src/auth/**'], ['src/**'])).toEqual(['src/auth/**']);
});

test('sibling dirs with a shared name PREFIX do NOT overlap (billing vs billing-archive)', () => {
  expect(globsOverlap(['billing/**'], ['billing-archive/**'])).toEqual([]);   // boundary is base + "/"
});

test('a mid-path wildcard collapses to its dir (conservative over-warn)', () => {
  expect(globsOverlap(['src/*.ts'], ['src/auth/x.ts'])).toEqual(['src/*.ts']);
});

test('whole-tree glob overlaps anything', () => {
  expect(globsOverlap(['**'], ['anywhere/deep/file.ts'])).toEqual(['**']);
  expect(globsOverlap(['billing/x.ts'], ['*'])).toEqual(['billing/x.ts']);
});

test('returns ONLY the overlapping subset of the first list', () => {
  expect(globsOverlap(['billing/**', 'auth/**'], ['billing/x.ts'])).toEqual(['billing/**']);
});

test('empty file lists never overlap', () => {
  expect(globsOverlap([], ['billing/**'])).toEqual([]);
  expect(globsOverlap(['billing/**'], [])).toEqual([]);
});

test('a trailing slash means a directory (prefix), not an exact file', () => {
  expect(globsOverlap(['billing/'], ['billing/invoice.ts'])).toEqual(['billing/']);
  expect(globsOverlap(['./billing/'], ['billing/invoice.ts'])).toEqual(['./billing/']);
});

test('a bare path (no slash, no wildcard) is an exact file', () => {
  expect(globsOverlap(['README'], ['README'])).toEqual(['README']);
  expect(globsOverlap(['billing'], ['billing/invoice.ts'])).toEqual([]);   // "billing" the file ≠ billing/ the dir
});
