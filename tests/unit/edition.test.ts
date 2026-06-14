import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectEdition, EDITION } from '../../src/shared/edition.ts';

// detectEdition(baseDir) checks for `<baseDir>/../worker/federation`. Fabricate both shapes so the test is
// branch-independent (it must pass identically on the federation branch and on OSS master).
const root = mkdtempSync(join(tmpdir(), 'edition-'));
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

test("detectEdition → 'federation' when the worker/federation tree exists alongside", () => {
  const base = join(root, 'fed', 'src', 'shared');
  mkdirSync(base, { recursive: true });
  mkdirSync(join(root, 'fed', 'src', 'worker', 'federation'), { recursive: true });
  expect(detectEdition(base)).toBe('federation');
});

test("detectEdition → 'oss' when there is no worker/federation tree", () => {
  const base = join(root, 'oss', 'src', 'shared');
  mkdirSync(base, { recursive: true });
  mkdirSync(join(root, 'oss', 'src', 'worker'), { recursive: true });   // worker/ exists, but no federation/
  expect(detectEdition(base)).toBe('oss');
});

test('EDITION resolves to one of the two valid editions', () => {
  expect(['federation', 'oss']).toContain(EDITION);
});