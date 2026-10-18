// `bun test` must never reach this machine's REAL Captain Memo state. DATA_DIR and CONFIG_DIR honour an exported
// CAPTAIN_MEMO_DATA_DIR / CAPTAIN_MEMO_CONFIG_DIR before the home, and tests/preload.ts used to redirect only HOME, so a shell
// that exported either pointed a plain `bun test` at the live data or config dir.
import { test, expect } from 'bun:test';
import { homedir, tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { DATA_DIR, CONFIG_DIR } from '../../src/shared/paths.ts';

const REAL_HOME = process.env.CAPTAIN_MEMO_TEST_REAL_HOME ?? '';   // recorded by tests/preload.ts before it replaced HOME
const REAL_DIRS = [join(REAL_HOME, '.captain-memo'), join(REAL_HOME, '.config', 'captain-memo')];
const underReal = (p: string): boolean => REAL_DIRS.some((d) => p === d || p.startsWith(d + sep));

test('the preload recorded the real home and this process is on a scratch one', () => {
  expect(REAL_HOME).not.toBe('');
  expect(homedir()).not.toBe(REAL_HOME);
  expect(homedir()).toContain('cm-test-home-');
  expect(process.env.HOME).toBe(homedir());
});

test('DATA_DIR and CONFIG_DIR are not under the real ~/.captain-memo or ~/.config/captain-memo', () => {
  expect([DATA_DIR, CONFIG_DIR].filter(underReal)).toEqual([]);
  expect(underReal(process.env.CAPTAIN_MEMO_DATA_DIR ?? '')).toBe(false);
  expect(underReal(process.env.CAPTAIN_MEMO_CONFIG_DIR ?? '')).toBe(false);
});

// The case that bit: the variable is EXPORTED when the tests start. A nested `bun test` of a probe file runs under this repo's own
// bunfig preload with fake dirs exported; the preload has to win, or every child it spawns inherits them too.
test('an exported CAPTAIN_MEMO_DATA_DIR / CAPTAIN_MEMO_CONFIG_DIR does not survive the preload', () => {
  const fake = join(tmpdir(), 'cm-isolation-exported');
  const r = Bun.spawnSync([process.execPath, 'test', './tests/support/isolation-probe.ts'], {
    cwd: resolve(import.meta.dir, '../..'),
    env: { ...process.env, CAPTAIN_MEMO_DATA_DIR: join(fake, 'data'), CAPTAIN_MEMO_CONFIG_DIR: join(fake, 'config') },
    stdout: 'pipe', stderr: 'pipe', timeout: 60_000, killSignal: 'SIGKILL',
  });
  const line = `${r.stdout}\n${r.stderr}`.split('\n').find((l) => l.startsWith('PROBE '));
  expect(line, `the probe printed nothing:\n${r.stdout}\n${r.stderr}`).toBeDefined();
  const seen = JSON.parse(line!.slice('PROBE '.length)) as { DATA_DIR: string; CONFIG_DIR: string };
  expect(seen.DATA_DIR).not.toContain('cm-isolation-exported');
  expect(seen.CONFIG_DIR).not.toContain('cm-isolation-exported');
  expect(seen.DATA_DIR).toContain('cm-test-home-');
  expect(seen.CONFIG_DIR).toContain('cm-test-home-');
  expect([seen.DATA_DIR, seen.CONFIG_DIR].filter(underReal)).toEqual([]);
});
