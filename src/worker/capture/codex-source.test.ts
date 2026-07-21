import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCodexSource } from './codex-source.ts';

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ROLLOUT = [
  { timestamp: '2026-07-21T10:00:00.000Z', type: 'session_meta', payload: { id: UUID, cwd: '/tmp/proj' } },
  { timestamp: '2026-07-21T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'fix the bug in foo.ts' } },
  { timestamp: '2026-07-21T10:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'grep -n bug foo.ts' } },
  { timestamp: '2026-07-21T10:00:03.000Z', type: 'event_msg', payload: { type: 'patch_apply_end', stdout: 'Success. Updated the following files:\nM /tmp/proj/foo.ts' } },
  { timestamp: '2026-07-21T10:00:04.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Fixed it.' } },
  { timestamp: '2026-07-21T10:00:05.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'now add a test' } },
  { timestamp: '2026-07-21T10:00:06.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Added test_foo.ts' } },
].map((o) => JSON.stringify(o)).join('\n') + '\n';

function fixture(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cm-codex-'));
  const path = join(dir, `rollout-2026-07-21T10-00-00-${UUID}.jsonl`);
  writeFileSync(path, ROLLOUT);
  return { dir, path };
}

test('codex extract: one event per user turn, stamped origin_agent=codex', () => {
  const { path } = fixture();
  const src = createCodexSource({ projectId: 'proj' });
  const events = src.extract({ sessionId: UUID, path, marker: 'm', mtimeEpoch: 1 });

  expect(events).toHaveLength(2);
  expect(events.every((e) => e.origin_agent === 'codex')).toBe(true);
  expect(events.every((e) => e.session_id === UUID && e.project_id === 'proj')).toBe(true);

  expect(events[0]!.prompt_number).toBe(1);
  expect(events[0]!.tool_input_summary).toBe('fix the bug in foo.ts');
  expect(events[0]!.files_modified).toContain('/tmp/proj/foo.ts');
  expect(events[0]!.tool_result_summary).toContain('exec(');
  expect(events[0]!.tool_result_summary).toContain('assistant: Fixed it.');

  expect(events[1]!.prompt_number).toBe(2);
  expect(events[1]!.tool_input_summary).toBe('now add a test');
  expect(events[1]!.tool_result_summary).toContain('Added test_foo.ts');
});

test('codex discover: finds a quiescent rollout by its uuid', () => {
  const { dir, path } = fixture();
  const src = createCodexSource({ projectId: 'proj', dir, quiesceMs: 0, now: () => Date.now() + 10_000 });
  const refs = src.discover();
  expect(refs.map((r) => r.sessionId)).toContain(UUID);
  expect(refs.find((r) => r.sessionId === UUID)!.path).toBe(path);
});

test('codex enabled(): default on, off via env=0', () => {
  const on = createCodexSource({ projectId: 'p', env: {} });
  const off = createCodexSource({ projectId: 'p', env: { CAPTAIN_MEMO_CAPTURE_CODEX: '0' } });
  expect(on.enabled()).toBe(true);
  expect(off.enabled()).toBe(false);
});
