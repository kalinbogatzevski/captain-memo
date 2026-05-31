// tests/unit/shared/worker-heal-lock.test.ts
import { test, expect } from 'bun:test';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireHealLock, releaseHealLock } from '../../../src/shared/worker-heal-lock.ts';

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cm-heal-')), '.worker-heal.lock');
}

test('first acquire succeeds, second is refused while fresh', () => {
  const p = lockPath();
  expect(acquireHealLock(p, 1000)).toBe(true);
  expect(acquireHealLock(p, 1500)).toBe(false); // held, 500ms old < TTL
  releaseHealLock(p);
  expect(existsSync(p)).toBe(false);
});

test('a stale lock (older than TTL) is reclaimed', () => {
  const p = lockPath();
  expect(acquireHealLock(p, 0)).toBe(true);
  // 21s later — past the 20s TTL — the stale lock is taken over.
  expect(acquireHealLock(p, 21_000)).toBe(true);
  releaseHealLock(p);
});

test('release is idempotent and never throws', () => {
  const p = lockPath();
  releaseHealLock(p); // not held — no throw
  expect(true).toBe(true);
});
