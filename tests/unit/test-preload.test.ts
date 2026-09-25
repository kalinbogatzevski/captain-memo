// The suite must never run against the machine's real HOME, data dir or config dir (tests/preload.ts).
import { test, expect } from 'bun:test';
import { homedir, tmpdir } from 'os';
import { DATA_DIR, CONFIG_DIR } from '../../src/shared/paths.ts';

test('the suite runs on a scratch home, in-process and in children, with self-heal off', () => {
  const home = process.env.HOME!;
  expect(home.startsWith(tmpdir())).toBe(true);
  expect(homedir()).toBe(home);
  expect(DATA_DIR.startsWith(home)).toBe(true);
  expect(CONFIG_DIR.startsWith(home)).toBe(true);
  expect(process.env.CAPTAIN_MEMO_DISABLE_SELF_HEAL).toBe('1');
  // What a spawned hook or worker resolves as its home.
  const child = Bun.spawnSync(['bun', '-e', 'process.stdout.write(require("os").homedir())'], { env: { ...process.env } });
  expect(child.stdout.toString()).toBe(home);
});
