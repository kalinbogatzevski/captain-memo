import { test, expect } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createKimiSource } from './kimi-source.ts';
import { CaptureState } from './state.ts';
import { runCaptureTick } from './driver.ts';
import type { RawObservationEvent } from '../../shared/types.ts';
import type { SessionRef } from './types.ts';

// kimi 2.x wire.jsonl fixtures. SYNTHETIC: placeholder words only, built in temp dirs. The record shapes follow
// kimi-code's source (agent-core-v2 wire/record.ts, contextTranscript.ts, loopEventFold.ts); none of it has been
// checked against a file a real 2.x wrote.

const SID = 'session_00000000-0000-4000-8000-000000000001';
const T0 = 1_700_000_000_000; // ms

function wire() {
  let n = 0;
  const L = (type: string, payload: Record<string, unknown> = {}): string => JSON.stringify({ type, ...payload, time: T0 + 1000 * n++ }) + '\n';
  const ev = (event: Record<string, unknown>) => L('context.append_loop_event', { agentId: 'main', event });
  const w = {
    meta: () => JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: T0 }) + '\n',
    L,
    /** origin: the default is { kind: 'user' }; null leaves it out. */
    user: (text: string, origin: unknown = { kind: 'user' }, parts: unknown[] = [], id?: string) =>
      L('context.append_message', {
        agentId: 'main',
        message: { ...(id ? { id } : {}), role: 'user', content: [...parts, { type: 'text', text }], toolCalls: [], ...(origin === null ? {} : { origin }) },
      }),
    begin: (uuid: string) => ev({ type: 'step.begin', uuid }),
    say: (uuid: string, text: string, kind: 'text' | 'think' = 'text') =>
      ev({ type: 'content.part', stepUuid: uuid, part: kind === 'text' ? { type: 'text', text } : { type: 'think', think: text } }),
    call: (uuid: string, id: string, name: string, args: unknown) => ev({ type: 'tool.call', stepUuid: uuid, toolCallId: id, name, args }),
    ret: (id: string, output: string, isError = false) => ev({ type: 'tool.result', toolCallId: id, result: { output, isError } }),
    end: (uuid: string) => ev({ type: 'step.end', uuid, finishReason: 'completed' }),
    /** One assistant step that only says `text`. */
    reply: (uuid: string, text: string): string => w.begin(uuid) + w.say(uuid, text) + w.end(uuid),
    undo: (count: number) => L('context.undo', { agentId: 'main', count }),
    /** What kimi writes for an undo (wire/tree/fork.ts buildUndoSwitchRecords); the base line is deliberately nonsense:
     *  the branch tree is not read, the paired context.undo does the work. */
    undoTriple: (count: number) =>
      L('agent.switched', { agentId: 'main', branch: 'b1', reason: 'undo', base: { branch: 'main', line: 1 }, turns: count, legacyUndoLine: 0 })
      + L('context.undo', { agentId: 'main', count })
      + L('context.undone', { agentId: 'main', turns: count }),
    clear: () => L('context.clear', { agentId: 'main' }),
    compaction: () => L('context.apply_compaction', { summary: 'a summary', compactedCount: 2 }),
  };
  return w;
}

