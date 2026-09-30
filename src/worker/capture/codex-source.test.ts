import { test, expect } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createCodexSource } from './codex-source.ts';
import { CaptureState } from './state.ts';
import { runCaptureTick } from './driver.ts';
import type { CaptureSource } from './types.ts';

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

test('codex extract: current response_item messages form turns without counting generated context or mirrored answers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-codex-current-'));
  const path = join(dir, `rollout-2026-08-24T10-00-00-${UUID}.jsonl`);
  const lines = [
    { timestamp: '2026-08-24T10:00:00.000Z', type: 'session_meta', payload: { id: UUID, cwd: '/tmp/proj' } },
    { timestamp: '2026-08-24T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>generated</environment_context>' }] } },
    { timestamp: '2026-08-24T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the current parser' }] } },
    { timestamp: '2026-08-24T10:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Parser fixed.' }] } },
    { timestamp: '2026-08-24T10:00:04.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Parser fixed.' } },
    { timestamp: '2026-08-24T10:00:05.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add regression coverage' }] } },
    { timestamp: '2026-08-24T10:00:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: 'tests' } },
    { timestamp: '2026-08-24T10:00:07.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Coverage added.' }] } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n';
  writeFileSync(path, lines);

  const src = createCodexSource({ projectId: 'proj' });
  const events = src.extract({ sessionId: UUID, path, marker: 'm', mtimeEpoch: 1 });

  expect(events).toHaveLength(2);
  expect(events[0]!.tool_input_summary).toBe('fix the current parser');
  expect(events[0]!.tool_result_summary).toBe('assistant: Parser fixed.');
  expect(events[1]!.tool_input_summary).toBe('add regression coverage');
  expect(events[1]!.tool_result_summary).toContain('apply_patch(');
  expect(events[1]!.tool_result_summary).toContain('assistant: Coverage added.');
});

test('codex cursor repair counts turns at a previous append-only byte marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-codex-marker-'));
  const path = join(dir, `rollout-2026-08-24T10-00-00-${UUID}.jsonl`);
  const line = (o: object) => JSON.stringify(o) + '\n';
  const prefix = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'first' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'done' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'second' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'done too' }] } },
  ].map(line).join('');
  const tail = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'third' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'done three' }] } },
  ].map(line).join('');
  writeFileSync(path, prefix + tail);
  const src = createCodexSource({ projectId: 'proj' });
  const ref = { sessionId: UUID, path, marker: `2000:${Buffer.byteLength(prefix + tail)}`, mtimeEpoch: 2 };

  expect(src.extract(ref)).toHaveLength(3);
  expect(src.eventCountAtMarker?.(ref, `1000:${Buffer.byteLength(prefix)}`)).toBe(2);
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

// ---- incremental extract: extractFrom(ref, resume) must equal the full extract's tail, exactly ----

