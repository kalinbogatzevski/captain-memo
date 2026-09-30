import { test, expect } from 'bun:test';
import { appendFileSync, mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createKimiSource } from './kimi-source.ts';
import { CaptureState } from './state.ts';
import { runCaptureTick } from './driver.ts';
import type { CaptureSource } from './types.ts';

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

// ---- incremental extract: extractFrom(ref, resume) must equal the full extract's tail, exactly ----

// Every shape kimi writes (kimi_cli/soul/context.py): system prompt, checkpoints, _usage, a list content, a tool
// line before any user line, a turn with nothing in it (dropped), blank + malformed lines, multibyte text.
const MIXED = [
  JSON.stringify({ role: '_system_prompt', content: 'You are Kimi…' }),
  JSON.stringify({ role: 'tool', content: 'pre-prompt tool output' }),
  JSON.stringify({ role: '_checkpoint', id: 0 }),
  JSON.stringify({ role: 'user', content: 'first ünïcode 日本語' }),
  JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'looking' }], tool_calls: [{ id: 't1' }] }),
  JSON.stringify({ role: 'tool', content: 'read a.ts', tool_call_id: 't1' }),
  JSON.stringify({ role: '_usage', token_count: 1234 }),
  '',
  JSON.stringify({ role: '_checkpoint', id: 1 }),
  JSON.stringify({ role: 'user', content: '' }),
  '{not json',
  JSON.stringify({ role: '_checkpoint', id: 2 }),
  JSON.stringify({ role: 'user', content: 'second' }),
  JSON.stringify({ role: 'assistant', content: 'two ✓' }),
  JSON.stringify({ role: '_usage', token_count: 2345 }),
  JSON.stringify({ role: '_checkpoint', id: 3 }),
  JSON.stringify({ role: 'user', content: 'third' }),
  JSON.stringify({ role: 'assistant', content: 'three' }),
].map((l) => l + '\n').join('');

const UUIDK = 'e952f7ca-8b38-4c74-9b0a-12969e216bd8';
function incFixture(): { dir: string; path: string; ref: (mtimeEpoch: number) => { sessionId: string; path: string; marker: string; mtimeEpoch: number } } {
  const dir = mkdtempSync(join(tmpdir(), 'cm-kimi-inc-'));
  const sdir = join(dir, 'hashabc', UUIDK);
  mkdirSync(sdir, { recursive: true });
  const path = join(sdir, 'context.jsonl');
  return { dir, path, ref: (mtimeEpoch) => ({ sessionId: UUIDK, path, marker: 'm', mtimeEpoch }) };
}

test('kimi extractFrom: at EVERY byte split (mid-line, mid-turn, mid-multibyte) the resumed tail equals the full extract', () => {
  const bytes = Buffer.from(MIXED, 'utf8');
  const { dir, path, ref } = incFixture();
  const src = createKimiSource({ projectId: 'proj', dir });
  writeFileSync(path, bytes);
  // mtime changes on every append and kimi events take it as ts_epoch: a resumed parse must use the NEW one.
  const full = src.extract(ref(200));
  expect(full.map((e) => e.prompt_number)).toEqual([1, 2, 4, 5]); // turn 3 (empty user, no parts) is dropped
  let resumedSplits = 0;

  for (let cut = 0; cut <= bytes.length; cut++) {
    writeFileSync(path, bytes.subarray(0, cut));
    const first = src.extractFrom!(ref(100), null);
    expect(first.from).toBeNull();
    expect(first.events).toEqual(src.extract(ref(100)));
    appendFileSync(path, bytes.subarray(cut));
    const next = src.extractFrom!(ref(200), first.resume);
    if (first.resume) { expect(next.from).not.toBeNull(); resumedSplits++; }
    expect(next.events).toEqual(full.slice(next.from ?? 0));
    const again = src.extractFrom!(ref(200), next.resume);
    expect(again.events).toEqual(full.slice(again.from ?? 0));
  }
  expect(resumedSplits).toBeGreaterThan(bytes.length / 2);
});

