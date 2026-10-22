// Every capture source's events pass runCaptureTick before the observation queue, so that is where credential-shaped text
// is taken out (driver.ts redactEvent): the queue row, the summarizer prompt and the observation all derive from the event.
// Placeholders only: nothing below is a real credential, each is just the SHAPE shared/redact-secrets.ts looks for.
import { test, expect, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as redact from '../../shared/redact-secrets.ts';
import { CaptureState } from './state.ts';
import { runCaptureTick } from './driver.ts';
import { createCodexSource } from './codex-source.ts';
import type { CaptureSource, SessionRef } from './types.ts';
import type { RawObservationEvent } from '../../shared/types.ts';

const GITLAB = 'glpat-' + 'x'.repeat(20);
const OPENAI = 'sk-' + 'PLACEHOLDER1'.repeat(3);
const PASSWORD = 'Placeholder-Pw-0000';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\n' + 'PLACEHOLDERPLACEHOLDERPLACEHOLDER\n'.repeat(3) + '-----END RSA PRIVATE KEY-----';
const SECRET_PARTS = [GITLAB, OPENAI, PASSWORD, 'PLACEHOLDERPLACEHOLDERPLACEHOLDER'];

/** One text with all four shapes, words around each so the test can see they stay. */
const DIRTY = `before ${GITLAB} between ${OPENAI} and password=${PASSWORD} then\n${PEM}\nafter`;

function ev(over: Partial<RawObservationEvent> = {}): RawObservationEvent {
  return {
    session_id: 's1', project_id: 'p', prompt_number: 1, tool_name: 'codex-turn',
    tool_input_summary: 'fix the bug in foo.ts', tool_result_summary: 'assistant: fixed it',
    files_read: [], files_modified: ['/tmp/proj/foo.ts'], ts_epoch: 1, branch: null, origin_agent: 'codex', source: 'capture:codex',
    ...over,
  };
}

function stub(extracts: RawObservationEvent[][]): CaptureSource {
  let call = 0;
  return {
    id: 'codex', available: () => true, enabled: () => true, describe: () => '/x',
    discover: () => [{ sessionId: 's1', path: '/x', marker: `m${call}`, mtimeEpoch: 200 }],
    extract: () => extracts[Math.min(call++, extracts.length - 1)]!,
  };
}

function tmpState(): CaptureState {
  const state = new CaptureState(join(mkdtempSync(join(tmpdir(), 'cm-redact-')), 'capture-state.db'));
  state.ensureCutoff('codex', 100);
  return state;
}

async function tick(src: CaptureSource, state = tmpState(), over: { yieldToLoop?: () => Promise<void> } = {}) {
  const enq: RawObservationEvent[] = [];
  const logs: string[] = [];
  await runCaptureTick({ sources: [src], state, enqueue: (e) => enq.push(e), log: (m) => logs.push(m), now: () => 300_000, ...over });
  return { enq, logs, state };
}

const expectRedacted = (text: string) => {
  expect(text).toContain('[REDACTED');
  for (const part of SECRET_PARTS) expect(text).not.toContain(part);
  for (const word of ['before ', ' between ', ' and password=', ' then\n', '\nafter']) expect(text).toContain(word);
};

test('credential-shaped text is redacted in BOTH text fields, and the words around it stay', async () => {
  const { enq } = await tick(stub([[ev({ tool_input_summary: DIRTY, tool_result_summary: `assistant: ${DIRTY}` })]]));
  expect(enq).toHaveLength(1);
  expectRedacted(enq[0]!.tool_input_summary);
  expectRedacted(enq[0]!.tool_result_summary);
  expect(enq[0]!.tool_result_summary.startsWith('assistant: before ')).toBe(true);
});

test('each field is redacted on its own: a secret in only one leaves the other untouched', async () => {
  const input = await tick(stub([[ev({ tool_input_summary: `use ${GITLAB} now` })]]));
  expect(input.enq[0]!.tool_input_summary).toBe('use [REDACTED:gitlab-token] now');
  expect(input.enq[0]!.tool_result_summary).toBe('assistant: fixed it');
  const result = await tick(stub([[ev({ tool_result_summary: `exec(export GITLAB_TOKEN=${GITLAB})` })]]));
  expect(result.enq[0]!.tool_input_summary).toBe('fix the bug in foo.ts');
  expect(result.enq[0]!.tool_result_summary).not.toContain(GITLAB);
  expect(result.enq[0]!.tool_result_summary).toContain('exec(export GITLAB_TOKEN=');
});

test('a clean event is queued as the very same object, byte for byte', async () => {
  const clean = ev();
  const before = JSON.stringify(clean);
  const { enq, logs } = await tick(stub([[clean]]));
  expect(enq[0]).toBe(clean);
  expect(JSON.stringify(enq[0])).toBe(before);
  // Nothing redacted → nothing said: the existing line, without a count.
  expect(logs).toEqual(['[capture:codex] ingested s1 → 1 new event(s)']);
});

test('only the two text fields are rewritten; paths, ids and the other fields are not, and the source event is not edited in place', async () => {
  const path = `/home/u/${GITLAB}.txt`;   // a path is not a credential; rewriting one would break file lookups
  const dirty = Object.freeze(ev({ tool_input_summary: DIRTY, files_modified: [path], files_read: [path] }));
  const { enq } = await tick(stub([[dirty]]));   // a frozen source event: an in-place edit would throw
  const { tool_input_summary: _a, tool_result_summary: _b, ...rest } = enq[0]!;
  const { tool_input_summary: _c, tool_result_summary: _d, ...expected } = dirty;
  expect(rest).toEqual(expected);
  expect(enq[0]!.files_modified).toEqual([path]);
  expect(dirty.tool_input_summary).toBe(DIRTY);
});

test('a field that is not a string is left alone', async () => {
  const odd = ev({ tool_input_summary: undefined as unknown as string, tool_result_summary: `use ${GITLAB}` });
  const { enq } = await tick(stub([[odd]]));
  expect(enq[0]!.tool_input_summary).toBeUndefined();
  expect(enq[0]!.tool_result_summary).toBe('use [REDACTED:gitlab-token]');
});

test('the log says how many values were redacted and never what they were; it says nothing at zero', async () => {
  const { logs } = await tick(stub([[ev({ tool_input_summary: `use ${GITLAB} now` })]]));
  expect(logs).toEqual(['[capture:codex] ingested s1 → 1 new event(s), 1 credential-shaped value(s) redacted']);
  expect(logs.join('\n')).not.toContain('glpat');
});

test('redaction is deterministic: a re-ingested session yields identical events, and the cursor still slices by event count', async () => {
  const e1 = ev({ prompt_number: 1, tool_input_summary: DIRTY });
  const e2 = ev({ prompt_number: 2, tool_input_summary: 'next', tool_result_summary: `assistant: ${DIRTY}` });
  // two fresh installs, same transcript
  const a = await tick(stub([[e1, e2]]));
  const b = await tick(stub([[e1, e2]]));
  expect(JSON.stringify(a.enq)).toBe(JSON.stringify(b.enq));

  // one install, the session grows: only the new turn is queued, and redacted
  const src = stub([[e1], [e1, e2]]);
  const state = tmpState();
  const first = await tick(src, state);
  const second = await tick(src, state);
  expect(first.enq).toHaveLength(1);
  expect(second.enq).toHaveLength(1);
  expect(second.enq[0]!.prompt_number).toBe(2);
  expectRedacted(second.enq[0]!.tool_result_summary.replace('assistant: ', ''));
  expect(JSON.stringify([...first.enq, ...second.enq])).toBe(JSON.stringify(a.enq));

  // the file is rewritten SHORTER: the driver re-ingests it whole, and turn 1 comes out as it did the first time
  const shrink = stub([[e1, e2], [e1]]);
  const s2 = tmpState();
  await tick(shrink, s2);
  const again = await tick(shrink, s2);
  expect(again.enq).toHaveLength(1);
  expect(JSON.stringify(again.enq[0])).toBe(JSON.stringify(a.enq[0]));
});

test('a long session yields to the loop while it is redacted, before anything is queued', async () => {
  const events = Array.from({ length: 120 }, (_, i) => ev({ prompt_number: i + 1, tool_input_summary: `turn ${i} ${GITLAB}` }));
  const order: string[] = [];
  const enq: RawObservationEvent[] = [];
  await runCaptureTick({
    sources: [stub([events])], state: tmpState(), now: () => 300_000,
    enqueue: (e) => { order.push('enqueue'); enq.push(e); },
    yieldToLoop: async () => { order.push('yield'); },
  });
  expect(enq).toHaveLength(120);
  expect(enq.every((e) => !e.tool_input_summary.includes(GITLAB))).toBe(true);
  // 120 events, a yield every 50: two before the first enqueue (the third is the driver's own, after the session is recorded)
  expect(order.indexOf('enqueue')).toBe(2);
  expect(order.slice(0, 2)).toEqual(['yield', 'yield']);
});

test('a tick parked while redacting a long session does not queue it twice when another tick (POST /capture/backfill) ingests it meanwhile', async () => {
  const events = Array.from({ length: 60 }, (_, i) => ev({ prompt_number: i + 1, tool_input_summary: `turn ${i} ${GITLAB}` }));
  const src: CaptureSource = {   // a stable marker: both ticks see the same state of the file
    id: 'codex', available: () => true, enabled: () => true, describe: () => '/x',
    discover: () => [{ sessionId: 's1', path: '/x', marker: 'm', mtimeEpoch: 200 }], extract: () => events,
  };
  const state = tmpState();
  const enq: RawObservationEvent[] = [];
  const run = (yieldToLoop?: () => Promise<void>) =>
    runCaptureTick({ sources: [src], state, enqueue: (e) => enq.push(e), now: () => 300_000, ...(yieldToLoop && { yieldToLoop }) });
  let other: Promise<unknown> | null = null;
  await run(async () => { other ??= run(); await other; });   // the first tick parks at its first yield and the second one runs to the end
  expect(enq).toHaveLength(60);
});

test('if redaction throws, the session is not queued as written and not marked ingested: it fails closed and is retried', async () => {
  const state = tmpState();
  const src = stub([[ev({ tool_input_summary: `use ${GITLAB} now` })]]);
  const spy = spyOn(redact, 'redactSecrets').mockImplementation(() => { throw new Error('boom'); });
  try {
    const failed = await tick(src, state);
    expect(failed.enq).toEqual([]);
    expect(failed.logs).toEqual(['[capture:codex] redact failed s1: boom']);
    expect(state.wasIngested('codex', 's1', 'm0')).toBe(false);
  } finally {
    spy.mockRestore();
  }
  const retried = await tick(src, state);   // redactSecrets works again: the same session is picked up and redacted
  expect(retried.enq).toHaveLength(1);
  expect(retried.enq[0]!.tool_input_summary).toBe('use [REDACTED:gitlab-token] now');
});

// ── a REAL source class through the driver: codex's own extract() output, not a hand-built event ──
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
test('a real codex rollout with credentials in the prompt, a tool line and the answer is queued redacted and the log counts them; its clean turn is unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-redact-codex-'));
  const day = join(dir, '2026', '10', '22');
  mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-10-22T10-00-00-${UUID}.jsonl`);
  const lines = [
    { timestamp: '2026-10-22T10:00:00.000Z', type: 'session_meta', payload: { id: UUID, cwd: '/tmp/proj' } },
    { timestamp: '2026-10-22T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: `deploy with ${GITLAB} please` } },
    { timestamp: '2026-10-22T10:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: `export GITLAB_TOKEN=${GITLAB} && git push origin main` } },
    { timestamp: '2026-10-22T10:00:03.000Z', type: 'event_msg', payload: { type: 'agent_message', message: `Pushed. The key was ${OPENAI}, and password=${PASSWORD} is set.` } },
    { timestamp: '2026-10-22T10:00:04.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'now add a test' } },
    { timestamp: '2026-10-22T10:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Added test_foo.ts' } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n';
  writeFileSync(path, lines);

  const src = createCodexSource({ projectId: 'proj', dir, quiesceMs: 0, warn: () => {} });
  const ref: SessionRef = src.discover()[0]!;
  const direct = src.extract(ref);                        // what the source hands the driver
  expect(direct).toHaveLength(2);
  expect(JSON.stringify(direct[0])).not.toContain(GITLAB);   // codex's clip() redacts before it cuts (clip-redact.test.ts); the driver pass is the net

  const state = new CaptureState(join(mkdtempSync(join(tmpdir(), 'cm-redact-state-')), 's.db'));
  state.ensureCutoff('codex', 0);
  const { enq, logs } = await tick(src, state);
  expect(enq).toHaveLength(2);
  const queued = JSON.stringify(enq);
  for (const part of SECRET_PARTS) expect(queued).not.toContain(part);
  expect(enq[0]!.tool_input_summary).toBe('deploy with [REDACTED:gitlab-token] please');
  expect(enq[0]!.tool_result_summary).toContain('exec(export GITLAB_TOKEN=');
  expect(enq[0]!.tool_result_summary).toContain('git push origin main');
  expect(enq[0]!.tool_result_summary).toContain('Pushed. The key was [REDACTED:openai-key]');
  expect(enq[1]).toEqual(direct[1]);                      // the clean turn, byte for byte
  expect(enq[0]).toEqual(direct[0]);                      // the driver finds nothing left to take out of what the source redacted
  // counted from the markers in the queued text, so what the source's own clip() took out is reported too (1 + 1 + 2)
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatch(/→ 2 new event\(s\), 4 credential-shaped value\(s\) redacted$/);
});
