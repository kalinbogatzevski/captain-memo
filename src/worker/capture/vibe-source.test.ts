import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import type { RawObservationEvent } from '../../shared/types.ts';
import { CaptureState } from './state.ts';
import { runCaptureTick } from './driver.ts';
import { createVibeSource } from './vibe-source.ts';
import { assistantMsg, effectEntry, reasoningEntry, userMsg, writeVibeSession } from '../../../tests/support/vibe-store-fixture.ts';

const roots: string[] = [];
const states: CaptureState[] = [];
const root = (): string => { const r = mkdtempSync(join(tmpdir(), 'cm-vibe-src-')); roots.push(r); return r; };
afterAll(() => {
  for (const s of states) { try { s.close(); } catch { /* best-effort */ } }
  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort (a db handle on Windows) */ } }
});

const BASE = 1_790_000_000; // epoch seconds
const ref = (id: string, dir: string) => ({ sessionId: id, path: join(dir, 'unified', id), marker: 'm', mtimeEpoch: BASE });

// ---- configuration ----

test("the test preload clears VIBE_HOME, so a developer's real Vibe sessions never leak into a test", () => {
  expect(process.env.VIBE_HOME).toBeUndefined();
});

test('enabled: on by default, off with CAPTAIN_MEMO_CAPTURE_VIBE=0', () => {
  const on = (env: Record<string, string>) => createVibeSource({ projectId: 'p', env }).enabled();
  expect(on({})).toBe(true);
  expect(on({ CAPTAIN_MEMO_CAPTURE_VIBE: '1' })).toBe(true);
  expect(on({ CAPTAIN_MEMO_CAPTURE_VIBE: '0' })).toBe(false);
});

const watched = (env: Record<string, string>, dir?: string) => createVibeSource({ projectId: 'p', env, ...(dir ? { dir } : {}) }).describe();
const tail = join('logs', 'session', 'unified');

test('the watched folder: ~/.vibe/logs/session/unified by default, an empty VIBE_HOME counting as unset', () => {
  expect(watched({})).toBe(join(homedir(), '.vibe', tail));
  expect(watched({ VIBE_HOME: '' })).toBe(join(homedir(), '.vibe', tail));
});

test('the watched folder: $VIBE_HOME, made absolute like Vibe does', () => {
  expect(watched({ VIBE_HOME: join(tmpdir(), 'vh') })).toBe(join(tmpdir(), 'vh', tail));
  expect(watched({ VIBE_HOME: 'relative-vibe' })).toBe(join(resolve('relative-vibe'), tail));
});

test('the watched folder: a ~ in $VIBE_HOME is the home directory', () => {
  expect(watched({ VIBE_HOME: '~/custom-vibe' })).toBe(join(homedir(), 'custom-vibe', tail));
});

test('the watched folder: CAPTAIN_MEMO_CAPTURE_VIBE_DIR (the folder that holds unified/) beats VIBE_HOME', () => {
  expect(watched({ VIBE_HOME: join(tmpdir(), 'vh'), CAPTAIN_MEMO_CAPTURE_VIBE_DIR: join(tmpdir(), 'custom-root') })).toBe(join(tmpdir(), 'custom-root', 'unified'));
});

test('available: true once <root>/unified exists, however it is reached', () => {
  const r = root();
  const src = createVibeSource({ projectId: 'p', dir: r });
  expect(src.available()).toBe(false);
  mkdirSync(join(r, 'unified'));
  expect(src.available()).toBe(true);
});

// ---- discover ----

const CLOCK_MS = (BASE + 1000) * 1000;
const listed = (r: string) => createVibeSource({ projectId: 'p', dir: r, now: () => CLOCK_MS }).discover();