function mount(extra: { warn?: (m: string) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cm-kimi2-'));
  const codeDir = join(root, 'sessions');
  const path = join(codeDir, 'wd_proj_0123456789ab', SID, 'agents', 'main', 'wire.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  const warns: string[] = [];
  // dir: a missing 1.x dir, so no test reads the real ~/.kimi.
  const src = createKimiSource({
    projectId: 'proj', dir: join(root, 'no-1x'), codeDir, quiesceMs: 0, now: () => Date.now() + 10_000, warn: extra.warn ?? ((m) => warns.push(m)),
  });
  const ref = (mtimeEpoch = 100): SessionRef => ({ sessionId: SID, path, marker: 'm', mtimeEpoch });
  return { root, codeDir, path, src, warns, ref };
}

const prompts = (evs: RawObservationEvent[]) => evs.map((e) => e.tool_input_summary);

const HOOK = {
  type: 'text',
  text: '<hook_result hook_event="UserPromptSubmit">\n<memory-context retrieved-by="captain-memo">RECALLWORD</memory-context>\n</hook_result>',
  meta: { contentType: 'text/xml', source: 'user prompt submit hook' },
};

test('kimi 2.x extract: prompts, assistant text, tool calls paired with their result; think, tool output and a prompt hook skipped', () => {
  const w = wire();
  const { path, src, ref } = mount();
  writeFileSync(path, w.meta()
    + w.user('alpha prompt')
    + w.begin('s1') + w.say('s1', 'pondering PRIVATEWORD', 'think') + w.say('s1', 'alpha answer')
    + w.call('s1', 'c1', 'read_file', { path: 'a.txt' }) + w.ret('c1', 'FILEBODY')
    + w.call('s1', 'c2', 'shell', { cmd: 'false' }) + w.ret('c2', 'boom', true) + w.end('s1')
    + w.user('beta prompt', { kind: 'user' }, [HOOK]) + w.reply('s2', 'beta answer'));
  const events = src.extract(ref(5));

  expect(prompts(events)).toEqual(['alpha prompt', 'beta prompt']);
  expect(events.every((e) => e.origin_agent === 'kimi' && e.session_id === SID && e.source === 'capture:kimi' && e.tool_name === 'kimi-turn')).toBe(true);
  expect(events.map((e) => e.prompt_number)).toEqual([1, 2]);
  expect(events[0]!.ts_epoch).toBe(T0 / 1000); // the prompt's own `time` (ms), not the file's mtime
  const r0 = events[0]!.tool_result_summary;
  expect(r0).toContain('assistant: alpha answer');
  expect(r0).toContain('read_file({"path":"a.txt"})');
  expect(r0).toContain('shell({"cmd":"false"}) [error]');
  expect(events[1]!.tool_result_summary).toContain('assistant: beta answer');
  const all = JSON.stringify(events);
  for (const leaked of ['PRIVATEWORD', 'FILEBODY', 'boom', 'RECALLWORD', 'hook_result', 'memory-context']) expect(all).not.toContain(leaked);
});

test('kimi 2.x extract: both origin shapes and an absent one are prompts; injections, hook results, summaries, slash commands, turn.prompt and the engine mirror are not', () => {
  const w = wire();
  const { path, src, ref } = mount();
  writeFileSync(path, w.meta()
    + w.user('one', 'user') + w.reply('a', 'r1')
    + w.user('two', { kind: 'user', inTurn: true }) + w.reply('b', 'r2')
    + w.user('three', null) + w.reply('c', 'r3')
    + w.user('INJECTED', { kind: 'injection', variant: 'x', ownerPromptId: 'p' })
    + w.user('INJECTED2', 'injection')
    + w.user('HOOKRESULT', { kind: 'hook_result', event: 'UserPromptSubmit' })
    + w.user('SUMMARY', { kind: 'compaction_summary' })
    + w.user('SLASH', { kind: 'skill_activation', trigger: 'user-slash', activationId: 'x', skillName: 'y' })
    + w.user('TASKNOTE', { kind: 'task', taskId: 't', status: 'done', notificationId: 'n' })
    + w.L('turn.prompt', { agentId: 'main', input: [{ type: 'text', text: 'DUPLICATE' }], origin: { kind: 'user' }, promptId: 'p', turnId: 't' })
    + w.L('agent.message.appended', { kind: 'event', message: { role: 'user', content: [{ type: 'text', text: 'MIRROR' }] } })
    + w.L('human.agent.message.appended', { kind: 'event', message: { role: 'user', content: [{ type: 'text', text: 'MIRROR2' }] } })
    + w.L('future.record.type', { whatever: 1 }));
  const events = src.extract(ref());
  expect(prompts(events)).toEqual(['one', 'two', 'three']);
  const all = JSON.stringify(events);
  for (const leaked of ['INJECTED', 'HOOKRESULT', 'SUMMARY', 'SLASH', 'TASKNOTE', 'DUPLICATE', 'MIRROR']) expect(all).not.toContain(leaked);
});

test('kimi 2.x extract: a bad line is skipped and reported by number only; an unterminated last line is not read until it is complete', () => {
  const w = wire();
  const { path, src, ref, warns } = mount();
  const partial = w.user('PARTIALWORD later');
  const cut = partial.indexOf('PARTIALWORD') + 4; // mid-text, no newline
  writeFileSync(path, w.meta() + w.user('first') + w.reply('a', 'r1') + '{"type":"context.append_mes SECRETJUNK\n' + '\n' + w.user('second') + partial.slice(0, cut));

  expect(prompts(src.extract(ref()))).toEqual(['first', 'second']);
  expect(JSON.stringify(src.extract(ref()))).not.toContain('PART');
  expect(warns).toEqual([`[capture:kimi] skipped unparseable line 6 of ${path}`]); // once: the second extract did not repeat it
  expect(warns.join()).not.toContain('SECRETJUNK');

  appendFileSync(path, partial.slice(cut));
  expect(prompts(src.extract(ref()))).toEqual(['first', 'second', 'PARTIALWORD later']);
  expect(warns).toHaveLength(1);
});

test('kimi 2.x undo: the paired switch triple and a bare context.undo drop the undone turns; the branch base is not read', () => {
  const w = wire();
  const { path, src, ref } = mount();
  const run = (body: string) => { writeFileSync(path, w.meta() + body); return prompts(src.extract(ref())); };

  expect(run(w.user('A') + w.reply('a', 'ra') + w.user('B') + w.reply('b', 'UNDONEWORD') + w.undoTriple(1) + w.user('C') + w.reply('c', 'rc')))
    .toEqual(['A', 'C']);
  expect(JSON.stringify(src.extract(ref()))).not.toContain('UNDONEWORD');
  expect(run(w.user('A') + w.user('B') + w.user('C') + w.undoTriple(2) + w.user('D'))).toEqual(['A', 'D']);
  expect(run(w.user('A') + w.user('B') + w.undo(1))).toEqual(['A']);
  expect(run(w.user('A') + w.user('B') + w.undo(1) + w.undo(1) + w.user('C'))).toEqual(['C']);
});

const slash = { kind: 'skill_activation', trigger: 'user-slash', activationId: 'x', skillName: 'y' };
const undoing = (body: (w: ReturnType<typeof wire>) => string) => {
  const w = wire();
  const { path, src, ref } = mount();
  writeFileSync(path, w.meta() + body(w));
  return prompts(src.extract(ref()));
};

test('kimi 2.x undo counts a slash-command prompt as one (it is what kimi counts)', () => {
  expect(undoing((w) => w.user('A') + w.user('SLASH', slash) + w.user('B') + w.undo(2))).toEqual(['A']); // B and the slash prompt, not A
});
test('kimi 2.x undo does not count a mid-turn steer', () => {
  expect(undoing((w) => w.user('A') + w.user('B') + w.user('steer', { kind: 'user', inTurn: true }) + w.undo(1))).toEqual(['A']);
});
test('kimi 2.x undo cannot cross a clear, and the turns before a clear stay captured', () => {
  expect(undoing((w) => w.user('A') + w.clear() + w.user('B') + w.undo(5))).toEqual(['A']);
  expect(undoing((w) => w.user('A') + w.user('B') + w.clear() + w.user('C'))).toEqual(['A', 'B', 'C']);
});
test('kimi 2.x undo cannot cross a compaction', () => {
  expect(undoing((w) => w.user('A') + w.compaction() + w.user('B') + w.undo(5))).toEqual(['A']);
});

test('kimi 2.x: an imported session (no origins, no times, whole messages, the pre-1.1 tool-call shape) is read', () => {
  const { path, src, ref } = mount();
  const rec = (o: unknown) => JSON.stringify(o) + '\n';
  writeFileSync(path, rec({ type: 'metadata', protocol_version: '1.0', created_at: T0 })
    + rec({ type: 'turn.prompt', agentId: 'main', input: [], origin: { kind: 'user' }, time: T0 })
    + rec({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'old prompt' }], toolCalls: [] } })
    + rec({ type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], toolCalls: [{ type: 'function', id: 't1', function: { name: 'grep', arguments: '{"q":"x"}' } }] } })
    + rec({ type: 'context.append_message', message: { role: 'tool', content: [{ type: 'text', text: 'OLDOUT' }], toolCallId: 't1', isError: true } })
    + rec({ type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed', time: T0 }));
  const events = src.extract(ref(777));
  expect(prompts(events)).toEqual(['old prompt']);
  expect(events[0]!.ts_epoch).toBe(777); // no `time` on the prompt: the file's mtime, which migrate stamps with the original date
  expect(events[0]!.tool_result_summary).toContain('assistant: old answer');
  expect(events[0]!.tool_result_summary).toContain('grep({"q":"x"}) [error]');
  expect(JSON.stringify(events)).not.toContain('OLDOUT');
});

