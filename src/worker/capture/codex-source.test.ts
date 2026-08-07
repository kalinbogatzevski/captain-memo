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

function zstFixture(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cm-codex-zst-'));
  const path = join(dir, `rollout-2026-07-21T10-00-00-${UUID}.jsonl.zst`);
  writeFileSync(path, Bun.zstdCompressSync(Buffer.from(ROLLOUT, 'utf8')));
  return { dir, path };
}

test('codex discover: finds a compressed .jsonl.zst rollout and derives its uuid', () => {
  const { dir } = zstFixture();
  const src = createCodexSource({ dir, projectId: 'proj', quiesceMs: 0, now: () => Date.now() + 10_000 });
  const refs = src.discover();

  expect(refs).toHaveLength(1);
  expect(refs[0]!.sessionId).toBe(UUID);   // NOT the full path
});

test('codex extract: a .zst rollout yields the same events as plain JSONL', () => {
  const { path } = zstFixture();
  const src = createCodexSource({ projectId: 'proj' });
  const events = src.extract({ sessionId: UUID, path, marker: 'm', mtimeEpoch: 1 });

  expect(events).toHaveLength(2);
  expect(events.every((e) => e.origin_agent === 'codex')).toBe(true);
});

test('codex extract: an undecompressable .zst warns instead of returning empty silently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-codex-bad-'));
  const path = join(dir, `rollout-2026-07-21T10-00-00-${UUID}.jsonl.zst`);
  writeFileSync(path, Buffer.from('this is not zstd'));

  const warnings: string[] = [];
  const src = createCodexSource({ projectId: 'proj', warn: (m) => warnings.push(m) });
  const events = src.extract({ sessionId: UUID, path, marker: 'm', mtimeEpoch: 1 });

  expect(events).toHaveLength(0);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(path);
});

// FINDING 1(a) — the branch-defeats-its-own-premise gap. Before this, a rollout that read fine
// but matched no recognised payload type (e.g. a codex field-name rename) returned [] with no
// warning at all: file matched → parsed → zero events → marked ingested → doctor green. That is
// exactly the incident this whole capture source exists to prevent.
test('codex extract: a rollout with content but no recognised payload types warns instead of silently returning nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-codex-unrecognised-'));
  const path = join(dir, `rollout-2026-07-21T10-00-00-${UUID}.jsonl`);
  const lines = [
    { timestamp: '2026-07-21T10:00:00.000Z', type: 'session_meta', payload: { id: UUID, cwd: '/tmp/proj' } },
    { timestamp: '2026-07-21T10:00:01.000Z', type: 'event_msg', payload: { type: 'reasoning', text: 'thinking…' } },
    { timestamp: '2026-07-21T10:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', total: 42 } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n';
  writeFileSync(path, lines);

  const warnings: string[] = [];
  const src = createCodexSource({ projectId: 'proj', warn: (m) => warnings.push(m) });
  const events = src.extract({ sessionId: UUID, path, marker: 'm', mtimeEpoch: 1 });

  expect(events).toHaveLength(0);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(path);
  expect(warnings[0]).toContain('zero turns');
});

test('codex extract: lines that fail JSON.parse also warn, naming the failure count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-codex-badjson-'));
  const path = join(dir, `rollout-2026-07-21T10-00-00-${UUID}.jsonl`);
  writeFileSync(path, 'not json\nalso not json\n');

  const warnings: string[] = [];
  const src = createCodexSource({ projectId: 'proj', warn: (m) => warnings.push(m) });
  const events = src.extract({ sessionId: UUID, path, marker: 'm', mtimeEpoch: 1 });

  expect(events).toHaveLength(0);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('2/2');
});

test('codex extract: an empty file produces no events and NO warning (nothing was ever written)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-codex-blank-'));
  const path = join(dir, `rollout-2026-07-21T10-00-00-${UUID}.jsonl`);
  writeFileSync(path, '');

  const warnings: string[] = [];
  const src = createCodexSource({ projectId: 'proj', warn: (m) => warnings.push(m) });
  const events = src.extract({ sessionId: UUID, path, marker: 'm', mtimeEpoch: 1 });

  expect(events).toHaveLength(0);
  expect(warnings).toHaveLength(0);
});