test('discover: a finished session is listed with its folder, CURRENT\'s mtime and the manifest hash as marker', () => {
  const r = root();
  const dir = writeVibeSession(r, 'good', { chunks: [[userMsg('q'), assistantMsg('a')]], mtimeSec: BASE });
  const [one, ...rest] = listed(r);
  expect(rest).toEqual([]);
  expect(one).toMatchObject({ sessionId: 'good', path: dir, mtimeEpoch: BASE });
  expect(one!.marker).toMatch(/^[0-9a-f]{64}$/);
});

test('discover: the marker moves with each published generation, and so does mtimeEpoch', () => {
  const r = root();
  writeVibeSession(r, 'good', { chunks: [[userMsg('q'), assistantMsg('a')]], mtimeSec: BASE });
  const first = listed(r)[0]!;
  writeVibeSession(r, 'good', { generation: 2, chunks: [[userMsg('q'), assistantMsg('a'), userMsg('q2')]], mtimeSec: BASE + 10 });
  const second = listed(r)[0]!;
  expect(second.marker).not.toBe(first.marker);
  expect(second.mtimeEpoch).toBe(BASE + 10);
});

test('discover: a session still inside the quiesce window is not listed', () => {
  const r = root();
  writeVibeSession(r, 'fresh', { chunks: [[userMsg('q')]], mtimeSec: BASE + 990 }); // 10 s old: still being written
  expect(listed(r)).toEqual([]);
});

test('discover: a torn CURRENT is not listed (the next tick sees the whole file)', () => {
  const r = root();
  writeVibeSession(r, 'torn', { chunks: [[userMsg('q')]], mtimeSec: BASE });
  writeFileSync(join(r, 'unified', 'torn', 'CURRENT'), '{"generation":"00000');
  utimesSync(join(r, 'unified', 'torn', 'CURRENT'), BASE, BASE); // old enough, so only the tear keeps it out
  expect(listed(r)).toEqual([]);
});

test('discover: a CURRENT with an unexpected shape is reported once across ticks (folder name and error only), a good session is still listed', () => {
  const r = root();
  writeVibeSession(r, 'good', { chunks: [[userMsg('q')]], mtimeSec: BASE });
  writeVibeSession(r, 'drifted', { chunks: [[userMsg('q')]], mtimeSec: BASE });
  const cur = join(r, 'unified', 'drifted', 'CURRENT');
  writeFileSync(cur, JSON.stringify({ generation: '0000000000000001', manifest_hash: 'a'.repeat(64), note: 'PRIVATE-TEXT' })); // valid JSON, key renamed
  utimesSync(cur, BASE, BASE);
  const warns: string[] = [];
  const src = createVibeSource({ projectId: 'p', dir: r, now: () => CLOCK_MS, warn: (m) => warns.push(m) });
  for (let tick = 0; tick < 2; tick++) expect(src.discover().map((s) => s.sessionId)).toEqual(['good']);
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain('drifted');
  expect(warns[0]).toContain('unexpected shape');
  expect(warns[0]).not.toMatch(/good|PRIVATE-TEXT|manifest_hash/);
});

test('discover: Vibe\'s dotfile index, a hidden folder, loose files, a folder with no CURRENT and the pre-2.26 session_* folders are not sessions', () => {
  const r = root();
  writeVibeSession(r, 'good', { chunks: [[userMsg('q')]], mtimeSec: BASE });
  mkdirSync(join(r, 'unified', 'nocurrent'));                                                // a folder with nothing published
  writeFileSync(join(r, 'unified', '.session-index.json'), '{}');
  writeFileSync(join(r, 'unified', 'stray.txt'), 'x');
  writeVibeSession(r, '.hidden', { chunks: [[userMsg('q')]], mtimeSec: BASE });                // a hidden folder is not one of Vibe's session ids
  mkdirSync(join(r, 'session_20260101_000000_abcd1234'));                                    // the pre-2.26 layout, one level up
  writeFileSync(join(r, 'session_20260101_000000_abcd1234', 'messages.jsonl'), '{"role":"user"}\n');
  expect(listed(r).map((x) => x.sessionId)).toEqual(['good']);
});

