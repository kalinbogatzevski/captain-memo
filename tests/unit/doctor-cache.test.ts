import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findCachedPluginRoot } from '../../src/cli/commands/doctor.ts';

let cacheRoot: string;
beforeEach(() => { cacheRoot = mkdtempSync(join(tmpdir(), 'cm-cache-')); });
afterEach(() => { rmSync(cacheRoot, { recursive: true, force: true }); });

// Lay down a captain-memo plugin copy at <cacheRoot>/captain-memo/captain-memo/<ver>/,
// optionally marked orphaned (the .orphaned_at file Claude Code writes during its
// 7-day grace period before it GCs the dir itself).
function plant(version: string, orphaned: boolean) {
  const dir = join(cacheRoot, 'captain-memo', 'captain-memo', version);
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'captain-memo', version }));
  if (orphaned) writeFileSync(join(dir, '.orphaned_at'), String(1));
  return dir;
}

// v0.2.10 fix: after an upgrade the OLD version dir lingers (orphaned) for 7 days.
// doctor must evaluate the ACTIVE copy, not the orphaned leftover — even when the
// orphaned dir has a HIGHER version number (i.e. a downgrade), where the old
// "pick highest" heuristic would have chosen wrong.
test('findCachedPluginRoot skips an orphaned dir and returns the active one', () => {
  const active = plant('0.2.9', false);
  plant('0.2.10', true);   // higher version, but orphaned → must be ignored
  expect(findCachedPluginRoot(cacheRoot)).toBe(active);
});

test('findCachedPluginRoot picks the highest among multiple ACTIVE copies', () => {
  plant('0.2.8', false);
  const newest = plant('0.2.10', false);
  expect(findCachedPluginRoot(cacheRoot)).toBe(newest);
});

test('findCachedPluginRoot returns null when nothing is cached', () => {
  expect(findCachedPluginRoot(cacheRoot)).toBeNull();
});
