import { test, expect } from 'bun:test';
import { appendFileSync, mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGeminiSource } from './gemini-source.ts';
import { CaptureState } from './state.ts';
import { runCaptureTick } from './driver.ts';
import type { RawObservationEvent } from '../../shared/types.ts';
import type { CaptureSource, SessionRef } from './types.ts';

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

// ── .jsonl (gemini-cli 0.61+) ────────────────────────────────────────────────
const META = { sessionId: 'aaaa1111-2222-3333-4444-555566667777', projectHash: 'ph', startTime: '2026-09-30T10:00:00Z', lastUpdated: '2026-09-30T10:00:00Z' };
const u = (id: string, text: string, s: number) => ({ id, type: 'user', content: [{ text }], timestamp: `2026-09-30T10:00:${String(s).padStart(2, '0')}Z` });
const g = (id: string, text: string, s: number, toolCalls?: unknown[]) => ({ id, type: 'gemini', content: text, timestamp: `2026-09-30T10:00:${String(s).padStart(2, '0')}Z`, ...(toolCalls ? { toolCalls } : {}) });
const line = (r: unknown) => JSON.stringify(r) + '\n';

function jsonlFixture(records: unknown[]): { dir: string; chats: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cm-gemj-'));
  const chats = join(dir, 'hash1', 'chats');
  mkdirSync(chats, { recursive: true });
  const path = join(chats, 'session-2026-09-30T10-00-aaaa1111.jsonl');
  writeFileSync(path, records.map(line).join(''));
  return { dir, chats, path };
}
const extractAll = (path: string) => createGeminiSource({ projectId: 'proj' }).extract({ sessionId: 'aaaa1111', path, marker: 'm', mtimeEpoch: 1 });
const inputs = (path: string) => extractAll(path).map((e) => e.tool_input_summary);

test('gemini jsonl: append-only growth, Part-list user content, per-turn events with the full session id', () => {
  const { path } = jsonlFixture([META, u('u1', 'fix the bug', 1), g('g1', 'on it', 2), { $set: { lastUpdated: 'x' } }]);
  let ev = extractAll(path);
  expect(ev).toHaveLength(1);
  expect(ev[0]!.session_id).toBe(META.sessionId);
  expect(ev[0]!.tool_input_summary).toBe('fix the bug');
  expect(ev[0]!.tool_result_summary).toBe('assistant: on it');
  appendFileSync(path, line(u('u2', 'add a test', 3)) + line(g('g2', 'added', 4)));
  ev = extractAll(path);
  expect(ev.map((e) => [e.prompt_number, e.tool_input_summary])).toEqual([[1, 'fix the bug'], [2, 'add a test']]);
});

test('gemini jsonl: a re-appended id updates that message in place (tool calls added later)', () => {
  const { path } = jsonlFixture([META, u('u1', 'fix', 1), g('g1', '', 2, [{ name: 'run_shell', args: { command: 'ls' } }]), u('u2', 'next', 3),
    g('g1', 'done', 2, [{ name: 'run_shell', args: { command: 'ls' } }, { name: 'edit', args: {} }])]);
  const ev = extractAll(path);
  expect(ev.map((e) => e.tool_input_summary)).toEqual(['fix', 'next']); // g1 stays in turn 1, not moved after u2
  expect(ev[0]!.tool_result_summary).toContain('assistant: done');
  expect(ev[0]!.tool_result_summary).toContain('edit(');
  expect(ev[1]!.tool_result_summary).toBe('');
});

test('gemini jsonl: a functionResponse "user" message does not split the turn; thought parts are not text', () => {
  const { path } = jsonlFixture([META, u('u1', 'fix', 1), g('g1', '', 2, [{ id: 'c1', name: 'run_shell', args: {} }]),
    { id: 'r1', type: 'user', content: [{ functionResponse: { id: 'c1', name: 'run_shell', response: { output: 'ok' } } }], timestamp: '2026-09-30T10:00:03Z' },
    { id: 'g2', type: 'gemini', content: [{ text: 'thinking', thought: true }, { text: 'fixed' }], timestamp: '2026-09-30T10:00:04Z' }]);
  const ev = extractAll(path);
  expect(ev).toHaveLength(1);
  expect(ev[0]!.tool_result_summary).toBe('run_shell({})\nassistant: fixed');
});

