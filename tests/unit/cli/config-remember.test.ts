import { test, expect, afterEach } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { configCommand } from '../../../src/cli/commands/config.ts';

const realLog = console.log;
afterEach(() => { console.log = realLog; });

async function capture(): Promise<string> {
  const out: string[] = [];
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  await configCommand(['show']);
  console.log = realLog;
  return out.join('\n');
}

test('config show — prints remember_dir default ~/.claude/memory', async () => {
  delete process.env.CAPTAIN_MEMO_REMEMBER_DIR;
  const text = await capture();
  expect(text).toContain('remember_dir');
  expect(text).toContain(join(homedir(), '.claude', 'memory'));
});

test('config show — prints promote knobs with defaults', async () => {
  delete process.env.CAPTAIN_MEMO_PROMOTE_ENABLE;
  delete process.env.CAPTAIN_MEMO_PROMOTE_INTERVAL_MS;
  delete process.env.CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN;
  delete process.env.CAPTAIN_MEMO_REMEMBER_DEDUP_THRESHOLD;
  const text = await capture();
  expect(text).toContain('promote_enable');
  expect(text).toContain('0 (off)');
  expect(text).toContain('promote_interval_ms');
  expect(text).toContain('21600000');
  expect(text).toContain('promote_max_per_run');
  expect(text).toMatch(/promote_max_per_run\s+5/);
  expect(text).toContain('remember_dedup_threshold');
  expect(text).toContain('0.85');
});

test('config show — env override wins for promote_enable', async () => {
  process.env.CAPTAIN_MEMO_PROMOTE_ENABLE = '1';
  const text = await capture();
  expect(text).toMatch(/promote_enable\s+1/);
  delete process.env.CAPTAIN_MEMO_PROMOTE_ENABLE;
});
