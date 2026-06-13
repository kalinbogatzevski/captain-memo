import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkRemember, type Check } from '../../src/cli/commands/doctor.ts';

let dir = '';
afterEach(() => {
  delete process.env.CAPTAIN_MEMO_CONFIG_DIR;
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = ''; }
});

test('checkRemember reports defaults when no worker.env keys are set', () => {
  dir = mkdtempSync(join(tmpdir(), 'cm-doctor-remember-'));
  process.env.CAPTAIN_MEMO_CONFIG_DIR = dir; // empty → no worker.env → defaults

  const c: Check = checkRemember();
  expect(c.name).toBe('remember / promote');
  expect(c.status).toBe('PASS');
  expect(c.detail).toContain('memory');
  expect(c.detail).toContain('promote=off');
  expect(c.detail).toContain('max=5');
  expect(c.detail).toContain('dedup=0.85');
});