test.skipIf(process.platform === 'win32')('discover: a symlinked session folder is not followed', () => {
  const r = root();
  writeVibeSession(r, 'good', { chunks: [[userMsg('q')]], mtimeSec: BASE });
  symlinkSync(join(r, 'unified', 'good'), join(r, 'unified', 'linked'));
  expect(listed(r).map((x) => x.sessionId)).toEqual(['good']);
});

test('discover: the quiesce window is CAPTAIN_MEMO_CAPTURE_QUIESCE_MS', () => {
  const r = root();
  writeVibeSession(r, 's', { chunks: [[userMsg('q')]], mtimeSec: BASE });
  const at = (quiesce: string, nowSec: number) => createVibeSource({ projectId: 'p', dir: r, env: { CAPTAIN_MEMO_CAPTURE_QUIESCE_MS: quiesce }, now: () => nowSec * 1000 }).discover().length;
  expect(at('5000', BASE + 4)).toBe(0);
  expect(at('5000', BASE + 6)).toBe(1);
});

test('discover: a folder that does not exist yet lists nothing and does not throw', () => {
  expect(createVibeSource({ projectId: 'p', dir: join(root(), 'nope') }).discover()).toEqual([]);
});

// ---- extract ----

test('extract: one event per user turn, stamped vibe; the user text, the assistant text and the tool call, nothing else', () => {
  const r = root();
  writeVibeSession(r, 'sess-1', {
    chunks: [[
      userMsg('first question', 1_785_000_100_000),
      reasoningEntry('PRIVATE-THOUGHT', 1_785_000_101_000),
      effectEntry('mcp_placeholder.search', { query: 'abc' }, 'completed', 'PRIVATE-TOOL-OUTPUT', 1_785_000_102_000),
      assistantMsg('first answer', 1_785_000_103_000),
      userMsg('second question', 1_785_000_200_000),
      assistantMsg('second answer', 1_785_000_203_000),
    ]],
  });
  const events = createVibeSource({ projectId: 'proj', dir: r }).extract(ref('sess-1', r));
  expect(events).toHaveLength(2);
  expect(events.every((e) => e.origin_agent === 'vibe' && e.tool_name === 'vibe-turn' && e.source === 'capture:vibe' && e.session_id === 'sess-1' && e.project_id === 'proj')).toBe(true);
  expect(events.map((e) => e.prompt_number)).toEqual([1, 2]);
  expect(events.map((e) => e.ts_epoch)).toEqual([1_785_000_100, 1_785_000_200]);
  expect(events[0]!.tool_input_summary).toBe('first question');
  expect(events[0]!.tool_result_summary).toBe('mcp_placeholder.search({"query":"abc"})\nassistant: first answer');
  expect(events[1]!.tool_result_summary).toBe('assistant: second answer');
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE/);
});

test('extract: a session with nothing captured yet gives no events and does not throw', () => {
  const r = root();
  writeVibeSession(r, 'empty', { chunks: [] });
  writeVibeSession(r, 'only-reasoning', { chunks: [[reasoningEntry('t')]] });
  const src = createVibeSource({ projectId: 'p', dir: r });
  expect(src.extract(ref('empty', r))).toEqual([]);
  expect(src.extract(ref('only-reasoning', r))).toEqual([]);
});