test('gemini jsonl: $rewindTo drops that message and everything after it; an unknown id clears all', () => {
  const { path } = jsonlFixture([META, u('u1', 'one', 1), g('g1', 'a', 2), u('u2', 'two', 3), g('g2', 'b', 4), { $rewindTo: 'u2' }, u('u3', 'two again', 5)]);
  expect(inputs(path)).toEqual(['one', 'two again']);
  appendFileSync(path, line({ $rewindTo: 'nope' }) + line(u('u4', 'fresh', 6)));
  expect(inputs(path)).toEqual(['fresh']);
});

test('gemini jsonl: $set.messages replaces the whole list', () => {
  const { path } = jsonlFixture([META, u('u1', 'one', 1), g('g1', 'a', 2), { $set: { messages: [u('x1', 'compressed', 3), g('x2', 'summary', 4)] } }, u('u2', 'after', 5)]);
  expect(inputs(path)).toEqual(['compressed', 'after']);
});

test('gemini jsonl: malformed and blank lines are skipped', () => {
  const { path } = jsonlFixture([META, u('u1', 'one', 1)]);
  appendFileSync(path, '{"id":"broken", "ty\n\nnot json\n' + line(g('g1', 'a', 2)) + '{"truncated":');
  const ev = extractAll(path);
  expect(ev).toHaveLength(1);
  expect(ev[0]!.tool_result_summary).toBe('assistant: a');
});

test('gemini discover: a resumed session (.json + .jsonl copy) yields only the .jsonl, under the same id', () => {
  const { dir, chats, path } = jsonlFixture([META, u('u1', 'one', 1)]);
  const json = path.replace(/l$/, '');
  writeFileSync(json, JSON.stringify({ ...META, messages: [u('u1', 'one', 1)] }, null, 2));
  const other = join(chats, 'session-2026-09-01T09-00-bbbb2222.json');
  writeFileSync(other, JSON.stringify({ ...META, sessionId: 'bbbb2222-x', messages: [] }));
  const refs = createGeminiSource({ projectId: 'proj', dir, quiesceMs: 0, now: () => Date.now() + 10_000 }).discover();
  expect(refs.map((r) => r.path).sort()).toEqual([other, path]);
  expect(refs.find((r) => r.path === path)!.sessionId).toBe('aaaa1111');
  // the frozen .json stays skipped while its .jsonl is still active (not quiescent)
  const hourAgo = Date.now() / 1000 - 3600;
  utimesSync(json, hourAgo, hourAgo);
  utimesSync(other, hourAgo, hourAgo);
  const active = createGeminiSource({ projectId: 'proj', dir, quiesceMs: 60_000 }).discover();
  expect(active.map((r) => r.path)).toEqual([other]);
});