// ---- resume ----

const turnsText = (w: ReturnType<typeof wire>, from: number, to: number) => {
  let s = '';
  for (let i = from; i <= to; i++) s += w.user(`prompt ${i}`) + w.reply(`s${i}`, `answer ${i}`);
  return s;
};

test('kimi 2.x resume: lines appended between two scans yield only the new turn; an unterminated tail is held back', () => {
  const w = wire();
  const { path, src, ref } = mount();
  writeFileSync(path, w.meta() + turnsText(w, 1, 2));
  const first = src.extractFrom!(ref(1), null);
  expect(first.from).toBeNull();
  expect(prompts(first.events)).toEqual(['prompt 1', 'prompt 2']);
  expect(first.resume).toMatch(/^w1:/); // its own prefix: a 1.x cursor is `v1:`

  appendFileSync(path, turnsText(w, 3, 3));
  const second = src.extractFrom!(ref(2), first.resume);
  expect(second.from).toBe(1); // the open turn (2) is replayed, turn 1 is not parsed again
  expect(prompts(second.events)).toEqual(['prompt 2', 'prompt 3']);
  expect(prompts(second.events.slice(2 - second.from!))).toEqual(['prompt 3']); // what the driver enqueues
  expect(second.events).toEqual(src.extract(ref(2)).slice(second.from!));

  const half = w.user('prompt 4');
  appendFileSync(path, half.slice(0, 30));
  const held = src.extractFrom!(ref(3), second.resume);
  expect(prompts(held.events)).toEqual(['prompt 3']); // the half line is not read
  appendFileSync(path, half.slice(30));
  const done = src.extractFrom!(ref(4), held.resume);
  expect(prompts(done.events)).toEqual(['prompt 3', 'prompt 4']);
});

