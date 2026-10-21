// tests/unit/native-session-usage.test.ts
//
// Native-session token flow: the half of the picture the broker cannot see.
// Covers the shape of a real Claude Code transcript, incremental re-reads, the
// UUID gate that keeps hand-written test ids out of the cockpit, and the
// activity window that decides what counts as "live".

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, utimesSync, readFileSync } from 'fs';
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
  projectDir = join(root, '-home-user-projects-thing');
  mkdirSync(projectDir, { recursive: true });
  process.env.CAPTAIN_MEMO_TRANSCRIPTS_DIR = root;
  _resetNativeUsageCache();
});

afterEach(() => {
  delete process.env.CAPTAIN_MEMO_TRANSCRIPTS_DIR;
  rmSync(root, { recursive: true, force: true });
});

/** One assistant message as Claude Code ACTUALLY writes it: several records — thinking,
 *  tool_use, text — each carrying an identical copy of the SAME usage block, because the
 *  usage describes the message, not the record. */
const msgId = (id: string, input: number, output: number) => JSON.stringify({
  type: 'assistant',
  message: {
    id, role: 'assistant',
    content: [{ type: 'text', text: 'irrelevant' }],
    usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
}) + '\n';

test('a usage block repeated across records of ONE message is counted once', async () => {
  // Measured on four large real transcripts: 7,276 message ids appeared more than once and
  // NOT ONE of them carried differing usage — the same block is simply re-emitted per content
  // record. Summing per record therefore inflated every figure on the board by 2.5x-3.2x.
  // Counting the first copy per id is exact, not a heuristic, because the copies are equal.
  writeTranscript(SID, msgId('msg_A', 100, 20) + msgId('msg_A', 100, 20) + msgId('msg_A', 100, 20)
    + msgId('msg_B', 7, 3));
  const [s] = await readNativeSessionUsage();
  expect(s!.input_tokens).toBe(107);     // 100 once + 7, NOT 300 + 7
  expect(s!.output_tokens).toBe(23);
});

test('a message whose FIRST record carries no usage is still counted', async () => {
  // The dedupe must key on usage-BEARING records only. Marking the id seen on any record
  // with that id meant a leading usage-less record (a thinking block) consumed the id and
  // the record actually carrying the usage was skipped — every session reported 0 input.
  // The synthetic fixtures could not catch this because they put usage on every record;
  // only running it against real transcripts did.
  const noUsage = JSON.stringify({ type: 'assistant', message: { id: 'msg_A', role: 'assistant', content: [{ type: 'thinking' }] } }) + '\n';
  writeTranscript(SID, noUsage + msgId('msg_A', 100, 20) + msgId('msg_A', 100, 20));
  const [s] = await readNativeSessionUsage();
  expect(s!.input_tokens).toBe(100);     // counted once — not 0, not 200
  expect(s!.output_tokens).toBe(20);
});

test('a STREAMING message keeps its largest usage, not its first', async () => {
  // Agent transcripts stream PARTIAL usage: the same message id is written repeatedly with
  // identical input/cache_read and a GROWING output_tokens. Sessions never do this — measured
  // on this host, 9,859 duplicated ids in sessions with ZERO differing, against 3,762 in
  // agents of which 3,112 (83%) differ. First-copy-wins is therefore exact for sessions and
  // under-counts agent output by ~30x (142,777 reported vs 4,694,491 real, in a 400-file
  // sample). The earlier "zero of 7,276 differ" measurement sampled only the four largest
  // transcripts — all of them sessions — and generalised from it.
  writeTranscript(SID,
    msgId('msg_S', 100, 39) + msgId('msg_S', 100, 197) + msgId('msg_S', 100, 2742));
  const [s] = await readNativeSessionUsage();
  expect(s!.output_tokens).toBe(2742);    // the completed message, not the first partial
  expect(s!.input_tokens).toBe(100);      // input is identical across copies — counted ONCE
});

test('a shrinking or equal repeat never subtracts from the total', async () => {
  // Guard the direction: taking the max must never let a late, smaller copy walk the number
  // backwards, and an identical repeat must remain a no-op.
  writeTranscript(SID, msgId('msg_S', 100, 500) + msgId('msg_S', 100, 200) + msgId('msg_S', 100, 500));
  const [s] = await readNativeSessionUsage();
  expect(s!.output_tokens).toBe(500);
  expect(s!.input_tokens).toBe(100);
});

test('a usage record with no message id is still counted', async () => {
  // Dedupe must never become a silent drop: without an id there is nothing to dedupe on, so
  // the record counts. Undercounting is as wrong as double-counting.
  writeTranscript(SID, msg(50, 10) + msg(50, 10));
  const [s] = await readNativeSessionUsage();
  expect(s!.input_tokens).toBe(100);
});

test('the same message id is counted once even when split across incremental reads', async () => {
  // The transcript is read in appended chunks across polls, so the copies of one message can
  // land in DIFFERENT reads. Dedupe state has to live with the accumulator, not the chunk.
  const p = writeTranscript(SID, msgId('msg_A', 100, 20));
  const first = await readNativeSessionUsage();
  expect(first[0]!.input_tokens).toBe(100);
  appendFileSync(p, msgId('msg_A', 100, 20) + msgId('msg_C', 5, 1));
  const second = await readNativeSessionUsage();
  expect(second[0]!.input_tokens).toBe(105);   // not 205
});

test('concurrent scans never advance the offset past what was actually digested', async () => {
  // accumulate() computed its read range and advanced t.offset AFTER two awaits, with no
  // guard on the shared accumulator. The worker fires allTimeTotals() unawaited (a 365-day
  // scan) while the ~10s fleet poll keeps running, so two scans reading one transcript is
  // routine. Both read the SAME byte range and each advanced the offset by it, so the offset
  // ran ahead of the bytes consumed — and everything written into that phantom gap was
  // skipped PERMANENTLY, because the `size < offset` self-heal never fires once the file
  // grows past it. The symptom is silently MISSING tokens, not double-counted ones: the
  // per-message dedupe already makes a re-read idempotent.
  const p = writeTranscript(SID, msgId('msg_1', 100, 10));
  await readNativeSessionUsage();                       // warm the accumulator

  appendFileSync(p, msgId('msg_2', 100, 10));
  await Promise.all([readNativeSessionUsage(365 * 24 * 60 * 60_000), readNativeSessionUsage()]);

  appendFileSync(p, msgId('msg_3', 100, 10) + msgId('msg_4', 100, 10));
  const [s] = await readNativeSessionUsage();
  expect(s!.input_tokens).toBe(400);      // all four messages — none lost to a phantom offset

  // HONESTY NOTE: the assertion above exercises the concurrent path but does NOT prove the
  // race — the interleaving is not deterministic at this level, and it passed before the fix
  // as well. What the fix guarantees is a property of the CODE, so that is what is asserted
  // here: the read position is captured before any await, and the write is a max rather than
  // an unconditional advance. Both are what make a duplicated read harmless.
  const src = readFileSync(join(import.meta.dir, '../../src/worker/native-session-usage.ts'), 'utf8');
  const acc = src.slice(src.indexOf('async function accumulate'), src.indexOf('// Sum the buckets'));
  expect(acc).toMatch(/const from = t\.offset;/);          // captured before the awaits
  expect(acc).toMatch(/let pos = from/);                   // and the reads advance from it, locally
  expect(acc).toMatch(/fh\.read\(buf, 0, len, pos\)/);
  expect(acc).toMatch(/t\.offset = Math\.max\(t\.offset,/); // idempotent write
  expect(acc).not.toMatch(/t\.offset \+=/);                 // never a blind advance
});

test('scans of one transcript at once never count a message twice, even past the 64-id dedupe memory', async () => {
  // The dedupe remembers only the last MSG_ID_MEMORY (64) ids. Two scans of one path that start at the same offset (the 10 s
  // poll and the unawaited all-time scan do, routinely) read the same bytes, and whichever digested them second re-digested
  // ids the first had already counted and the ring had since evicted: every message beyond the last 64 counted twice, and a
  // record with no id (nothing to dedupe on) counted twice however short the transcript.
  const N = 200;                                           // well past 64
  let body = '';
  for (let i = 0; i < N; i++) body += msgId(`m${i}`, 10, 1);
  body += msg(50, 5) + msg(50, 5);                         // id-less: counted on every digest of its bytes
  const p = writeTranscript(SID, body);
  const wide = 365 * 24 * 60 * 60_000;
  const rows = await Promise.all([readNativeSessionUsage(wide), readNativeSessionUsage()]);
  for (const [s] of rows) {
    expect(s!.input_tokens).toBe(N * 10 + 100);
    expect(s!.output_tokens).toBe(N + 10);
  }
  appendFileSync(p, msgId('m_late', 7, 1));                // and the offset the scans left is exactly the end of the bytes they digested
  const [after] = await readNativeSessionUsage();
  expect(after!.input_tokens).toBe(N * 10 + 100 + 7);
});

test('scans of a multi-piece transcript at once count every message exactly once', async () => {
  // Same race across read pieces (DIGEST_CHUNK = 1 MB): a scan that finds the other one already ahead has to jump to where
  // that one got to, for each piece, not only at its start. ~3 MB, ~100 messages per piece, three scans of different widths.
  const pad = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(10_000) } }) + '\n';
  const N = 300;
  let body = '';
  for (let i = 0; i < N; i++) body += pad + msgId(`m${i}`, 10, 1);
  writeTranscript(SID, body);
  const rows = await Promise.all([readNativeSessionUsage(365 * 24 * 60 * 60_000), readNativeSessionUsage(), readNativeSessionUsage(60_000)]);
  for (const [s] of rows) {
    expect(s!.input_tokens).toBe(N * 10);
    expect(s!.output_tokens).toBe(N);
  }
});

