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

test('a workflow sub-task agent reports its name and its owner', async () => {
  // Workflow agents each get their OWN top-level transcript with its own uuid, so a dozen
  // of them read as a dozen unrelated sessions — all in one project, indistinguishable by
  // cwd. They do record who they are (agentName, from `--resume <name>`) and who launched
  // them (bridgeSessionId), which is the only reliable way to group them.
  const line = (extra: Record<string, unknown>) => JSON.stringify({
    type: 'assistant', cwd: '/home/kalin/projects/thing', ...extra,
    message: { role: 'assistant', usage: { input_tokens: 10, output_tokens: 2 } },
  }) + '\n';
  writeTranscript(SID, line({ agentName: 'GEOMAP-REVAMP-V1', bridgeSessionId: 'cse_01ABC' }) + line({}));
  const [s] = await readNativeSessionUsage();
  expect(s!.agentName).toBe('GEOMAP-REVAMP-V1');
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
  writeFileSync(join(scripts, 'geomap-netline-parity-wf_2eca1a5b-9d5.js'), '// the script\n');

  const agent = (await readNativeSessionUsage()).find(s => s.workflowId);
  expect(agent!.workflowName).toBe('geomap-netline-parity');
});

test('a workflow reports what it is FOR, not just its name', async () => {
  // Three members repeating "geomap-settings-ui-lock · <hex>" spend a whole row each saying
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
  writeFileSync(join(scripts, 'geomap-settings-ui-lock-wf_7224dc7e-848.js'),
    "export const meta = {\n  name: 'geomap-settings-ui-lock',\n"
    + "  description: 'Admin UI for the four geo_filter_* tables, plus a system-row lock',\n"
    + "  phases: [\n    { title: 'Investigate', detail: 'x' },\n    { title: 'Verify', detail: 'y' },\n  ],\n}\n");

  const agent = (await readNativeSessionUsage()).find(s => s.workflowId);
  expect(agent!.workflowName).toBe('geomap-settings-ui-lock');
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