function grown() {
  const w = wire();
  const m = mount();
  writeFileSync(m.path, w.meta() + turnsText(w, 1, 3));
  return { w, ...m, first: m.src.extractFrom!(m.ref(1), null) };
}

test('kimi 2.x resume: an undo in the new bytes (it can reach before the resume point) parses the whole file', () => {
  const { w, path, src, ref, first } = grown();
  expect(src.extractFrom!(ref(1), first.resume).from).toBe(2); // sanity: this cursor does resume
  appendFileSync(path, w.undoTriple(2)); // removes turns 2 and 3
  const undone = src.extractFrom!(ref(1), first.resume);
  expect(undone.from).toBeNull();
  expect(prompts(undone.events)).toEqual(['prompt 1']);
});

test('kimi 2.x resume: a cursor of the other layout, another parser version or garbage is refused', () => {
  const { src, ref, first } = grown();
  for (const bad of [first.resume!.replace(/^w1:/, 'v1:'), first.resume!.replace(/^w1:/, 'w0:'), 'garbage']) {
    expect(src.extractFrom!(ref(1), bad).from).toBeNull();
  }
});

test('kimi 2.x resume: a file rewritten shorter than the cursor parses in full', () => {
  const { w, path, src, ref, first } = grown();
  writeFileSync(path, w.meta() + 'x'.repeat(first.resume!.length) + '\n'); // shorter than the old size, different bytes
  expect(src.extractFrom!(ref(1), first.resume).from).toBeNull();
});

const MIXED = (() => {
  const w = wire();
  return w.meta()
    + '{broken line\n'                                   // first, so no split but the earliest has it in its new bytes: those would parse in full for that reason alone
    + w.user('first ünïcode 日本語', { kind: 'user' }, [HOOK]) + w.begin('a') + w.say('a', 'pondering', 'think') + w.say('a', 'looking ✓')
    + w.call('a', 'c1', 'read_file', { path: 'x' }) + w.ret('c1', 'out') + w.end('a')
    + w.user('second') + w.reply('b', 'two')
    + w.user('third', 'user') + w.reply('c', 'three')
    + w.undoTriple(2)                                    // takes 'third' and 'second': reaches before the resume point when 'third' is the open turn
    + w.L('future.record.type', { x: 1 }) + '\n'
    + w.user('fourth') + w.reply('d', 'four')
    + w.undoTriple(1)
    + w.user('fifth', null) + w.reply('e', 'five')
    + w.clear()
    + w.user('sixth') + w.begin('f') + w.say('f', 'six') + w.call('f', 'c2', 'shell', { cmd: 'ls' }) + w.ret('c2', 'files', true) + w.end('f');
})();

