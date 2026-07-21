import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createKimiSource } from './kimi-source.ts';

function fixture(): { dir: string; sessionUuid: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cm-kimi-'));
  const sessionUuid = 'e952f7ca-8b38-4c74-9b0a-12969e216bd8';
  const sdir = join(dir, 'hashabc', sessionUuid);
  mkdirSync(sdir, { recursive: true });
  const path = join(sdir, 'context.jsonl');
  writeFileSync(path, [
    { role: '_system_prompt', content: 'You are Kimi…' },
    { role: 'user', content: 'summarize input.txt' },
    { role: 'assistant', content: 'It says hello.' },
    { role: 'tool', content: 'read input.txt' },
    { role: 'user', content: 'thanks' },
    { role: 'assistant', content: 'welcome' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  return { dir, sessionUuid, path };
}

test('kimi extract: per-turn events, origin_agent=kimi, system prompt skipped', () => {
  const { sessionUuid, path } = fixture();
  const src = createKimiSource({ projectId: 'proj' });
  const events = src.extract({ sessionId: sessionUuid, path, marker: 'm', mtimeEpoch: 5 });

  expect(events).toHaveLength(2);
  expect(events.every((e) => e.origin_agent === 'kimi' && e.session_id === sessionUuid)).toBe(true);
  expect(events[0]!.tool_input_summary).toBe('summarize input.txt');
  expect(events[0]!.tool_result_summary).toContain('assistant: It says hello.');
  expect(events[0]!.tool_result_summary).toContain('read input.txt');
  expect(events[1]!.tool_input_summary).toBe('thanks');
});

test('kimi discover: finds context.jsonl by its session-uuid dir', () => {
  const { dir, sessionUuid } = fixture();
  const src = createKimiSource({ projectId: 'proj', dir, quiesceMs: 0, now: () => Date.now() + 10_000 });
  expect(src.discover().map((r) => r.sessionId)).toContain(sessionUuid);
});