test('gemini driver: .json → resumed .jsonl → growth → rewind → rewind+regrow → $set rewrite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-gemd-'));
  const chats = join(dir, 'hash1', 'chats');
  mkdirSync(chats, { recursive: true });
  const json = join(chats, 'session-2026-09-30T10-00-aaaa1111.json');
  const jsonl = json + 'l';
  const state = new CaptureState(join(dir, 'state.db'));
  state.ensureCutoff('gemini', 100);
  const src = createGeminiSource({ projectId: 'proj', dir, quiesceMs: 0, now: () => Date.now() + 10_000 });
  const enq: RawObservationEvent[] = [];
  const tick = async () => {
    const n = enq.length;
    await runCaptureTick({ sources: [src], state, enqueue: (e) => enq.push(e) });
    return enq.slice(n).map((e) => `${e.prompt_number}:${e.tool_input_summary}`);
  };

  const old = [u('u1', 'one', 1), g('g1', 'a', 2), u('u2', 'two', 3), g('g2', 'b', 4)];
  writeFileSync(json, JSON.stringify({ ...META, messages: old }, null, 2));
  expect(await tick()).toEqual(['1:one', '2:two']);
  expect(await tick()).toEqual([]); // unchanged

  // resume: gemini copies the .json into <path>l and appends there; the copied turns are not re-ingested
  writeFileSync(jsonl, [META, ...old, { $set: { sessionId: META.sessionId } }, u('u3', 'three', 5), g('g3', 'c', 6)].map(line).join(''));
  expect(await tick()).toEqual(['3:three']);

  appendFileSync(jsonl, line(u('u4', 'four', 7)) + line(g('g4', 'd', 8)));
  expect(await tick()).toEqual(['4:four']);

  // pure rewind: shorter, the surviving turns are unchanged → nothing to enqueue
  appendFileSync(jsonl, line({ $rewindTo: 'u4' }));
  expect(await tick()).toEqual([]);

  // rewind + regrow to the same length: the replacement turn must not be hidden by the eventsIngested slice
  appendFileSync(jsonl, line({ $rewindTo: 'u3' }) + line(u('u5', 'three again', 9)) + line(g('g5', 'e', 10)));
  expect(await tick()).toEqual(['3:three again']);

  // $set.messages rewrites the history from the first turn: shorter AND changed → whole extract re-ingested
  appendFileSync(jsonl, line({ $set: { messages: [u('x1', 'compressed', 11)] } }));
  expect(await tick()).toEqual(['1:compressed']);

  appendFileSync(jsonl, 'garbage\n');
  expect(await tick()).toEqual([]);
});

test('gemini driver: a .jsonl gemini rewrote smaller with fewer turns is re-ingested whole (driver shorter-extract rule)', async () => {
  const { dir, path } = jsonlFixture([META, u('u1', 'one', 1), g('g1', 'a', 2), u('u2', 'two', 3), g('g2', 'b', 4), u('u3', 'three', 5)]);
  const state = new CaptureState(join(dir, 'state.db'));
  state.ensureCutoff('gemini', 100);
  const src = createGeminiSource({ projectId: 'proj', dir, quiesceMs: 0, now: () => Date.now() + 10_000 });
  const enq: RawObservationEvent[] = [];
  await runCaptureTick({ sources: [src], state, enqueue: (e) => enq.push(e) });
  expect(enq).toHaveLength(3);
  writeFileSync(path, [META, u('u1', 'one', 1), g('g1', 'a', 2)].map(line).join('')); // rewriteConversationFile
  await runCaptureTick({ sources: [src], state, enqueue: (e) => enq.push(e) });
  expect(enq.slice(3).map((e) => e.tool_input_summary)).toEqual(['one']);
});