test('kimi 2.x extractFrom: at EVERY byte split (mid-line, mid-turn, mid-multibyte, across an undo) the resumed tail equals the full extract', () => {
  const bytes = Buffer.from(MIXED, 'utf8');
  const { path, src, ref } = mount({ warn: () => {} });
  writeFileSync(path, bytes);
  const full = src.extract(ref(200));
  expect(prompts(full)).toEqual(['first ünïcode 日本語', 'fifth', 'sixth']); // second, third and fourth were undone
  let resumed = 0;
  let refused = 0;

  for (let cut = 0; cut <= bytes.length; cut++) {
    writeFileSync(path, bytes.subarray(0, cut));
    const first = src.extractFrom!(ref(100), null);
    expect(first.from).toBeNull();
    appendFileSync(path, bytes.subarray(cut));
    const next = src.extractFrom!(ref(200), first.resume);
    if (first.resume) { if (next.from !== null) resumed++; else refused++; }
    expect(next.events).toEqual(full.slice(next.from ?? 0));
    const again = src.extractFrom!(ref(200), next.resume);
    expect(again.events).toEqual(full.slice(again.from ?? 0));
  }
  expect(resumed).toBeGreaterThan(100);
  expect(refused).toBeGreaterThan(0); // the splits whose new bytes hold an undo (or, the earliest, the broken line)
}, 120_000); // ~3,500 splits x 3 parses, and the box is shared

// ---- through the driver: what is enqueued ----

function driven() {
  const w = wire();
  const m = mount();
  const state = new CaptureState(join(mkdtempSync(join(tmpdir(), 'cm-cap-kimi2-')), 's.db'));
  state.ensureCutoff('kimi', 0);
  const out: RawObservationEvent[] = [];
  const tick = async () => { out.length = 0; await runCaptureTick({ sources: [m.src], state, enqueue: (e) => out.push(e), now: () => 1_900_000_000_000 }); return prompts(out); };
  return { w, ...m, state, tick };
}

test('kimi 2.x through the driver: an undo then new turns enqueues exactly the new turns; an undo alone enqueues nothing', async () => {
  const { w, path, tick, state } = driven();
  writeFileSync(path, w.meta() + turnsText(w, 1, 3));
  expect(await tick()).toEqual(['prompt 1', 'prompt 2', 'prompt 3']);

  appendFileSync(path, w.undoTriple(1) + w.user('replacement') + w.reply('r', 'done')); // 3 turns before, 3 after: the count alone says "nothing new"
  expect(await tick()).toEqual(['replacement']);

  appendFileSync(path, w.undoTriple(1)); // undoes it again: nothing to add, and nothing replayed
  expect(await tick()).toEqual([]);
  expect(state.ingestedCursor('kimi', SID)!.eventsIngested).toBe(2);

  appendFileSync(path, w.user('after') + w.reply('z', 'ok'));
  expect(await tick()).toEqual(['after']);
  appendFileSync(path, w.user('and more') + w.reply('y', 'ok'));
  expect(await tick()).toEqual(['and more']);
  expect(state.ingestedCursor('kimi', SID)!.resume).toMatch(/^w1:/);
});

// ---- discovery ----