test('a transcript past one read piece (1 MB) is summed whole, a line longer than a piece included', async () => {
  // accumulate() digests in 1 MB pieces so a cold transcript never parses in one block; lines that
  // straddle a piece boundary, and a single line longer than a piece, must still count exactly once.
  const pad = (k: number) => JSON.stringify({ type: 'user', message: { content: 'x'.repeat(k) } }) + '\n';
  let body = '';
  for (let i = 0; i < 40; i++) body += pad(40_000) + msgId(`m${i}`, 10, 1);   // ~1.6 MB, boundaries mid-line
  body += pad(2_500_000) + msgId('big', 10, 1);                                 // one 2.5 MB line
  writeTranscript(SID, body);
  const [s] = await readNativeSessionUsage();
  expect(s!.input_tokens).toBe(410);
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

test('injectedBySession — overlapping calls never tally a line twice', async () => {
  // A call captures acc.offset, awaits stat/open/read, then tallies. Two overlapping calls (two `captain-memo top` polling
  // GET /sessions/usage do) read the same tail and BOTH tallied it into the shared map: the offset guard only kept the
  // offset right, so injected_tokens and injections doubled and stayed doubled until the worker restarted.
  const { injectedBySession, _resetInjectedCache } = await import('../../src/worker/native-session-usage.ts');
  const audit = join(root, 'recall-audit.jsonl');
  const N = 50;
  let body = '';
  for (let i = 0; i < N; i++) body += JSON.stringify({ ts: i, session_id: SID, injected_tokens: 10 }) + '\n';
  writeFileSync(audit, body);
  const want = { tokens: N * 10, injections: N };

  _resetInjectedCache();
  expect((await injectedBySession(audit)).get(SID)).toEqual(want);          // one call

  _resetInjectedCache();
  const maps = await Promise.all([injectedBySession(audit), injectedBySession(audit), injectedBySession(audit)]);
  for (const m of maps) expect(m.get(SID)).toEqual(want);                   // overlapping calls
  expect((await injectedBySession(audit)).get(SID)).toEqual(want);          // and nothing doubled for a later call
});

test('injectedBySession — one call, two sequential calls and two overlapping calls on a growing log agree', async () => {
  // Three logs fed the same lines, read three ways each round: once, twice in a row, and twice overlapping with more lines
  // appended while the first call is in flight (so the second may see a longer file than the first). Whichever call
  // digests first, every line must be tallied exactly once, and a per-line token count that varies (1..7) makes a line
  // tallied twice or skipped show in the sum.
  const { injectedBySession, _resetInjectedCache } = await import('../../src/worker/native-session-usage.ts');
  _resetInjectedCache();
  const log = (n: string) => join(root, `audit-${n}.jsonl`);
  const one = log('one'), seq = log('seq'), overlap = log('overlap');
  let lines = 0, tokens = 0;
  const grow = (n: number) => {
    for (let j = 0; j < n; j++, lines++) {
      const tk = (lines % 7) + 1;
      tokens += tk;
      const l = JSON.stringify({ ts: lines, session_id: SID, injected_tokens: tk }) + '\n';
      for (const f of [one, seq, overlap]) appendFileSync(f, l);
    }
  };
  for (let round = 0; round < 20; round++) {
    grow(4);
    await injectedBySession(one);
    await injectedBySession(seq);
    await injectedBySession(seq);
    const first = injectedBySession(overlap);
    grow(3);
    await Promise.all([first, injectedBySession(overlap)]);
    for (const f of [one, seq, overlap]) {
      expect((await injectedBySession(f)).get(SID)).toEqual({ tokens, injections: lines });   // settled: all lines, once
    }
  }
});

test('injectedBySession — missing log yields an empty map, never throws', async () => {
  const { injectedBySession, _resetInjectedCache } = await import('../../src/worker/native-session-usage.ts');
  _resetInjectedCache();
  expect((await injectedBySession(join(root, 'nope.jsonl'))).size).toBe(0);
});

test('a workflow sub-task agent reports its name and its owner', async () => {
  // Workflow agents each get their OWN top-level transcript with its own uuid, so a dozen
  // of them read as a dozen unrelated sessions — all in one project, indistinguishable by
  // cwd. They do record who they are (agentName, from `--resume <name>`) and who launched
  // them (bridgeSessionId), which is the only reliable way to group them.
  const line = (extra: Record<string, unknown>) => JSON.stringify({
    type: 'assistant', cwd: '/home/user/projects/thing', ...extra,
    message: { role: 'assistant', usage: { input_tokens: 10, output_tokens: 2 } },
  }) + '\n';
  writeTranscript(SID, line({ agentName: 'SITE-REVAMP-V1', bridgeSessionId: 'cse_01ABC' }) + line({}));
  const [s] = await readNativeSessionUsage();
  expect(s!.agentName).toBe('SITE-REVAMP-V1');
  expect(s!.ownerSession).toBe('cse_01ABC');
  expect(s!.input_tokens).toBe(20);            // both lines still counted
});

test('customTitle stands in when agentName is absent', async () => {
  writeTranscript(SID, JSON.stringify({
    type: 'assistant', customTitle: 'CPT-TOP',
    message: { role: 'assistant', usage: { input_tokens: 1, output_tokens: 1 } },
  }) + '\n');
  const [s] = await readNativeSessionUsage();
  expect(s!.agentName).toBe('CPT-TOP');
});

test('a plain session reports neither — absent, not empty string', async () => {
  writeTranscript(SID, msg(5, 1));
  const [s] = await readNativeSessionUsage();
  expect(s!.agentName).toBeUndefined();
  expect(s!.ownerSession).toBeUndefined();
});

test('agent transcripts are found and attributed to the session that spawned them', async () => {
  // A workflow's fan-out lives at <project>/<PARENT-UUID>/subagents/workflows/<wf>/agent-*.jsonl.
  // The parent is not inferred from content — it IS the directory. That is why this beats
  // every heuristic tried against agentName / cwd / bridgeSessionId, each of which was wrong.
  // These files were invisible before: the UUID filename gate skips agent-<hex>.jsonl and the
  // scan never recursed, hiding 33% of billed tokens on this machine.
  const { mkdirSync: mk } = await import('fs');
  writeTranscript(SID, msg(100, 20));
  const wf = join(projectDir, SID, 'subagents', 'workflows', 'wf_abc123');
  mk(wf, { recursive: true });
  writeFileSync(join(wf, 'agent-a1b2c3d4.jsonl'), msg(500, 60));
  writeFileSync(join(projectDir, SID, 'subagents', 'agent-deadbeef.jsonl'), msg(7, 3));
  // journal.jsonl is the workflow's own bookkeeping, NOT a session — reporting it would
  // invent a row with no tokens and no meaning.
  writeFileSync(join(wf, 'journal.jsonl'), '{"note":"not a session"}\n');

  const all = await readNativeSessionUsage();
  const parent = all.find(s => s.session_id === SID);
  const agents = all.filter(s => s.parentSessionId);

  expect(parent!.parentSessionId).toBeUndefined();      // a top-level session has no parent
  expect(agents).toHaveLength(2);                       // journal excluded
  expect(agents.every(a => a.parentSessionId === SID)).toBe(true);

  const inWorkflow = agents.find(a => a.session_id === 'agent-a1b2c3d4');
  expect(inWorkflow!.workflowId).toBe('wf_abc123');
  expect(inWorkflow!.input_tokens).toBe(500);
  const plain = agents.find(a => a.session_id === 'agent-deadbeef');
  expect(plain!.workflowId).toBeUndefined();            // not every agent belongs to a workflow

  // The parent's own tokens stay its own — an agent's spend is NOT folded into it, so the
  // two are never double-counted in a fleet total.
  expect(parent!.input_tokens).toBe(100);
});

/** The record Claude Code writes when it dispatches an agent. It is the ONLY place the
 *  human-readable label exists: the agent's own transcript carries `agentId` and
 *  `attributionAgent` (the TYPE, e.g. "general-purpose") but never the description. */
const dispatch = (agentId: string, description: string) => JSON.stringify({
  type: 'user',
  toolUseResult: { agentId, description, status: 'async_launched', isAsync: true },
}) + '\n';

test('a teammate reports the FULL session id of the team it belongs to', async () => {
  // teamName is only 'session-<8hex>', so the cockpit resolved a teammate's parent by
  // matching that prefix against sessions that happened to be on the board — a guess that
  // fails whenever the parent is off-window, and one that two sessions sharing eight hex
  // characters would get wrong outright. Claude Code records the answer: every team dir
  // carries config.json with leadSessionId, the parent's full uuid. 19 of 19 teams on this
  // machine have it.
  const { mkdirSync: mk } = await import('fs');
  const cfgDir = mkdtempSync(join(tmpdir(), 'cm-cfg-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  try {
    const team = join(cfgDir, 'teams', 'session-88efc704');
    mk(team, { recursive: true });
    writeFileSync(join(team, 'config.json'), JSON.stringify({
      name: 'session-88efc704', leadSessionId: '88efc704-177b-46ee-8451-acf9c38b8fea',
    }));
    writeTranscript(SID, JSON.stringify({ type: 'agent-setting', agentSetting: 'general-purpose', teamName: 'session-88efc704' }) + '\n' + msg(10, 2));

    const [s] = await readNativeSessionUsage();
    expect(s!.teamName).toBe('session-88efc704');
    expect(s!.teamLeadSession).toBe('88efc704-177b-46ee-8451-acf9c38b8fea');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('a team with no config on disk reports no lead, rather than a guessed one', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'cm-cfg-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  try {
    writeTranscript(SID, JSON.stringify({ type: 'agent-setting', agentSetting: 'general-purpose', teamName: 'session-deadbeef' }) + '\n' + msg(10, 2));
    const [s] = await readNativeSessionUsage();
    expect(s!.teamName).toBe('session-deadbeef');
    expect(s!.teamLeadSession).toBeUndefined();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('an agent is named by the record that dispatched it', async () => {
  // Agents used to render as a bare hex id — "a3bfc79e" tells you nothing about what is
  // burning 250k tokens. The name is in the PARENT's dispatch record, and the parent is
  // already read on the same poll, so this costs no extra I/O.
  const { mkdirSync: mk } = await import('fs');
  writeTranscript(SID, msg(100, 20) + dispatch('a1b2c3d4', 'QA 35-point review'));
  const sub = join(projectDir, SID, 'subagents');
  mk(sub, { recursive: true });
  writeFileSync(join(sub, 'agent-a1b2c3d4.jsonl'), msg(500, 60));

  const agent = (await readNativeSessionUsage()).find(s => s.parentSessionId);
  expect(agent!.agentName).toBe('QA 35-point review');
});

test('a dispatch record never renames the session that issued it', async () => {
  // The hazard in harvesting a name from the parent's own lines: the description belongs to
  // the AGENT. Folding it into the parent would silently rename a live session on the board.
  writeTranscript(SID, JSON.stringify({ type: 'assistant', customTitle: 'CPT-TOP' }) + '\n'
    + msg(10, 2) + dispatch('a1b2c3d4', 'Security vulnerability analysis'));
  const parent = (await readNativeSessionUsage()).find(s => s.session_id === SID);
  expect(parent!.agentName).toBe('CPT-TOP');
});

test('a workflow agent is named by the workflow that ran it', async () => {
  // A workflow's fan-out is dispatched by the Workflow tool, NOT the Agent tool, so no
  // dispatch record exists and the journal keys on a hash. Three such agents rendered as
  // "ad43ff7e / a4c61a9a / ab6d5912" — three anonymous hex ids burning 1M tokens between
  // them, with nothing on screen saying they were one workflow. The name IS on disk: the
  // Workflow tool persists its script as <meta.name>-<wf id>.js.
  const { mkdirSync: mk } = await import('fs');
  writeTranscript(SID, msg(100, 20));
  const wf = join(projectDir, SID, 'subagents', 'workflows', 'wf_2eca1a5b-9d5');
  mk(wf, { recursive: true });
  writeFileSync(join(wf, 'agent-ad43ff7e.jsonl'), msg(370, 43));
  const scripts = join(projectDir, SID, 'workflows', 'scripts');
  mk(scripts, { recursive: true });
  writeFileSync(join(scripts, 'api-parity-check-wf_2eca1a5b-9d5.js'), '// the script\n');

  const agent = (await readNativeSessionUsage()).find(s => s.workflowId);
  expect(agent!.workflowName).toBe('api-parity-check');
});

test('a workflow reports what it is FOR, not just its name', async () => {
  // Three members repeating "settings-ui-lock · <hex>" spend a whole row each saying
  // the same thing. The run's own description is the information a board actually lacks, and
  // the Workflow tool REQUIRES meta to be a pure literal, so it can be read without evaluating
  // anything. Per-agent labels are deliberately NOT taken: they exist only in the running
  // process (absent from every transcript, the journal keys on a content hash), so any mapping
  // would be a guess.
  const { mkdirSync: mk } = await import('fs');
  writeTranscript(SID, msg(100, 20));
  const wf = join(projectDir, SID, 'subagents', 'workflows', 'wf_7224dc7e-848');
  mk(wf, { recursive: true });
  writeFileSync(join(wf, 'agent-a4985ecf.jsonl'), msg(405, 11));
  const scripts = join(projectDir, SID, 'workflows', 'scripts');
  mk(scripts, { recursive: true });
  writeFileSync(join(scripts, 'settings-ui-lock-wf_7224dc7e-848.js'),
    "export const meta = {\n  name: 'settings-ui-lock',\n"
    + "  description: 'Admin UI for the four geo_filter_* tables, plus a system-row lock',\n"
    + "  phases: [\n    { title: 'Investigate', detail: 'x' },\n    { title: 'Verify', detail: 'y' },\n  ],\n}\n");

  const agent = (await readNativeSessionUsage()).find(s => s.workflowId);
  expect(agent!.workflowName).toBe('settings-ui-lock');
  expect(agent!.workflowDescription).toBe('Admin UI for the four geo_filter_* tables, plus a system-row lock');
});

test('a script with no description yields a name and nothing invented', async () => {
  const { mkdirSync: mk } = await import('fs');
  writeTranscript(SID, msg(100, 20));
  const wf = join(projectDir, SID, 'subagents', 'workflows', 'wf_bare-001');
  mk(wf, { recursive: true });
  writeFileSync(join(wf, 'agent-a4985ecf.jsonl'), msg(9, 1));
  const scripts = join(projectDir, SID, 'workflows', 'scripts');
  mk(scripts, { recursive: true });
  writeFileSync(join(scripts, 'bare-run-wf_bare-001.js'), "export const meta = { name: 'bare-run' }\n");

  const agent = (await readNativeSessionUsage()).find(s => s.workflowId);
  expect(agent!.workflowName).toBe('bare-run');
  expect(agent!.workflowDescription).toBeUndefined();
});

test('a workflow script filed under a different PROJECT dir is still found', async () => {
  // Observed live: a session whose cwd differs when it launches a workflow persists the
  // script under THAT project's directory, while the agents stay filed under the project the
  // session belongs to. Same session id, two project dirs — so looking only beside the agents
  // left the run showing as a bare wf_ id. Both of this session's own workflows hit it.
  const { mkdirSync: mk } = await import('fs');
  writeTranscript(SID, msg(100, 20));
  const wf = join(projectDir, SID, 'subagents', 'workflows', 'wf_70ad7cf8-268');
  mk(wf, { recursive: true });
  writeFileSync(join(wf, 'agent-a237ad11.jsonl'), msg(73, 4));

  // the script lands under a DIFFERENT project dir, same session id
  const otherProject = join(root, '-home-user-somewhere-else');
  const scripts = join(otherProject, SID, 'workflows', 'scripts');
  mk(scripts, { recursive: true });
  writeFileSync(join(scripts, 'audit-second-pass-wf_70ad7cf8-268.js'),
    "export const meta = {\n  name: 'audit-second-pass',\n  description: 'Verify the dropped findings',\n}\n");

  const agent = (await readNativeSessionUsage()).find(s => s.workflowId);
  expect(agent!.workflowName).toBe('audit-second-pass');
  expect(agent!.workflowDescription).toBe('Verify the dropped findings');
});

test('a workflow with no persisted script leaves the agent unnamed, not mislabelled', async () => {
  // Never borrow a neighbouring workflow's name: two workflows under one session would then
  // both claim the first one's, which reads as fact and is false.
  const { mkdirSync: mk } = await import('fs');
  writeTranscript(SID, msg(100, 20));
  const wf = join(projectDir, SID, 'subagents', 'workflows', 'wf_unknown-001');
  mk(wf, { recursive: true });
  writeFileSync(join(wf, 'agent-ad43ff7e.jsonl'), msg(9, 1));
  const scripts = join(projectDir, SID, 'workflows', 'scripts');
  mk(scripts, { recursive: true });
  writeFileSync(join(scripts, 'some-other-run-wf_2eca1a5b-9d5.js'), '// a DIFFERENT workflow\n');

  const agent = (await readNativeSessionUsage()).find(s => s.workflowId);
  expect(agent!.workflowName).toBeUndefined();
});

test('an agent with no dispatch record is left unnamed rather than invented', async () => {
  // Measured: 19 of 682 agent transcripts on this machine have no dispatch record — a
  // workflow fan-out, or a parent whose record predates the transcript. Unnamed is honest;
  // a made-up label is not.
  const { mkdirSync: mk } = await import('fs');
  writeTranscript(SID, msg(100, 20));
  const sub = join(projectDir, SID, 'subagents');
  mk(sub, { recursive: true });
  writeFileSync(join(sub, 'agent-deadbeef.jsonl'), msg(7, 3));

  const agent = (await readNativeSessionUsage()).find(s => s.parentSessionId);
  expect(agent!.agentName).toBeUndefined();
});

test('a workflow agent the journal says FINISHED is not reported as running', async () => {
  // Liveness was transcript-mtime inside a 30-minute window — right for a session, where a
  // person idles between prompts, and wrong for an agent, which is a one-shot task that
  // either writes or is done. A 12-agent workflow that had completed sat on the board reading
  // ACTIVE for another ~20 minutes, and its tokens kept counting toward "what is running".
  // No heuristic is needed: the workflow journal records a `result` line per finished agent.
  const { mkdirSync: mk } = await import('fs');
  writeTranscript(SID, msg(100, 20));
  const wf = join(projectDir, SID, 'subagents', 'workflows', 'wf_70ad7cf8-268');
  mk(wf, { recursive: true });
  writeFileSync(join(wf, 'agent-a237ad11.jsonl'), msg(83, 1));   // finished
  writeFileSync(join(wf, 'agent-abbbbbbb.jsonl'), msg(50, 2));   // still running
  writeFileSync(join(wf, 'journal.jsonl'),
    JSON.stringify({ type: 'started', key: 'v2:x', agentId: 'a237ad11' }) + '\n'
    + JSON.stringify({ type: 'started', key: 'v2:y', agentId: 'abbbbbbb' }) + '\n'
    + JSON.stringify({ type: 'result', key: 'v2:x', agentId: 'a237ad11', result: 'done' }) + '\n');

  const agents = (await readNativeSessionUsage()).filter(s => s.workflowId);
  expect(agents.map(a => a.session_id)).toEqual(['agent-abbbbbbb']);   // the finished one is gone
});

test('a LIFETIME scan counts finished workflow agents; a live scan still hides them', async () => {
  // Retiring finished agents is right for "what is running now" and WRONG for "what has this
  // ever cost". Applying one rule to both silently removed 2,634 agent transcripts worth
  // 188.9M billed tokens from the all-time total on this machine — a 27% understatement,
  // introduced by the liveness fix itself. The two questions need different answers from the
  // same scan.
  const { mkdirSync: mk } = await import('fs');
  writeTranscript(SID, msg(100, 20));
  const wf = join(projectDir, SID, 'subagents', 'workflows', 'wf_done-001');
  mk(wf, { recursive: true });
  writeFileSync(join(wf, 'agent-a237ad11.jsonl'), msg(500, 60));   // finished
  writeFileSync(join(wf, 'journal.jsonl'),
    JSON.stringify({ type: 'started', key: 'v2:x', agentId: 'a237ad11' }) + '\n'
    + JSON.stringify({ type: 'result', key: 'v2:x', agentId: 'a237ad11', result: 'done' }) + '\n');

  const live = (await readNativeSessionUsage()).filter(s => s.workflowId);
  expect(live).toHaveLength(0);                       // the board must not show it as running

  _resetNativeUsageCache();
  const lifetime = (await readNativeSessionUsage(30 * 60_000, Date.now(), undefined, { includeFinished: true }))
    .filter(s => s.workflowId);
  expect(lifetime).toHaveLength(1);                   // but its spend is real and must be counted
  expect(lifetime[0]!.input_tokens).toBe(500);
});

test('a workflow with no journal reports every agent, rather than none', async () => {
  // Absence of evidence is not evidence of completion: if the journal is missing or
  // unreadable, every agent stays reported. Hiding live work is worse than showing stale.
  const { mkdirSync: mk } = await import('fs');
  writeTranscript(SID, msg(100, 20));
  const wf = join(projectDir, SID, 'subagents', 'workflows', 'wf_nojournal');
  mk(wf, { recursive: true });
  writeFileSync(join(wf, 'agent-a237ad11.jsonl'), msg(83, 1));
  const agents = (await readNativeSessionUsage()).filter(s => s.workflowId);
  expect(agents).toHaveLength(1);
});

test('an idle agent falls out of the window like any other session', async () => {
  const { mkdirSync: mk } = await import('fs');
  writeTranscript(SID, msg(10, 2));
  const sub = join(projectDir, SID, 'subagents');
  mk(sub, { recursive: true });
  const p = join(sub, 'agent-0f0f0f0f.jsonl');
  writeFileSync(p, msg(999, 99));
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  utimesSync(p, old, old);
  expect((await readNativeSessionUsage()).filter(s => s.parentSessionId)).toHaveLength(0);
});

test('a session with no agents costs nothing and reports nothing extra', async () => {
  writeTranscript(SID, msg(10, 2));
  const all = await readNativeSessionUsage();
  expect(all).toHaveLength(1);
  expect(all[0]!.parentSessionId).toBeUndefined();
});

test('a session whose PROCESS is alive is never aged out of the window', async () => {
  // Transcript mtime asks "did this write recently", which is a PROXY for "does this
  // session exist". When the runtime state says the process is alive, that is direct
  // evidence and it wins. Reported from use: a session idle 32 minutes vanished from the
  // fleet board while its terminal sat open, taking its name and its tokens with it.
  const p = writeTranscript(SID, msg(100, 20));
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  utimesSync(p, old, old);

  expect(await readNativeSessionUsage(30 * 60_000)).toHaveLength(0);          // idle, no evidence
  const alive = new Set([SID]);
  const kept = await readNativeSessionUsage(30 * 60_000, Date.now(), alive);
  expect(kept).toHaveLength(1);                                              // alive ⇒ kept
  expect(kept[0]!.input_tokens).toBe(100);                                   // with its real totals
});

test('liveSessionIds ignores a stale file whose process is gone', async () => {
  const { liveSessionIds } = await import('../../src/shared/../worker/native-session-usage.ts');
  const { mkdirSync: mk } = await import('fs');
  const cfg = join(root, 'claude-config');
  mk(join(cfg, 'sessions'), { recursive: true });
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    // pid 1 is init: alive, but the guard rejects it as a plausible session owner.
    writeFileSync(join(cfg, 'sessions', '1.json'), JSON.stringify({ pid: 1, sessionId: 'init-not-a-session' }));
    // a pid that cannot exist — the file is a leftover from a dead session
    writeFileSync(join(cfg, 'sessions', '4194300.json'), JSON.stringify({ pid: 4194300, sessionId: 'ghost' }));
    // our own pid IS alive
    writeFileSync(join(cfg, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'real-one' }));
    writeFileSync(join(cfg, 'sessions', 'garbage.json'), 'not json at all');

    const ids = liveSessionIds();
    expect(ids.has('real-one')).toBe(true);
    expect(ids.has('ghost')).toBe(false);
    expect(ids.has('init-not-a-session')).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('entrypoint is captured — the difference between a session and an automation', async () => {
  // On a working machine automated invocations outnumber sessions a person opened by
  // roughly 11:1 (45 sdk-py to 4 cli, measured 2026-07-28). Calling them all "sessions"
  // hides the distinction that matters most on a fleet board, and `entrypoint` is the
  // session's own statement of how it came into being — no inference required.
  writeTranscript(SID, JSON.stringify({
    type: 'assistant', entrypoint: 'sdk-py', cwd: '/w',
    message: { role: 'assistant', usage: { input_tokens: 10, output_tokens: 2 } },
  }) + '\n');
  const [s] = await readNativeSessionUsage();
  expect(s!.entrypoint).toBe('sdk-py');
});

test('a session that never states an entrypoint reports none, rather than a guess', async () => {
  writeTranscript(SID, msg(5, 1));
  const [s] = await readNativeSessionUsage();
  expect(s!.entrypoint).toBeUndefined();
});

test('a narrow poll does not evict what a wide scan just built', () => {
  // THE THRASH. The prune keeps only what THIS call saw live, so the 10s poll (4 live
  // transcripts) evicted everything the 5-minute 365-day scan had accumulated — and that scan
  // then re-read 2.4 GB from scratch every cycle: 32.9s cold against 1.6s warm, ~30s of CPU
  // every five minutes, which starved the search thread and timed out inbound RPCs. Two
  // windows sharing one cache, where the narrow one wins.
  const src = readFileSync(join(import.meta.dir, '../../src/worker/native-session-usage.ts'), 'utf8');
  // The prune must not be keyed on this call's live set alone.
  expect(src).not.toMatch(/for \(const path of ACC\.keys\(\)\) if \(!live\.has\(path\)\) ACC\.delete\(path\);/);
  // It must be keyed on staleness instead — an accumulator nobody has touched for a while.
  expect(src).toMatch(/lastTouchedMs/);
});

// THE LOOP, with the clock injected. A scan stamps what it touches with its START and a scan prunes against its own
// later `now`, so a wide scan that is still running 20 minutes in had its finished work evicted by the next /stats
// recompute (its 30-minute scan), ended with an empty cache, and the next one (5 minutes on) began cold again. A cold
// read of a few GB of transcripts outlasts 20 minutes on a loaded box, so the writer thread sat at a full core
// indefinitely. The accumulator's survival is observed by rewriting the transcript in place at the SAME size: a re-read
// would see the new numbers, an accumulator that survived still reports the old ones.
const MIN = 60_000;
const WIDE = 365 * 24 * 60 * MIN;

test('a poll that ends long after a wide scan began does not evict the wide scan\'s work', async () => {
  const p = writeTranscript(SID, msg(111, 22));
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  utimesSync(p, old, old);                                    // idle: only the wide scan ever touches it
  const t0 = Date.now();
  await readNativeSessionUsage(WIDE, t0, undefined, { includeFinished: true });                  // the wide scan reads it
  await readNativeSessionUsage(30 * MIN, t0 + 21 * MIN, undefined, { includeFinished: true });   // a poll, 21 minutes later
  writeFileSync(p, msg(222, 33));                             // same byte length, different tokens
  utimesSync(p, old, old);
  const [s] = await readNativeSessionUsage(WIDE, t0 + 26 * MIN, undefined, { includeFinished: true });
  expect(s!.input_tokens).toBe(111);                          // served from the accumulator, not re-read from byte 0
  expect(s!.output_tokens).toBe(22);
});

test('a wide scan still drops the accumulator of a transcript it no longer finds', async () => {
  // The prune exists so a long-running worker's memory tracks the sessions still in play; moving it to the wide scan
  // must not have removed it.
  const p = writeTranscript(SID, msg(111, 22));
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  utimesSync(p, old, old);
  const t0 = Date.now();
  await readNativeSessionUsage(WIDE, t0, undefined, { includeFinished: true });
  rmSync(p);
  await readNativeSessionUsage(WIDE, t0 + 25 * MIN, undefined, { includeFinished: true });       // not found, 25 min idle: pruned
  const q = writeTranscript(SID, msg(222, 33));
  utimesSync(q, old, old);
  const [s] = await readNativeSessionUsage(WIDE, t0 + 26 * MIN, undefined, { includeFinished: true });
  expect(s!.input_tokens).toBe(222);                          // a fresh accumulator, not the pruned one's 111
});

test('the read offset counts the bytes read, so a stray invalid UTF-8 byte cannot push it past the file', async () => {
  // The offset used to be the byte length of the DECODED string, and an invalid byte decodes to U+FFFD, three bytes long:
  // the offset ran two bytes past the end of what had been read and the next append lost its first two bytes for good (the
  // line then failed to parse). Valid multi-byte text (Cyrillic, an emoji) must keep counting exactly.
  const p = join(projectDir, `${SID}.jsonl`);
  writeFileSync(p, Buffer.concat([
    Buffer.from(JSON.stringify({ type: 'user', text: 'Здравей, свят 🚀' }) + '\n'),
    Buffer.from('{"type":"user","text":"bad byte: '), Buffer.from([0xff]), Buffer.from('"}\n'),
    Buffer.from(msg(100, 10)),
  ]));
  await readNativeSessionUsage();
  appendFileSync(p, msg(7, 3));
  const [s] = await readNativeSessionUsage();
  expect(s!.input_tokens).toBe(107);                          // the appended message was read from its first byte
  expect(s!.output_tokens).toBe(13);
});

test('each field the scan reads is picked up from a line that carries no usage', async () => {
  // digest() parses only lines that hold a key it acts on. The tests above put these fields on lines that also carry
  // usage, which would stay green if the key list forgot one; here every field sits on a line of its own.
  const only = (o: Record<string, unknown>) => JSON.stringify({ type: 'user', ...o }) + '\n';
  const SID2 = '0b6f1c2e-5a7d-4e38-9c41-7d2a8e5f3b60';
  const CWD = '/home/user/projects/thing';
  writeTranscript(SID, only({ cwd: CWD }) + only({ entrypoint: 'sdk-cli' }) + only({ agentName: 'NAMED' })
    + only({ bridgeSessionId: 'cse_9' }) + only({ teamName: 'session-0a1b2c3d' }) + only({ type: 'agent-setting', agentSetting: 'general-purpose' })
    + msg(5, 1));
  writeTranscript(SID2, only({ customTitle: 'TITLED' }) + msg(5, 1));

  const rows = await readNativeSessionUsage();
  const s = rows.find(r => r.session_id === SID)!;
  expect(s.cwd).toBe(CWD);
  expect(s.entrypoint).toBe('sdk-cli');
  expect(s.agentName).toBe('NAMED');
  expect(s.ownerSession).toBe('cse_9');
  expect(s.teamName).toBe('session-0a1b2c3d');
  expect(s.agentSetting).toBe('general-purpose');
  expect(rows.find(r => r.session_id === SID2)!.agentName).toBe('TITLED');
});

test('the byte-level line filter reads a synthetic set exactly as the string-based digest did', async () => {
  // DIFFERENTIAL. The expected rows below were produced by the module as it stood BEFORE digest() learned to skip lines
  // (run on this very file set, at this fixed clock) and frozen here. The set is built to be hostile to a key filter: key
  // names inside an escaped string and as bare VALUES, wrong types, a malformed line that names usage, first-wins fields
  // repeated (the first must still win) and arriving late on lines of their own, an agentSetting key without the
  // agent-setting type, an incomplete dispatch, streamed partial usage, records with no id, a message outside the window,
  // one 1.2 MB line of multi-byte text that crosses the 1 MB read piece, and a write in flight with no newline.
  const T = Date.UTC(2026, 9, 14, 12, 0, 0);
  const stamp = (minAgo: number) => new Date(T - minAgo * 60_000).toISOString();
  const rec = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';
  const use = (id: string | undefined, i: number, o: number, minAgo = 10, extra: Record<string, unknown> = {}) => rec({
    type: 'assistant', timestamp: stamp(minAgo),
    message: { ...(id ? { id } : {}), role: 'assistant', content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: 3, cache_read_input_tokens: 5 } },
    ...extra,
  });
  const put = (p: string, body: string) => { writeFileSync(p, body); utimesSync(p, T / 1000, T / 1000); };
  const A = '46ab9cc1-777d-4179-ba55-609de944146c', B = '0b6f1c2e-5a7d-4e38-9c41-7d2a8e5f3b60';
  put(join(projectDir, `${A}.jsonl`),
    '\n'
    + rec({ type: 'user', message: { role: 'user', content: 'he said "usage", "cwd" and "agentName" in a sentence' } })
    + rec({ type: 'usage', note: 'cwd' }) + rec({ type: 'cwd', agentName: 7 })
    + use('m1', 100, 10) + use('m1', 100, 25) + use('m1', 100, 25)
    + rec({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] } })
    + use('m2', 200, 20) + use(undefined, 7, 1) + use(undefined, 7, 1)
    + '{"message":{"usage":{"input_tokens":50,"output_tokens"\n'
    + rec({ cwd: '/first/cwd' }) + rec({ cwd: '/second/cwd' }) + rec({ entrypoint: 'sdk-cli' }) + rec({ entrypoint: 'cli' })
    + rec({ agentName: 'A-NAME', customTitle: 'A-TITLE' }) + rec({ bridgeSessionId: 'cse_1' })
    + rec({ type: 'agent-setting', agentSetting: 'general-purpose', teamName: 'session-deadbeef' })
    + rec({ toolUseResult: { agentId: 'cafe01', description: 'Dispatched QA' } })
    + rec({ toolUseResult: { agentId: 'cafe02' } }) + rec({ toolUseResult: { agentId: 'cafe03', description: 42 } })
    + use('m3', 300, 30, 50)
    + rec({ type: 'user', message: { role: 'user', content: 'Здравей, свят 🚀 '.repeat(40_000) } })
    + use('m4', 400, 40, 5, { cwd: '/ignored/third' })
    + '{"type":"assistant","message":{"usage":{"input_tokens":999');
  put(join(projectDir, `${B}.jsonl`),
    rec({ type: 'user', agentSetting: 'not-an-agent' }) + rec({ customTitle: 'B-TITLE' }) + rec({ agentName: 'B-LATER' }) + use('b1', 1, 2));
  const sub = join(projectDir, A, 'subagents');
  mkdirSync(sub, { recursive: true });
  put(join(sub, 'agent-cafe01.jsonl'), rec({ cwd: '/agent/cwd' }) + use('a1', 11, 2));
  put(join(sub, 'agent-cafe02.jsonl'), rec({ agentName: 'AGENT-OWN' }) + use('a2', 12, 3));

  const cfg = mkdtempSync(join(tmpdir(), 'cm-native-cfg-'));   // teamLeadSession() reads CLAUDE_CONFIG_DIR/teams
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const rows = await readNativeSessionUsage(30 * MIN, T + MIN, undefined, { includeFinished: true });
    rows.sort((a, b) => (a.session_id < b.session_id ? -1 : 1));
    const at = 1791979200000;   // T: the mtime every file was given
    expect(rows).toEqual([
      { session_id: B, window_fresh_tokens: 4, window_output_tokens: 2, window_cache_read_tokens: 5, input_tokens: 1, output_tokens: 2,
        cache_creation_tokens: 3, cache_read_tokens: 5, last_activity_epoch_ms: at, agentName: 'B-TITLE' },
      { session_id: A, window_fresh_tokens: 729, window_output_tokens: 87, window_cache_read_tokens: 25, input_tokens: 1014, output_tokens: 117,
        cache_creation_tokens: 18, cache_read_tokens: 30, last_activity_epoch_ms: at, cwd: '/first/cwd', agentName: 'A-NAME',
        ownerSession: 'cse_1', entrypoint: 'sdk-cli', agentSetting: 'general-purpose', teamName: 'session-deadbeef' },
      { session_id: 'agent-cafe01', window_fresh_tokens: 14, window_output_tokens: 2, window_cache_read_tokens: 5, input_tokens: 11, output_tokens: 2,
        cache_creation_tokens: 3, cache_read_tokens: 5, last_activity_epoch_ms: at, parentSessionId: A, cwd: '/agent/cwd', agentName: 'Dispatched QA' },
      { session_id: 'agent-cafe02', window_fresh_tokens: 15, window_output_tokens: 3, window_cache_read_tokens: 5, input_tokens: 12, output_tokens: 3,
        cache_creation_tokens: 3, cache_read_tokens: 5, last_activity_epoch_ms: at, parentSessionId: A, agentName: 'AGENT-OWN' },
    ]);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    rmSync(cfg, { recursive: true, force: true });
  }
});

test('a SECOND workflow in the same session is still named', async () => {
  // The cache is keyed on sessionId but holds "the wf ids that existed the first time this
  // session was scanned". A session runs many workflows — ten in one session on this host — so
  // caching that set permanently blanked the name and description of every workflow launched
  // after the first scan, for the life of the worker. That is the exact bug the naming feature
  // was built to fix, reintroduced six hours later by its own performance optimisation.
  const { mkdirSync: mk } = await import('fs');
  writeTranscript(SID, msg(100, 20));
  const scripts = join(projectDir, SID, 'workflows', 'scripts');
  mk(scripts, { recursive: true });

  const addWf = (wfid: string, name: string, agentHex: string) => {
    const d = join(projectDir, SID, 'subagents', 'workflows', wfid);
    mk(d, { recursive: true });
    // agent-<hex>.jsonl only — AGENT_FILE_RE rejects anything else, deliberately, so that a
    // workflow's own journal.jsonl is never mistaken for an agent.
    writeFileSync(join(d, `agent-${agentHex}.jsonl`), msg(50, 5));
    writeFileSync(join(scripts, `${name}-${wfid}.js`), `export const meta = { name: '${name}' }\n`);
  };

  addWf('wf_aaaa-001', 'first-run', 'a1a1a1a1');
  let rows = (await readNativeSessionUsage()).filter(s => s.workflowId === 'wf_aaaa-001');
  expect(rows[0]!.workflowName).toBe('first-run');

  // SAME session, a second workflow launched later — the cache must not hide it.
  addWf('wf_bbbb-002', 'second-run', 'b2b2b2b2');
  rows = (await readNativeSessionUsage()).filter(s => s.workflowId === 'wf_bbbb-002');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.workflowName).toBe('second-run');
});

test('an idle transcript that resumes is read INCREMENTALLY, never re-read whole', async () => {
  // Releasing the id map for an idle transcript bounded memory but moved the cost the whole
  // change existed to remove onto the hot path: the all-time scan seals essentially every
  // transcript, so a session you resume after lunch made the next 10-second poll re-read the
  // entire file. That is the rhythm of an ordinary working day, not an edge case.
  //
  // A BOUNDED RING of recent ids fixes it without the rebuild: the duplicate records of one
  // message are adjacent in the file, so a few hundred ids preserve dedupe across an append at
  // a fixed, tiny cost — and with no rebuild branch there is no window in which a concurrent
  // scan can digest into an emptied map and double-count.
  const p = writeTranscript(SID, msgId('msg_1', 100, 10) + msgId('msg_1', 100, 10));
  await readNativeSessionUsage();

  // Make it look long-idle, then scan wide (the path that seals).
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  utimesSync(p, old, old);
  await readNativeSessionUsage(365 * 24 * 60 * 60_000, Date.now(), undefined, { includeFinished: true });

  // It resumes: one appended message, plus a repeat of the LAST one already counted.
  appendFileSync(p, msgId('msg_1', 100, 10) + msgId('msg_2', 7, 3));
  const [s] = await readNativeSessionUsage(365 * 24 * 60 * 60_000, Date.now(), undefined, { includeFinished: true });
  expect(s!.input_tokens).toBe(107);      // 100 once + 7 — the repeat must NOT be recounted
  expect(s!.output_tokens).toBe(13);
});
