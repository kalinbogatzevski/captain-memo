// tests/unit/native-session-usage.test.ts
//
// Native-session token flow: the half of the picture the broker cannot see.
// Covers the shape of a real Claude Code transcript, incremental re-reads, the
// UUID gate that keeps hand-written test ids out of the cockpit, and the
// activity window that decides what counts as "live".

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readNativeSessionUsage,
  _resetNativeUsageCache,
} from '../../src/worker/native-session-usage.ts';

let root: string;
let projectDir: string;

const SID = '46ab9cc1-777d-4179-ba55-609de944146c';

/** One assistant message as Claude Code writes it — usage nested under `message`. */
const msg = (input: number, output: number, cw = 0, cr = 0) => JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'irrelevant — this module never reads content' }],
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: cw,
      cache_read_input_tokens: cr,
    },
  },
}) + '\n';

function writeTranscript(sessionId: string, body: string): string {
  const p = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(p, body);
  return p;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cm-native-usage-'));
  projectDir = join(root, '-home-kalin-projects-thing');
  mkdirSync(projectDir, { recursive: true });
  process.env.CAPTAIN_MEMO_TRANSCRIPTS_DIR = root;
  _resetNativeUsageCache();
});

afterEach(() => {
  delete process.env.CAPTAIN_MEMO_TRANSCRIPTS_DIR;
  rmSync(root, { recursive: true, force: true });
});

test('sums provider-reported usage across a transcript', async () => {
  writeTranscript(SID, msg(100, 20, 500, 900) + msg(50, 10, 0, 300));
  const [s] = await readNativeSessionUsage();
  expect(s!.session_id).toBe(SID);
  expect(s!.input_tokens).toBe(150);
  expect(s!.output_tokens).toBe(30);
  expect(s!.cache_creation_tokens).toBe(500);
  expect(s!.cache_read_tokens).toBe(1200);
});

test('ignores lines with no usage block, and survives corrupt lines', async () => {
  // Real transcripts interleave user turns, tool results and summaries; only
  // assistant messages carry usage. A truncated final line is normal mid-write.
  writeTranscript(SID,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n'
    + msg(10, 5)
    + '{"type":"assistant","message":{"usage":{"input_to\n');
  const [s] = await readNativeSessionUsage();
  expect(s!.input_tokens).toBe(10);
  expect(s!.output_tokens).toBe(5);
});

test('re-reads only appended bytes, without double-counting', async () => {
  const p = writeTranscript(SID, msg(100, 20));
  const first = await readNativeSessionUsage();
  expect(first[0]!.input_tokens).toBe(100);
  appendFileSync(p, msg(7, 3));
  const second = await readNativeSessionUsage();
  expect(second[0]!.input_tokens).toBe(107);   // 100 counted once, not twice
  expect(second[0]!.output_tokens).toBe(23);
});

test('a truncated transcript restarts rather than under-reporting', async () => {
  const p = writeTranscript(SID, msg(100, 20) + msg(100, 20));
  await readNativeSessionUsage();
  writeTranscript(SID, msg(5, 1));            // rotated/replaced: now SHORTER than the offset
  const after = await readNativeSessionUsage();
  expect(after[0]!.input_tokens).toBe(5);     // not 205, and not stuck at 200
  expect(p).toContain(SID);
});

test('skips non-UUID session ids', async () => {
  // recall-audit.jsonl also carries hand-written ids from local testing ('test',
  // 'demo-1'). Reporting those as live sessions would invent sessions to the cockpit.
  writeTranscript('demo-1', msg(999, 999));
  writeTranscript('test', msg(999, 999));
  writeTranscript(SID, msg(1, 1));
  const all = await readNativeSessionUsage();
  expect(all.map(s => s.session_id)).toEqual([SID]);
});

test('only sessions active within the window are live', async () => {
  const p = writeTranscript(SID, msg(10, 2));
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  utimesSync(p, old, old);
  expect(await readNativeSessionUsage(30 * 60_000)).toHaveLength(0);   // 3h idle
  expect(await readNativeSessionUsage(4 * 60 * 60_000)).toHaveLength(1); // window widened
});

test('newest activity first', async () => {
  const OTHER = '5739a1c4-fe8a-4d83-8192-7f7442244125';
  const a = writeTranscript(SID, msg(1, 1));
  const b = writeTranscript(OTHER, msg(2, 2));
  const older = new Date(Date.now() - 10 * 60_000);
  utimesSync(a, older, older);
  const out = await readNativeSessionUsage();
  expect(out.map(s => s.session_id)).toEqual([OTHER, SID]);
});

test('a missing transcripts directory yields nothing, never throws', async () => {
  process.env.CAPTAIN_MEMO_TRANSCRIPTS_DIR = join(root, 'does-not-exist');
  expect(await readNativeSessionUsage()).toEqual([]);
});

test('injectedBySession — totals per session, incremental, presence-not-truthiness', async () => {
  const { injectedBySession, _resetInjectedCache } = await import('../../src/worker/native-session-usage.ts');
  _resetInjectedCache();
  const audit = join(root, 'recall-audit.jsonl');
  writeFileSync(audit, [
    JSON.stringify({ ts: 1, session_id: SID, injected_tokens: 400 }),
    JSON.stringify({ ts: 2, session_id: SID, injected_tokens: 0 }),      // real event, 0 tokens
    JSON.stringify({ ts: 3, session_id: 'other', injected_tokens: 90 }),
    JSON.stringify({ ts: 4, session_id: 'search', query: 'q' }),          // no field ⇒ skipped
  ].join('\n') + '\n');

  const first = await injectedBySession(audit);
  expect(first.get(SID)).toEqual({ tokens: 400, injections: 2 });   // the 0 still counts
  expect(first.get('other')).toEqual({ tokens: 90, injections: 1 });
  expect(first.has('search')).toBe(false);

  appendFileSync(audit, JSON.stringify({ ts: 5, session_id: SID, injected_tokens: 100 }) + '\n');
  const second = await injectedBySession(audit);
  expect(second.get(SID)).toEqual({ tokens: 500, injections: 3 });   // 400 not double-counted
});

test('injectedBySession — missing log yields an empty map, never throws', async () => {
  const { injectedBySession, _resetInjectedCache } = await import('../../src/worker/native-session-usage.ts');
  _resetInjectedCache();
  expect((await injectedBySession(join(root, 'nope.jsonl'))).size).toBe(0);
});
