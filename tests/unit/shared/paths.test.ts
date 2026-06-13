import { test, expect } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import {
  ENV_REMEMBER_DIR, DEFAULT_REMEMBER_DIR,
  ENV_PROMOTE_ENABLE,
  ENV_PROMOTE_INTERVAL_MS, DEFAULT_PROMOTE_INTERVAL_MS,
  ENV_PROMOTE_MAX_PER_RUN, DEFAULT_PROMOTE_MAX_PER_RUN,
  ENV_REMEMBER_DEDUP_THRESHOLD, DEFAULT_REMEMBER_DEDUP_THRESHOLD,
} from '../../../src/shared/paths.ts';

test('env-var names match the CAPTAIN_MEMO_* contract verbatim', () => {
  expect(ENV_REMEMBER_DIR).toBe('CAPTAIN_MEMO_REMEMBER_DIR');
  expect(ENV_PROMOTE_ENABLE).toBe('CAPTAIN_MEMO_PROMOTE_ENABLE');
  expect(ENV_PROMOTE_INTERVAL_MS).toBe('CAPTAIN_MEMO_PROMOTE_INTERVAL_MS');
  expect(ENV_PROMOTE_MAX_PER_RUN).toBe('CAPTAIN_MEMO_PROMOTE_MAX_PER_RUN');
  expect(ENV_REMEMBER_DEDUP_THRESHOLD).toBe('CAPTAIN_MEMO_REMEMBER_DEDUP_THRESHOLD');
});

test('defaults match spec §8', () => {
  expect(DEFAULT_REMEMBER_DIR).toBe(join(homedir(), '.claude', 'memory'));
  expect(DEFAULT_PROMOTE_INTERVAL_MS).toBe(21_600_000);
  expect(DEFAULT_PROMOTE_MAX_PER_RUN).toBe(5);
  expect(DEFAULT_REMEMBER_DEDUP_THRESHOLD).toBe(0.85);
});