test('extract: forks, subagents and imported histories are skipped; an unreadable meta.json or chunk throws so the driver retries', () => {
  const r = root();
  const chunks = [[userMsg('q'), assistantMsg('a')]];
  writeVibeSession(r, 'fork', { chunks, meta: { parent_session_id: 'placeholder-parent' } });
  writeVibeSession(r, 'imported', { chunks, meta: { import_provenance: { source: 'placeholder' } } });
  writeVibeSession(r, 'root', { chunks });
  writeVibeSession(r, 'torn-meta', { chunks, meta: 'torn' });
  const gone = writeVibeSession(r, 'gone-chunk', { chunks: [[userMsg('different chunk'), assistantMsg('a')]] }); // not the cached chunk of 'root'
  unlinkSync(join(gone, 'chunks', readdirSync(join(gone, 'chunks'))[0]!));
  const src = createVibeSource({ projectId: 'p', dir: r });
  expect(src.extract(ref('fork', r))).toEqual([]);
  expect(src.extract(ref('imported', r))).toEqual([]);
  expect(src.extract(ref('root', r))).toHaveLength(1);
  expect(() => src.extract(ref('torn-meta', r))).toThrow('vibe meta.json');
  expect(() => src.extract(ref('gone-chunk', r))).toThrow('vibe chunk');
});

test('extract: a store newer than the tested one is read anyway and reported once, with its format and minor only', () => {
  const r = root();
  writeVibeSession(r, 'm8', { minor: 8, chunks: [[userMsg('q')]] });
  writeVibeSession(r, 'm9', { minor: 9, chunks: [[userMsg('q')]] });
  writeVibeSession(r, 'm99a', { minor: 99, chunks: [[userMsg('q')]] });
  writeVibeSession(r, 'm99b', { minor: 99, chunks: [[userMsg('q')]] });
  const warns: string[] = [];
  const src = createVibeSource({ projectId: 'p', dir: r, warn: (m) => warns.push(m) });
  for (const id of ['m8', 'm9']) expect(src.extract(ref(id, r))).toHaveLength(1);
  expect(warns).toEqual([]);
  for (const id of ['m99a', 'm99b']) expect(src.extract(ref(id, r))).toHaveLength(1);
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain('mistral.vibe.unified-session-store/v1/99');
  expect(warns[0]).not.toMatch(/placeholder|m99/);
});

// ---- through the driver ----

function harness() {
  const r = root();
  const state = new CaptureState(join(r, 'state.db'));
  states.push(state);
  mkdirSync(join(r, 'unified')); // the driver seeds a source's cutoff on the first tick it is available
  const out: RawObservationEvent[] = [];
  const logs: string[] = [];
  let clockMs = (BASE + 1000) * 1000;
  const src = createVibeSource({ projectId: 'proj', dir: r, now: () => clockMs, warn: () => {} });
  const tick = (ignoreCutoff = false) => runCaptureTick({ sources: [src], state, enqueue: (e) => out.push(e), now: () => clockMs, log: (m) => logs.push(m), ignoreCutoff });
  const advance = (sec: number) => { clockMs += sec * 1000; };
  return { r, state, out, logs, tick, advance };
}

test('through the driver: the first tick seeds the cutoff and skips old sessions, a new turn enqueues ONLY itself, backfill pulls the old one in', async () => {
  const h = harness();
  writeVibeSession(h.r, 'old', { chunks: [[userMsg('old q'), assistantMsg('old a')]], mtimeSec: BASE });
  await h.tick(); // seeds the cutoff at BASE+1000
  expect(h.out).toEqual([]);

  h.advance(120);
  const q1 = [userMsg('q1'), assistantMsg('a1')];
  writeVibeSession(h.r, 'new', { generation: 1, chunks: [q1], mtimeSec: BASE + 1050 });
  await h.tick();
  expect(h.out.map((e) => e.tool_input_summary)).toEqual(['q1']);

  // The session grows by one turn: a new generation, a new marker. The N(N+1)/2 guard: only turn 2 is enqueued.
  const q2 = [userMsg('q2'), assistantMsg('a2')];
  writeVibeSession(h.r, 'new', { generation: 2, chunks: [[...q1, ...q2]], mtimeSec: BASE + 1100 });
  h.advance(60);
  await h.tick();
  expect(h.out.map((e) => e.tool_input_summary)).toEqual(['q1', 'q2']);

  // Nothing new: the marker is unchanged, so nothing is even opened.
  await h.tick();
  expect(h.out).toHaveLength(2);

  await h.tick(true); // capture backfill: the cutoff is ignored, the old session comes in, the new one is not repeated
  expect(h.out.map((e) => e.tool_input_summary)).toEqual(['q1', 'q2', 'old q']);
});