const NOW = () => 1_900_000_000_000;
// Mixes every boundary rule: generated context replaced by the real prompt, the legacy mirrored
// prompt pair, mirrored assistant text, a tool-only turn, lines with no timestamp, multibyte chars.
const MIXED = [
  { timestamp: '2026-08-24T10:00:00.000Z', type: 'session_meta', payload: { id: UUID, cwd: '/tmp/proj' } },
  { timestamp: '2026-08-24T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '<environment_context>gen</environment_context>' }] } },
  { timestamp: '2026-08-24T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'first ünïcode' }] } },
  { timestamp: '2026-08-24T10:00:03.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'first ünïcode' } },
  { timestamp: '2026-08-24T10:00:04.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: 'ls' } },
  { type: 'event_msg', payload: { type: 'agent_message', message: 'one' } },
  { timestamp: '2026-08-24T10:00:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'one' }] } },
  { timestamp: '2026-08-24T10:00:06.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'one' } },
  { timestamp: '2026-08-24T10:00:07.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'second' } },
  { timestamp: '2026-08-24T10:00:08.000Z', type: 'event_msg', payload: { type: 'patch_apply_end', stdout: 'Updated the following files:\nM /tmp/proj/a.ts' } },
  { timestamp: '2026-08-24T10:00:09.000Z', type: 'event_msg', payload: { type: 'token_count', total: 1 } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'third' }] } },
  { timestamp: '2026-08-24T10:00:10.000Z', type: 'event_msg', payload: { type: 'mcp_tool_call_end', invocation: { server: 's', tool: 't', arguments: { q: 1 } } } },
  { timestamp: '2026-08-24T10:00:11.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'three' }] } },
].map((o) => JSON.stringify(o) + '\n').join('');

function incFixture(): { path: string; ref: { sessionId: string; path: string; marker: string; mtimeEpoch: number } } {
  const dir = mkdtempSync(join(tmpdir(), 'cm-codex-inc-'));
  const path = join(dir, `rollout-2026-08-24T10-00-00-${UUID}.jsonl`);
  return { path, ref: { sessionId: UUID, path, marker: 'm', mtimeEpoch: 1 } };
}

test('codex extractFrom: at EVERY byte split (mid-line and mid-turn included) the resumed tail equals the full extract', () => {
  const bytes = Buffer.from(MIXED, 'utf8');
  const { path, ref } = incFixture();
  const src = createCodexSource({ projectId: 'proj', now: NOW, warn: () => {} });
  writeFileSync(path, bytes);
  const full = src.extract(ref);
  expect(full.map((e) => e.prompt_number)).toEqual([1, 2, 3]);
  let resumedSplits = 0;

  for (let cut = 0; cut <= bytes.length; cut++) {
    writeFileSync(path, bytes.subarray(0, cut));
    const first = src.extractFrom!(ref, null);       // first sight: full parse
    expect(first.from).toBeNull();
    expect(first.events).toEqual(src.extract(ref));
    appendFileSync(path, bytes.subarray(cut));
    const next = src.extractFrom!(ref, first.resume);
    if (first.resume) { expect(next.from).not.toBeNull(); resumedSplits++; }
    expect(next.events).toEqual(full.slice(next.from ?? 0));
    // chained: resuming again from the new resume point on the unchanged file still matches
    const again = src.extractFrom!(ref, next.resume);
    expect(again.events).toEqual(full.slice(again.from ?? 0));
  }
  expect(resumedSplits).toBeGreaterThan(bytes.length / 2);
});

test('codex extractFrom: a file rewritten SHORTER, or so the resume offset is no longer a line start, re-parses in full', () => {
  const { path, ref } = incFixture();
  const src = createCodexSource({ projectId: 'proj', now: NOW, warn: () => {} });
  writeFileSync(path, MIXED);
  const { resume } = src.extractFrom!(ref, null);
  expect(resume).not.toBeNull();

  writeFileSync(path, ROLLOUT); // shorter
  const shrunk = src.extractFrom!(ref, resume);
  expect(shrunk.from).toBeNull();
  expect(shrunk.events).toEqual(src.extract(ref));

  writeFileSync(path, 'xyz' + MIXED); // shifted: the byte before the offset is no longer '\n'
  const shifted = src.extractFrom!(ref, resume);
  expect(shifted.from).toBeNull();
  expect(shifted.events).toEqual(src.extract(ref));
});

test('codex extractFrom: a resume point from another parser version is refused (full parse, so the driver guard runs)', () => {
  const { path, ref } = incFixture();
  const src = createCodexSource({ projectId: 'proj', now: NOW });
  writeFileSync(path, MIXED);
  const { resume } = src.extractFrom!(ref, null);
  const r = src.extractFrom!(ref, resume!.replace(/^v\d+:/, 'v0:'));
  expect(r.from).toBeNull();
  expect(r.events).toEqual(src.extract(ref));
});

test('codex extractFrom: a .zst rollout stays a full read with no resume point', () => {
  const { path } = zstFixture();
  const src = createCodexSource({ projectId: 'proj', now: NOW });
  const r = src.extractFrom!({ sessionId: UUID, path, marker: 'm', mtimeEpoch: 1 }, null);
  expect(r.from).toBeNull();
  expect(r.resume).toBeNull();
  expect(r.events).toHaveLength(2);
});

test('codex through the driver: incremental ticks enqueue exactly what full-extract ticks did', async () => {
  const bytes = Buffer.from(MIXED, 'utf8');
  const lineEnds = [...bytes.keys()].filter((i) => bytes[i] === 10).map((i) => i + 1);
  for (const cuts of [[lineEnds[3]!, lineEnds[6]!], [lineEnds[1]!, lineEnds[4]! + 7 /* mid-line */, lineEnds[9]!], [lineEnds[8]!]]) {
    const run = async (incremental: boolean) => {
      const { path, ref } = incFixture();
      // dir: the fixture's own, so available() does not depend on the host having ~/.codex/sessions.
      const real = createCodexSource({ projectId: 'proj', now: NOW, warn: () => {}, dir: dirname(path) });
      const { extractFrom: _dropped, ...fullOnly } = real;
      const src: CaptureSource = incremental ? { ...real } : fullOnly;
      const state = new CaptureState(join(mkdtempSync(join(tmpdir(), 'cm-cap-inc-')), 's.db'));
      state.ensureCutoff('codex', 0);
      const out: unknown[] = [];
      let prev = 0;
      for (const cut of [...cuts, bytes.length]) {
        appendFileSync(path, bytes.subarray(prev, cut));
        prev = cut;
        src.discover = () => [{ ...ref, marker: `m:${cut}` }];
        await runCaptureTick({ sources: [src], state, enqueue: (e) => out.push(e), now: NOW });
      }
      return { out, cursor: state.ingestedCursor('codex', UUID)! };
    };
    const full = await run(false);
    const inc = await run(true);
    expect(inc.out).toEqual(full.out);
    expect(inc.cursor.eventsIngested).toBe(full.cursor.eventsIngested);
    expect(inc.cursor.resume).not.toBeNull();
  }
});
