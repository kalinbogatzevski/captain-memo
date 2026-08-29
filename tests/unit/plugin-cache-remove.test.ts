import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeCacheTree } from '../../src/cli/commands/maintenance.ts';

/** The delete gate itself. planPrune decides WHETHER a tree may go; this decides whether the path in
 *  front of us at delete time is really that tree. Worth its own runs: on a healthy host the dry-run
 *  never reaches this code, so without a test its first-ever execution would be a real `--apply`. */
function fixture(): { root: string; tree: (name: string) => string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cm-rm-')));
  const cache = join(root, 'cache');
  mkdirSync(cache, { recursive: true });
  return {
    root: cache,
    tree: (name: string) => {
      const p = join(cache, 'mkt', 'captain-memo', name);
      mkdirSync(join(p, 'dist'), { recursive: true });
      writeFileSync(join(p, 'dist', 'x.js'), 'x');
      return p;
    },
  };
}

test('a plain version directory under the cache root is removed', () => {
  const { root, tree } = fixture();
  const p = tree('0.11.0');
  expect(removeCacheTree(p, root)).toBeNull();
  expect(existsSync(p)).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test('a SYMLINKED version dir is refused, and its target survives untouched', () => {
  // The gate that matters most: rmSync -r through a symlink would delete the checkout it points at.
  const { root, tree } = fixture();
  const real = tree('0.11.0');
  const link = join(root, 'mkt', 'captain-memo', '0.12.0');
  symlinkSync(real, link);
  expect(removeCacheTree(link, root)).toContain('symlink');
  expect(existsSync(link)).toBe(true);
  expect(existsSync(join(real, 'dist', 'x.js'))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test('a path resolving outside the cache root is refused', () => {
  const { root } = fixture();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cm-outside-')));
  mkdirSync(join(outside, 'precious'), { recursive: true });
  expect(removeCacheTree(join(outside, 'precious'), root)).toContain('outside the cache root');
  expect(existsSync(join(outside, 'precious'))).toBe(true);
  // The cache root ITSELF is not under the root, so it can never be its own candidate.
  expect(removeCacheTree(root, root)).toContain('outside the cache root');
  expect(existsSync(root)).toBe(true);
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('a file, or a path that vanished between plan and delete, is refused not forced', () => {
  const { root } = fixture();
  const file = join(root, 'a-file');
  writeFileSync(file, 'x');
  expect(removeCacheTree(file, root)).toContain('not a directory');
  expect(existsSync(file)).toBe(true);
  expect(removeCacheTree(join(root, 'gone'), root)).toContain('vanished');
  rmSync(root, { recursive: true, force: true });
});