test('through the driver: a session that cannot be read right now does not reset its cursor, so the next good read enqueues only what is new', async () => {
  const h = harness();
  await h.tick(); // cutoff seeded
  h.advance(120);
  const q1 = [userMsg('q1'), assistantMsg('a1')];
  const q2 = [userMsg('q2'), assistantMsg('a2')];
  const dir = writeVibeSession(h.r, 's', { generation: 1, chunks: [[...q1, ...q2]], mtimeSec: BASE + 1050 });
  await h.tick();
  expect(h.state.ingestedCursor('vibe', 's')!.eventsIngested).toBe(2);

  // Vibe's collector removes the chunk a published generation names (the race a reader can lose).
  const before = new Set(readdirSync(join(dir, 'chunks')));
  writeVibeSession(h.r, 's', { generation: 2, chunks: [[...q1, ...q2, userMsg('q3'), assistantMsg('a3')]], mtimeSec: BASE + 1100 });
  for (const f of readdirSync(join(dir, 'chunks'))) if (!before.has(f)) unlinkSync(join(dir, 'chunks', f));
  h.advance(60);
  await h.tick();
  expect(h.logs.some((m) => m.includes('extract failed s') && m.includes('ENOENT'))).toBe(true);
  expect(h.state.ingestedCursor('vibe', 's')!.eventsIngested).toBe(2); // not reset to 0
  expect(h.out).toHaveLength(2);

  writeVibeSession(h.r, 's', { generation: 3, chunks: [[...q1, ...q2, userMsg('q3'), assistantMsg('a3')]], mtimeSec: BASE + 1150 });
  h.advance(60);
  await h.tick();
  expect(h.out.map((e) => e.tool_input_summary)).toEqual(['q1', 'q2', 'q3']);
});

test('through the driver: a turn caught mid-flight is not frozen at its first half', async () => {
  const h = harness();
  await h.tick();
  h.advance(120);
  const q1 = [userMsg('q1'), assistantMsg('a1')];
  // Published while turn 2 is running: only its user message exists yet.
  writeVibeSession(h.r, 's', { generation: 1, execution: 'recoverable', chunks: [[...q1, userMsg('q2')]], mtimeSec: BASE + 1050 });
  await h.tick();
  expect(h.out.map((e) => e.tool_input_summary)).toEqual(['q1']);
  // The turn ends: the same turn, whole.
  writeVibeSession(h.r, 's', { generation: 2, execution: 'quiescent', chunks: [[...q1, userMsg('q2'), assistantMsg('final answer of q2')]], mtimeSec: BASE + 1100 });
  h.advance(60);
  await h.tick();
  expect(h.out.map((e) => e.tool_input_summary)).toEqual(['q1', 'q2']);
  expect(h.out[1]!.tool_result_summary).toBe('assistant: final answer of q2');
});

test('through the driver: a rewind (a shorter history) re-ingests the session, duplicates and never loss (the documented limit)', async () => {
  const h = harness();
  await h.tick();
  h.advance(120);
  const [a, b] = [[userMsg('q1'), assistantMsg('a1')], [userMsg('q2'), assistantMsg('a2')]];
  writeVibeSession(h.r, 's', { generation: 1, chunks: [[...a!, ...b!]], mtimeSec: BASE + 1050 });
  await h.tick();
  expect(h.out).toHaveLength(2);
  writeVibeSession(h.r, 's', { generation: 2, chunks: [[...a!]], mtimeSec: BASE + 1100 }); // rewound to turn 1
  h.advance(60);
  await h.tick();
  expect(h.out.map((e) => e.tool_input_summary)).toEqual(['q1', 'q2', 'q1']);
});
