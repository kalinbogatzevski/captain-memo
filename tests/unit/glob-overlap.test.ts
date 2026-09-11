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

// ─── Windows path spellings ────────────────────────────────────────────────
// One file, three spellings: the Edit tool sends `C:\src\a.ts` (backslashes — verified live on the
// board), a Bash-driven edit resolves MSYS-style `/c/src/a.ts`, PowerShell gives `C:/src/a.ts`. norm()
// split on "/" only and compared raw text, so NONE of them overlapped — two sessions editing the same
// file through different shells were told nothing. That is a silent clobber, the exact failure the
// board exists to prevent.
test('separator and drive spellings of the same path overlap', () => {
  expect(globsOverlap(['C:\\src\\proj\\a.ts'], ['C:/src/proj/a.ts'])).toEqual(['C:\\src\\proj\\a.ts']);
  expect(globsOverlap(['/c/src/proj/a.ts'], ['C:\\src\\proj\\a.ts'])).toEqual(['/c/src/proj/a.ts']);
  expect(globsOverlap(['c:/src/proj/**'], ['C:\\src\\proj\\a.ts'])).toEqual(['c:/src/proj/**']);
});

test('canonicalisation does not merge genuinely different paths', () => {
  expect(globsOverlap(['C:\\src\\proj\\a.ts'], ['C:\\src\\proj\\b.ts'])).toEqual([]);
  expect(globsOverlap(['/c/src/a.ts'], ['/d/src/a.ts'])).toEqual([]);
});

// Only the DRIVE LETTER is case-folded (drive letters are case-insensitive everywhere). The rest of the
// path is left alone so a Linux captain keeps its case-sensitive semantics.
test('path case is preserved — only the drive letter folds', () => {
  expect(globsOverlap(['/home/k/proj/A.ts'], ['/home/k/proj/a.ts'])).toEqual([]);
  expect(globsOverlap(['c:/x/a.ts'], ['C:/x/a.ts'])).toEqual(['c:/x/a.ts']);
});

test('relative globs still behave exactly as before', () => {
  expect(globsOverlap(['billing/**'], ['billing/invoice.ts'])).toEqual(['billing/**']);
  expect(globsOverlap(['./src/a.ts'], ['src/a.ts'])).toEqual(['./src/a.ts']);
});
