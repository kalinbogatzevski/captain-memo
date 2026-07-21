import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGeminiSource } from './gemini-source.ts';

function fixture(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cm-gem-'));
  const chats = join(dir, 'hash1', 'chats');
  mkdirSync(chats, { recursive: true });
  const path = join(chats, 'session-2026-07-21T10-00-abc123.json');
  writeFileSync(path, JSON.stringify({
    sessionId: 'gs1',
    messages: [
      { type: 'user', content: 'fix the bug', timestamp: '2026-07-21T10:00:00Z' },
      { type: 'gemini', content: 'looking into it', timestamp: '2026-07-21T10:00:01Z', toolCalls: [{ name: 'run_shell', args: { command: 'grep bug' } }] },
      { type: 'info', content: 'noise' },
      { type: 'user', content: 'now add a test', timestamp: '2026-07-21T10:00:05Z' },
      { type: 'gemini', content: 'added the test', timestamp: '2026-07-21T10:00:06Z' },
    ],
  }));
  return { dir, path };
}

test('gemini extract: per-turn events, origin_agent=gemini, tool calls captured', () => {
  const { path } = fixture();
  const src = createGeminiSource({ projectId: 'proj' });
  const events = src.extract({ sessionId: 'x', path, marker: 'm', mtimeEpoch: 1 });

  expect(events).toHaveLength(2);
  expect(events.every((e) => e.origin_agent === 'gemini' && e.session_id === 'gs1')).toBe(true);
  expect(events[0]!.prompt_number).toBe(1);
  expect(events[0]!.tool_input_summary).toBe('fix the bug');
  expect(events[0]!.tool_result_summary).toContain('assistant: looking into it');
  expect(events[0]!.tool_result_summary).toContain('run_shell(');
  expect(events[1]!.tool_input_summary).toBe('now add a test');
});

test('gemini discover: finds a quiescent session json', () => {
  const { dir, path } = fixture();
  const src = createGeminiSource({ projectId: 'proj', dir, quiesceMs: 0, now: () => Date.now() + 10_000 });
  expect(src.discover().map((r) => r.path)).toContain(path);
});