test('kimi extractFrom: shrink, a prepended system prompt that keeps the offset on a line start, and rotate-and-regrow all re-parse in full', () => {
  const { dir, path, ref } = incFixture();
  const src = createKimiSource({ projectId: 'proj', dir });
  writeFileSync(path, MIXED);
  const { resume } = src.extractFrom!(ref(1), null);
  const offset = Number(resume!.split(':')[2]);
  expect(offset).toBeGreaterThan(0);

  writeFileSync(path, MIXED.slice(0, 40)); // shorter
  const shrunk = src.extractFrom!(ref(1), resume);
  expect(shrunk.from).toBeNull();
  expect(shrunk.events).toEqual(src.extract(ref(1)));

  // write_system_prompt on a legacy file: a line prepended through tmp+rename. Sized to the line just before the
  // offset (or the lines, if one is too short for a prompt), so the byte before the offset is STILL a newline and
  // a newline check alone would resume mid-file.
  const bytes = Buffer.from(MIXED, 'utf8');
  const stubLen = JSON.stringify({ role: '_system_prompt', content: '' }).length + 1;
  let lineStart = offset;
  while (offset - lineStart < stubLen) lineStart = bytes.lastIndexOf(10, lineStart - 2) + 1;
  const len = offset - lineStart;
  const prompt = JSON.stringify({ role: '_system_prompt', content: 'x'.repeat(len - stubLen) }) + '\n';
  expect(Buffer.byteLength(prompt)).toBe(len);
  writeFileSync(path + '.tmp', prompt + MIXED);
  renameSync(path + '.tmp', path);
  expect(Buffer.from(prompt + MIXED)[offset - 1]).toBe(10);
  const shifted = src.extractFrom!(ref(1), resume);
  expect(shifted.from).toBeNull();
  expect(shifted.events).toEqual(src.extract(ref(1)));

  // revert_to/clear: rotated, restarted, and grown past the old size before capture looked again.
  writeFileSync(path, MIXED.split('\n').slice(0, 4).join('\n') + '\n' + JSON.stringify({ role: 'user', content: 'y'.repeat(bytes.length) }) + '\n');
  const rotated = src.extractFrom!(ref(1), resume);
  expect(rotated.from).toBeNull();
  expect(rotated.events).toEqual(src.extract(ref(1)));
});

test('kimi extractFrom: a resume point from another parser version, or malformed, is refused (full parse)', () => {
  const { dir, path, ref } = incFixture();
  const src = createKimiSource({ projectId: 'proj', dir });
  writeFileSync(path, MIXED);
  const { resume } = src.extractFrom!(ref(1), null);
  for (const bad of [resume!.replace(/^v\d+:/, 'v0:'), 'garbage', resume!.split(':').slice(0, 5).join(':')]) {
    const r = src.extractFrom!(ref(1), bad);
    expect(r.from).toBeNull();
    expect(r.events).toEqual(src.extract(ref(1)));
  }
});

test('kimi through the driver: incremental ticks enqueue exactly what full-extract ticks did', async () => {
  const bytes = Buffer.from(MIXED, 'utf8');
  const lineEnds = [...bytes.keys()].filter((i) => bytes[i] === 10).map((i) => i + 1);
  for (const cuts of [[lineEnds[3]!, lineEnds[9]!], [lineEnds[1]!, lineEnds[4]! + 7 /* mid-line */, lineEnds[13]!], [lineEnds[12]! + 3, lineEnds[15]!]]) {
    const run = async (incremental: boolean) => {
      const { dir, path, ref } = incFixture();
      // dir: the fixture's own, so available() does not depend on the host having ~/.kimi/sessions.
      const real = createKimiSource({ projectId: 'proj', dir });
      const { extractFrom: _dropped, ...fullOnly } = real;
      const src: CaptureSource = incremental ? { ...real } : fullOnly;
      const state = new CaptureState(join(mkdtempSync(join(tmpdir(), 'cm-cap-kimi-')), 's.db'));
      state.ensureCutoff('kimi', 0);
      const out: unknown[] = [];
      let prev = 0;
      for (const cut of [...cuts, bytes.length]) {
        appendFileSync(path, bytes.subarray(prev, cut));
        prev = cut;
        src.discover = () => [{ ...ref(1000 + cut), marker: `m:${cut}` }]; // mtime moves with every growth
        await runCaptureTick({ sources: [src], state, enqueue: (e) => out.push(e), now: () => 1_900_000_000_000 });
      }
      return { out, cursor: state.ingestedCursor('kimi', UUIDK)! };
    };
    const full = await run(false);
    const inc = await run(true);
    expect(inc.out.length).toBeGreaterThan(0);
    expect(inc.out).toEqual(full.out);
    expect(inc.cursor.eventsIngested).toBe(full.cursor.eventsIngested);
    expect(inc.cursor.resume).not.toBeNull();
  }
});
