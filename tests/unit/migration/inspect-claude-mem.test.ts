import { test, expect } from 'bun:test';
import {
  CLAUDE_MEM_TABLES,
  CLAUDE_MEM_DEFAULT_PATH,
} from '../../../src/migration/claude-mem-schema.ts';

test('claude-mem schema constants — known tables enumerated', () => {
  expect(CLAUDE_MEM_TABLES).toContain('observations');
  expect(CLAUDE_MEM_TABLES).toContain('session_summaries');
  expect(CLAUDE_MEM_TABLES).toContain('user_prompts');
  expect(CLAUDE_MEM_TABLES).toContain('sdk_sessions');
});

test('claude-mem default path — ~/.claude-mem/claude-mem.db', () => {
  expect(CLAUDE_MEM_DEFAULT_PATH).toMatch(/\.claude-mem[\/\\]claude-mem\.db$/);
});