// ── incremental .jsonl (extractFrom) ──────────────────────────────────────────
const SID8 = 'aaaa1111';
const incRef = (path: string, mtimeEpoch = 1): SessionRef => ({ sessionId: SID8, path, marker: 'm', mtimeEpoch });
// Every shape the reader handles: Part-list and multibyte user prompts, thought parts, tool calls, a functionResponse
// "user" message, an in-turn update (g1 re-appended with more tool calls), a tokens-only re-append, info messages,
// metadata $set, blank and garbage lines.
const MIXED = [
  line(META),
  line(u('u1', 'fix the bug ✓ ünïcödé 日本語 🚀', 1)),
  line({ id: 'g1', type: 'gemini', content: [{ text: 'thinking… 🤔', thought: true }, { text: 'on it' }], timestamp: '2026-09-30T10:00:02Z', toolCalls: [{ id: 'c1', name: 'run_shell', args: { command: 'grep 🐛' } }] }),
  line({ $set: { lastUpdated: '2026-09-30T10:00:02Z' } }),
  line({ id: 'r1', type: 'user', content: [{ functionResponse: { id: 'c1', name: 'run_shell', response: { output: 'ok ✓' } } }], timestamp: '2026-09-30T10:00:03Z' }),
  line({ id: 'g1', type: 'gemini', content: [{ text: 'thinking… 🤔', thought: true }, { text: 'on it' }], timestamp: '2026-09-30T10:00:02Z', toolCalls: [{ id: 'c1', name: 'run_shell', args: { command: 'grep 🐛' } }, { id: 'c2', name: 'edit', args: { file: 'ä.ts' } }] }),
  line(g('g2', 'fixed ✓', 4)),
  line({ id: 'i1', type: 'info', content: 'noise' }),
  '\n',
  line(u('u2', 'add a test ☃', 5)),
  line(g('g3', 'added 测试', 6)),
  line({ ...g('g3', 'added 测试', 6), tokens: { input: 1, output: 2 } }), // recordMessageTokens: same event
  'not json at all\n',
  line({ $set: { lastUpdated: '2026-09-30T10:00:06Z' } }),
  line(u('u3', 'third ⚡ prompt', 7)),
  line(g('g4', '', 8, [{ name: 'read_file', args: { path: '/tmp/ñ' } }])),
  line(g('g5', 'done 👍', 9)),
].join('');

function incFixture(): { dir: string; path: string } {
  const { dir, path } = jsonlFixture([]);
  writeFileSync(path, '');
  return { dir, path };
}
const resumeEvents = (resume: string) => (JSON.parse(resume) as { events: number }).events;

test('gemini extractFrom: incremental == full extract at EVERY byte split of a mixed .jsonl', () => {
  const bytes = Buffer.from(MIXED, 'utf8');
  const { dir, path } = incFixture();
  const src = createGeminiSource({ projectId: 'proj', dir });
  writeFileSync(path, bytes);
  const whole = src.extract(incRef(path));
  expect(whole.map((e) => e.prompt_number)).toEqual([1, 2, 3]);
  expect(whole[0]!.tool_result_summary).toContain('edit(');
  let resumed = 0;
  for (let cut = 0; cut <= bytes.length; cut++) {
    writeFileSync(path, bytes.subarray(0, cut));
    const pre = src.extract(incRef(path));
    const first = src.extractFrom!(incRef(path), null);
    expect(first.from).toBeNull();
    expect(first.events).toEqual(pre);
    writeFileSync(path, bytes);
    const r = src.extractFrom!(incRef(path), first.resume);
    expect(r.events).toEqual(whole.slice(r.from ?? 0));
    // It resumed exactly when it should: there was a resume point and the open turn's event is unchanged.
    const at = first.resume ? resumeEvents(first.resume) : null;
    const openSame = at !== null && (pre[at] === undefined || JSON.stringify(pre[at]) === JSON.stringify(whole[at]));
    expect(r.from).toBe(openSame ? at : null);
    if (r.from !== null) resumed++;
    // and the resume point it returned is good for the next growth
    if (r.resume) expect(src.extractFrom!(incRef(path), r.resume)).toEqual({ events: whole.slice(resumeEvents(r.resume)), from: resumeEvents(r.resume), resume: r.resume });
  }
  expect(resumed).toBeGreaterThan(bytes.length / 5); // the cuts after which the open turn's event does not change
});

test('gemini extractFrom: chained line-by-line growth matches the full extract at every step', () => {
  const { dir, path } = incFixture();
  const src = createGeminiSource({ projectId: 'proj', dir });
  let resume: string | null = null;
  let resumed = 0;
  for (const rec of MIXED.split(/(?<=\n)/)) {
    appendFileSync(path, rec);
    const r = src.extractFrom!(incRef(path), resume);
    expect(r.events).toEqual(src.extract(incRef(path)).slice(r.from ?? 0));
    if (r.from !== null) resumed++;
    resume = r.resume;
  }
  expect(resumed).toBeGreaterThan(8);
});

