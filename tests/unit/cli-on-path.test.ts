import { test, expect } from 'bun:test';
import { cliOnPath } from '../../src/shared/cli-on-path.ts';

test('cliOnPath resolves an installed CLI to its path and answers null for a missing one, without a subprocess', () => {
  // `bun` is what runs this test, so it is on PATH on every OS the suite runs on (Windows included).
  const bun = cliOnPath('bun');
  expect(bun).not.toBeNull();
  expect(bun!.toLowerCase()).toContain('bun');
  expect(cliOnPath('captain-memo-definitely-not-installed-xyz')).toBeNull();
});