test('kimi 2.x discover: <home>/sessions/*/*/agents/main/wire.jsonl only; $KIMI_CODE_HOME is honoured and CAPTAIN_MEMO_CAPTURE_KIMI_DIR stays 1.x', () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-kimi2-disc-'));
  const home = join(root, 'code-home');
  const touch = (...p: string[]) => { const f = join(root, ...p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, '{}\n'); };
  touch('code-home', 'sessions', 'wd_a_000000000001', 'session_one', 'agents', 'main', 'wire.jsonl');
  touch('code-home', 'sessions', 'wd_a_000000000001', 'session_one', 'agents', 'agent-1', 'wire.jsonl');          // a sub-agent
  touch('code-home', 'sessions', 'wd_a_000000000001', 'session_two', 'agents', 'main', 'wire.jsonl.bak');          // kimi's repair backup
  touch('code-home', 'sessions', '.index-cache', 'scan.json');                                                      // titles: never read
  touch('code-home', 'sessions', '.index-cache', 'session_hidden', 'agents', 'main', 'wire.jsonl');
  touch('code-home', 'sessions', 'wd_b_000000000002', 'session_three', 'agents', 'main', 'wire.jsonl');
  touch('code-home', 'credentials', 'x', 'agents', 'main', 'wire.jsonl');                                           // not under sessions
  touch('legacy', 'hash', 'e952f7ca-8b38-4c74-9b0a-12969e216bd8', 'context.jsonl');

  const make = (env: Record<string, string>) => createKimiSource({ projectId: 'p', quiesceMs: 0, now: () => Date.now() + 10_000, env });
  const home2 = make({ KIMI_CODE_HOME: home, CAPTAIN_MEMO_CAPTURE_KIMI_DIR: join(root, 'legacy') });
  expect(home2.discover().map((r) => r.sessionId).sort()).toEqual(['e952f7ca-8b38-4c74-9b0a-12969e216bd8', 'session_one', 'session_three']);
  expect(home2.discover().find((r) => r.sessionId === 'session_one')!.path)
    .toBe(join(home, 'sessions', 'wd_a_000000000001', 'session_one', 'agents', 'main', 'wire.jsonl'));
  expect(home2.describe()).toBe(`${join(root, 'legacy')} + ${join(home, 'sessions')}`);

  // the override moves 1.x only: with it pointing nowhere, 2.x is still found under KIMI_CODE_HOME
  const moved = make({ KIMI_CODE_HOME: home, CAPTAIN_MEMO_CAPTURE_KIMI_DIR: join(root, 'nowhere') });
  expect(moved.discover().map((r) => r.sessionId).sort()).toEqual(['session_one', 'session_three']);
  expect(moved.available()).toBe(true);
  expect(make({ KIMI_CODE_HOME: join(root, 'none'), CAPTAIN_MEMO_CAPTURE_KIMI_DIR: join(root, 'none-either') }).available()).toBe(false);
});

test('kimi: a machine with both layouts captures each session once, and a 1.x cursor is never read as a 2.x one', async () => {
  const w = wire();
  const root = mkdtempSync(join(tmpdir(), 'cm-kimi-both-'));
  const legacyDir = join(root, 'legacy');
  const home = join(root, 'code-home');
  const legacy = join(legacyDir, 'hashabc', 'e952f7ca-8b38-4c74-9b0a-12969e216bd8', 'context.jsonl');
  const wirePath = join(home, 'sessions', 'wd_p_000000000001', SID, 'agents', 'main', 'wire.jsonl');
  for (const f of [legacy, wirePath]) mkdirSync(dirname(f), { recursive: true });
  writeFileSync(legacy, [{ role: 'user', content: 'old layout prompt' }, { role: 'assistant', content: 'old answer' }].map((o) => JSON.stringify(o)).join('\n') + '\n');
  writeFileSync(wirePath, w.meta() + w.user('new layout prompt') + w.reply('a', 'new answer'));

  const src = createKimiSource({ projectId: 'proj', quiesceMs: 0, now: () => Date.now() + 10_000, env: { KIMI_CODE_HOME: home, CAPTAIN_MEMO_CAPTURE_KIMI_DIR: legacyDir } });
  const state = new CaptureState(join(mkdtempSync(join(tmpdir(), 'cm-cap-both-')), 's.db'));
  state.ensureCutoff('kimi', 0);
  const out: RawObservationEvent[] = [];
  const tick = () => runCaptureTick({ sources: [src], state, enqueue: (e) => out.push(e), now: () => 1_900_000_000_000 });
  await tick();
  expect(prompts(out).sort()).toEqual(['new layout prompt', 'old layout prompt']);
  await tick();
  expect(out).toHaveLength(2); // nothing twice

  const oldRef = src.discover().find((r) => r.path === legacy)!;
  const newRef = src.discover().find((r) => r.path === wirePath)!;
  const oldCursor = src.extractFrom!(oldRef, null).resume!;
  expect(oldCursor).toMatch(/^v1:/);
  expect(src.extractFrom!(newRef, oldCursor).from).toBeNull();
  expect(src.eventCountAtMarker!(oldRef, oldRef.marker)).toBeNull(); // 1.x keeps the driver's plain count
});