test('gemini extractFrom: anything that changes history before the resume point parses in full (from=null)', () => {
  const base = [META, u('u1', 'one', 1), g('g1', 'a', 2), u('u2', 'two', 3), g('g2', 'b', 4), u('u3', 'three', 5), g('g3', 'c', 6)].map(line).join('');
  const same = (x: string) => x;
  const grow = (p: string) => appendFileSync(p, line(u('u4', 'four', 8)));
  const cases: Array<[string, (path: string) => void, (resume: string) => string]> = [
    ['$rewindTo', (p) => appendFileSync(p, line({ $rewindTo: 'u2' }) + line(u('u9', 'two again', 7))), same],
    ['$rewindTo inside the open turn', (p) => appendFileSync(p, line({ $rewindTo: 'g3' })), same],
    ['$set.messages', (p) => appendFileSync(p, line({ $set: { messages: [u('x1', 'compressed', 7)] } })), same],
    ['$set renaming the session', (p) => appendFileSync(p, line({ $set: { sessionId: 'other' } })), same],
    ['a metadata record', (p) => appendFileSync(p, line({ ...META, messages: [g('g1', 'meta-updated', 2)] })), same],
    ['update of a closed-turn id', (p) => appendFileSync(p, line(g('g1', 'rewritten', 2)) + line(u('u4', 'four', 8))), same],
    ['the open turn no longer opens on its prompt', (p) => appendFileSync(p, line({ id: 'u3', type: 'user', content: [{ functionResponse: { id: 'z' } }] })), same],
    ['the open turn changed', (p) => appendFileSync(p, line(g('g3', 'c, then more', 6))), same],
    ['shrink', (p) => writeFileSync(p, base.slice(0, base.indexOf('"u2"'))), same],
    ['prefix rewrite, byte before the offset still a newline', (p) => writeFileSync(p, base.replace('"b"', '"z"') + line(u('u4', 'four', 8))), same],
    ['version mismatch', grow, (x) => JSON.stringify({ ...JSON.parse(x), v: 0 })],
    ['malformed resume', grow, (x) => x.slice(0, -3)],
    ['malformed closed set', grow, (x) => JSON.stringify({ ...JSON.parse(x), closed: 'AAA' })],
  ];
  for (const [name, change, tamper] of cases) {
    const { dir, path } = incFixture();
    writeFileSync(path, base);
    const src = createGeminiSource({ projectId: 'proj', dir });
    const first = src.extractFrom!(incRef(path), null);
    expect(resumeEvents(first.resume!)).toBe(2);
    change(path);
    const r = src.extractFrom!(incRef(path), tamper(first.resume!));
    if (r.from !== null) throw new Error(`${name}: resumed at ${r.from}`);
    expect(r.events).toEqual(src.extract(incRef(path)));
  }
  // control: plain growth plus an in-turn tokens-only re-append resumes
  const { dir, path } = incFixture();
  writeFileSync(path, base);
  const src = createGeminiSource({ projectId: 'proj', dir });
  const first = src.extractFrom!(incRef(path), null);
  appendFileSync(path, line({ ...g('g3', 'c', 6), tokens: { total: 3 } }) + line(u('u4', 'four', 8)));
  const r = src.extractFrom!(incRef(path), first.resume);
  expect(r.from).toBe(2);
  expect(r.events).toEqual(src.extract(incRef(path)).slice(2));
});

test('gemini extractFrom: a closed-turn update applied before the resume point is replayed over, not a fallback', () => {
  // g1 (turn 1) re-appended after u2 opened turn 2: that update lies inside the replayed bytes and is skipped.
  const { dir, path } = incFixture();
  writeFileSync(path, [META, u('u1', 'fix', 1), g('g1', '', 2), u('u2', 'next', 3), g('g1', 'done', 2, [{ name: 'edit', args: {} }])].map(line).join(''));
  const src = createGeminiSource({ projectId: 'proj', dir });
  const first = src.extractFrom!(incRef(path), null);
  appendFileSync(path, line(u('u3', 'third', 5)) + line(g('g2', 'ok', 6)));
  const r = src.extractFrom!(incRef(path), first.resume);
  expect(r.from).toBe(1);
  expect(r.events).toEqual(src.extract(incRef(path)).slice(1));
});

test('gemini extractFrom: a .json session is a full read with no resume point', () => {
  const { path } = fixture();
  const src = createGeminiSource({ projectId: 'proj' });
  expect(src.extractFrom!(incRef(path), null)).toEqual({ events: src.extract(incRef(path)), from: null, resume: null });
});

test('gemini through the driver: incremental ticks enqueue exactly what full-extract ticks do', async () => {
  const steps: unknown[][] = [
    [META, u('u1', 'one ✓', 1), g('g1', '', 2, [{ id: 'c1', name: 'run_shell', args: {} }])],
    [{ id: 'r1', type: 'user', content: [{ functionResponse: { id: 'c1' } }], timestamp: '2026-09-30T10:00:03Z' }],
    [g('g1', 'a', 2, [{ id: 'c1', name: 'run_shell', args: {} }, { id: 'c2', name: 'edit', args: {} }]), g('g2', 'b', 4)], // in-turn update
    [u('u2', 'two', 5), g('g3', 'c', 6)],
    [{ ...g('g3', 'c', 6), tokens: { total: 1 } }, u('u3', 'three 日本', 7), g('g4', 'd', 8)],
    [u('u4', 'four', 9)],
    [g('g5', 'e', 10), { $rewindTo: 'u3' }, u('u5', 'three again', 11), g('g6', 'f', 12)], // rewind + regrow
    [u('u6', 'six', 13), g('g7', 'g', 14)],
    [g('g1', 'a, revised', 2), u('u7', 'seven', 15)], // closed-turn update
    [g('g8', 'h', 16), u('u8', 'eight', 17)],
    [{ $set: { messages: [u('x1', 'compressed', 18)] } }, g('x2', 'i', 19)],
    [u('u9', 'nine', 20)],
  ];
  const run = async (incremental: boolean) => {
    const { dir, path } = incFixture();
    // real discover(): its `mtime:size:jsonl` marker is what eventCountAtMarker reads on the full-parse path
    const real = createGeminiSource({ projectId: 'proj', dir, quiesceMs: 0, now: () => Date.now() + 10_000 });
    const { extractFrom, ...fullOnly } = real;
    let resumed = 0;
    const src: CaptureSource = incremental
      ? { ...real, extractFrom: (ref, resume) => { const r = extractFrom!(ref, resume); if (r.from !== null) resumed++; return r; } }
      : fullOnly;
    const state = new CaptureState(join(dir, 'state.db'));
    state.ensureCutoff('gemini', 100);
    const out: string[][] = [];
    for (const recs of steps) {
      appendFileSync(path, recs.map(line).join(''));
      const got: RawObservationEvent[] = [];
      await runCaptureTick({ sources: [src], state, enqueue: (e) => got.push(e) });
      out.push(got.map((e) => JSON.stringify(e)));
    }
    return { out, resumed, cursor: state.ingestedCursor('gemini', SID8)! };
  };
  const full = await run(false);
  const inc = await run(true);
  expect(inc.out).toEqual(full.out);
  expect(inc.cursor.eventsIngested).toBe(full.cursor.eventsIngested);
  expect(inc.resumed).toBeGreaterThanOrEqual(4);
  expect(full.out.map((t) => t.map((s) => { const e = JSON.parse(s) as RawObservationEvent; return `${e.prompt_number}:${e.tool_input_summary}`; }))).toEqual([
    ['1:one ✓'], [], ['1:one ✓'], ['2:two'], ['3:three 日本'], ['4:four'], ['3:three again'], ['4:six'],
    ['1:one ✓', '2:two', '3:three again', '4:six', '5:seven'], // closed-turn update: re-enqueued from the changed turn
    ['5:seven', '6:eight'], ['1:compressed'], ['2:nine'],
  ]);
});
