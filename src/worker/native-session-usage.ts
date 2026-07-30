// src/worker/native-session-usage.ts
//
// LIVE per-session token flow for NATIVE sessions — the ones the broker cannot see.
//
// A brokered co-session routes its LLM traffic through the captain, so the broker
// meters it exactly. A session the user started themselves (`claude` in a terminal,
// a tmux pane the ambient scanner reports) talks straight to the provider: that
// traffic never crosses this machine's proxy, so there is nothing to meter.
//
// But it is not invisible. Every such session still WRITES A TRANSCRIPT locally, and
// every assistant message in it carries the provider's own `usage` block. So the
// numbers are on disk already — this module reads them rather than intercepting
// anything. The transcript is also the authority, not an estimate: it is what the
// provider reported, not a local tokenizer's guess.
//
// The join to memory's side is free: **the transcript filename IS the session_id**,
// the same id recall-audit.jsonl records against each injection. One id, both halves
// — what a session spent on the model, and what memory contributed to it.
//
// INCREMENTAL, like dream-stats: a transcript is append-only and can reach tens of
// thousands of lines, so a per-path accumulator holds the running totals plus the
// byte offset already parsed, and each poll reads only what was appended. Re-reading
// whole transcripts on a ~10s cadence is what this exists to avoid.

import { stat, open, readdir, readFile } from 'fs/promises';
import { readdirSync, readFileSync } from 'fs';
import type { Dirent } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

/** Provider-reported usage for one native session, summed over its transcript. */
export interface NativeSessionUsage {
  /** Claude Code session id — the transcript's basename, and the same id the recall
   *  audit records, which is what makes the two halves joinable. */
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  /** Transcript mtime — when the session last produced a message. */
  last_activity_epoch_ms: number;
  /** The session's own name, when it has one (workflow sub-task agents do). */
  agentName?: string | undefined;
  /** Set when the transcript declares itself an agent (teammates do, at top level). */
  agentSetting?: string | undefined;
  /** The team this teammate belongs to, shared across its members. */
  teamName?: string | undefined;
  /** How it was started: 'cli' (a person at a terminal), 'sdk-py' / 'sdk-cli' (a program).
   *  The distinction the fleet board needs most — automation outnumbers real sessions
   *  roughly 11:1 on a working machine. */
  entrypoint?: string | undefined;
  /** The session that OWNS this one. Present ONLY for agent transcripts, where it is not
   *  inferred at all: an agent's transcript lives at <project>/<PARENT-UUID>/subagents/...,
   *  so the parent id IS the directory name. Deterministic, unlike every heuristic tried
   *  against `agentName` / cwd / env, all of which were wrong. */
  parentSessionId?: string | undefined;
  /** The workflow that spawned it, when the path says so
   *  (<parent>/subagents/workflows/<wf_id>/agent-*.jsonl). Lets a UI group one workflow's
   *  fan-out together instead of scattering a dozen agents under their parent. */
  workflowId?: string | undefined;
  /** The workflow's own name ("geomap-netline-parity"). A workflow's fan-out is dispatched
   *  by the Workflow tool rather than the Agent tool, so it has no dispatch record to name
   *  it — three of them rendered as anonymous hex while burning a million tokens between
   *  them. Absent when the script is not on disk; never borrowed from a sibling run. */
  workflowName?: string | undefined;
  /** What the run is FOR, from `meta.description`. The board shows it once on the workflow
   *  row rather than repeating the name on every member. */
  workflowDescription?: string | undefined;
  /** The FULL session id of the team's lead, from `~/.claude/teams/<team>/config.json`.
   *  `teamName` carries only 'session-<8hex>', so without this a teammate's parent had to be
   *  guessed by prefix-matching the sessions that happened to be on the board — which fails
   *  whenever the parent is off-window, and is outright wrong for two sessions sharing eight
   *  hex characters. Claude Code records the answer; 19 of 19 teams here carry it. */
  teamLeadSession?: string | undefined;
  /** The owning session's edge id, so a UI can group agents under their parent. */
  ownerSession?: string | undefined;
  /** Tokens whose messages were WRITTEN INSIDE the requested window, not the session's
   *  lifetime. This is the number that composes: a lifetime sum selected by a window
   *  lurches by billions the moment a long-lived session writes one message and rejoins,
   *  because the window picks WHICH sessions while each is counted FOREVER. Two
   *  individually reasonable halves whose product means nothing. */
  window_fresh_tokens: number;
  window_output_tokens: number;
  window_cache_read_tokens: number;
  /** Working directory the session runs in, read from the transcript's own `cwd`.
   *
   *  This is the only RELIABLE label available. A tmux session name cannot be joined
   *  to a session id from outside the process: the CLI does not hold the transcript
   *  open (no fd to read), several panes routinely share one cwd, `--resume` makes a
   *  transcript predate its process so start-time correlation fails, and
   *  CLAUDE_CODE_SESSION_ID is INHERITED by child processes — three panes here report
   *  the same id. The transcript's own cwd is self-reported by the session itself, so
   *  it is exact. Absent on transcripts that never recorded one. */
  cwd?: string;
}

interface Bucket { fresh: number; output: number; cacheRead: number }

interface Totals {
  offset: number;   // bytes already parsed (always at a newline boundary)
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  cwd?: string;
  /** The session's own name when it has one — a workflow sub-task agent is launched with
   *  `--resume <name>` and records it as agentName/customTitle. Far more use than eight
   *  hex characters when a dozen of them share one project. */
  agentName?: string;
  /** The session that OWNS this one: a workflow agent records its parent's edge id here.
   *  Without it a fleet of sub-task agents reads as a dozen unrelated top-level sessions,
   *  because each one gets its own transcript with its own uuid. */
  ownerSession?: string;
  /** 'cli' | 'sdk-py' | 'sdk-cli' — how the session was started. */
  entrypoint?: string;
  /** Present when the transcript opens with a `type: agent-setting` record — the marker
   *  that this session IS an agent, whatever its file location. Teammates get a TOP-LEVEL
   *  transcript rather than one under <parent>/subagents/, so location alone missed them
   *  and they rendered as ordinary sessions. */
  agentSetting?: string;
  /** The team a teammate belongs to, shared by every member ('session-<8hex>'). Groups a
   *  team into one block. NOT treated as a parent pointer on its own: of three teams
   *  sampled, one named a session with no transcript and no live process, so resolving it
   *  is best-effort and the grouping has to stand without it. */
  teamName?: string;
  /** agentId → the label the operator wrote when dispatching that agent ("QA 35-point
   *  review"). Harvested from THIS session's lines because the dispatch record is the only
   *  place it exists — an agent's own transcript carries its id and its TYPE
   *  (`attributionAgent: general-purpose`) but never the description. Created lazily: most
   *  sessions dispatch nothing and should not pay for a Map. */
  dispatched?: Map<string, string>;
  /** Message ids already counted. Claude Code writes ONE assistant response as several
   *  records — thinking, tool_use, text — and each carries an identical copy of the same
   *  usage block, because the usage describes the MESSAGE, not the record. Summing per
   *  record inflated every reported figure by 2.5x-3.2x on real transcripts. Measured
   *  across four large ones: of 7,276 ids appearing more than once, NOT ONE carried
   *  differing usage — so counting the first copy is exact, not a heuristic.
   *
   *  Lives on the accumulator, not the chunk: the transcript is read in appended slices, so
   *  copies of one message routinely land in different reads. Bounded like the buckets — the
   *  whole accumulator is dropped when its session falls out of the window. */
  /** message id → the LARGEST usage seen for it. A Map, not a Set, because a repeat is not
   *  always a copy: agent transcripts stream partial usage under one id with growing output. */
  seenMsgIds: Map<string, { i: number; o: number; w: number; r: number }>;
  /** When this accumulator was last used by ANY scan. Pruning keys on this rather than on
   *  "was it live in the call that just ran": the 10s poll sees 4 transcripts and the 5-minute
   *  365-day scan sees 5,254, so keying on the caller's live set let the narrow scan evict
   *  everything the wide one had built — 32.9s cold against 1.6s warm, every five minutes. */
  lastTouchedMs: number;
  /** Byte size at which seenMsgIds was released. An idle, fully-read transcript does not need
   *  its per-message id map, which is the bulk of the memory; but if the file GROWS again we
   *  can no longer dedupe against what we already counted, so the accumulator is rebuilt from
   *  scratch for that one file. Correct, and bounded. */
  /** Per-MINUTE token buckets, keyed by floor(epochMs / 60000). Summing the buckets
   *  inside a window gives usage genuinely accrued in that window, and old buckets fall
   *  out on their own — so the figure decays instead of lurching. Bounded by pruning
   *  past MAX_BUCKET_MS, so a long-running worker holds at most a day per session. */
  buckets: Map<number, Bucket>;
}

/** How long an untouched accumulator survives. Must exceed the widest scan's TTL (the
 *  all-time scan re-runs every 5 minutes) or that scan evicts its own work between runs. */
const ACC_IDLE_MS = 20 * 60_000;
/** How many recent message ids each transcript remembers, for deduping the repeated usage
 *  blocks of one message. Bounds the memory of keeping accumulators alive; 512 is far more
 *  than the handful of records one message occupies.
 *
 *  Measured, because the obvious theory was wrong: varying this 32x (16 -> 512) moved RSS by
 *  less than the run-to-run GC noise, so the id map is NOT the dominant memory and there is no
 *  point tuning it further. It costs ~150-300 ms on a 5-minute scan versus releasing the map
 *  entirely, and buys back a full re-read of any resumed transcript on the 10-second poll plus
 *  a latent double-count where a release could land between a concurrent scan's read and its
 *  digest. */
const MSG_ID_MEMORY = 64;
/** How much bucket history to retain. Caps memory (1 440 buckets/session at worst) and
 *  bounds the widest window that can be asked for honestly. */
const MAX_BUCKET_MS = 24 * 60 * 60_000;
const BUCKET_MS = 60_000;

const ACC = new Map<string, Totals>();

function fresh(): Totals {
  return { offset: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, seenMsgIds: new Map(),
           lastTouchedMs: 0, buckets: new Map() };
}

/** A transcript line's shape, narrowed to the one field we read. Everything else in
 *  the line — the prompt, the response, tool calls — is deliberately untouched: this
 *  module reads COUNTS, never content, matching the corpus-telemetry posture. */
interface TranscriptLine {
  message?: { usage?: Record<string, unknown>; model?: string; id?: string };
  cwd?: string;
  type?: string;
  agentName?: string;
  customTitle?: string;
  bridgeSessionId?: string;
  /** Written when an agent is DISPATCHED (`status: 'async_launched'`), minutes before it
   *  finishes — so the name is available while the agent is still running, which is the
   *  only time a fleet board cares. */
  toolUseResult?: { agentId?: unknown; description?: unknown };
  entrypoint?: string;
  agentSetting?: string;
  teamName?: string;
  /** ISO-8601 stamp Claude Code writes on each record — what makes real windowing
   *  possible rather than approximated by file mtime. */
  timestamp?: string;
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Parse the complete lines in `chunk`, returning bytes consumed. A trailing partial
 *  line (a write in flight) is left for the next call, which re-reads it whole. */
function digest(chunk: string, t: Totals): number {
  const lastNl = chunk.lastIndexOf('\n');
  if (lastNl < 0) return 0;
  const complete = chunk.slice(0, lastNl + 1);
  for (const raw of complete.split('\n')) {
    if (!raw.trim()) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue;   // a truncated or non-JSON line is skipped, never fatal
    }
    // First cwd wins — a session does not move, and re-reading it on every line
    // would cost a string compare per message for no gain.
    if (t.cwd === undefined && typeof line.cwd === 'string' && line.cwd) t.cwd = line.cwd;
    if (t.agentName === undefined) {
      const nm = line.agentName ?? line.customTitle;
      if (typeof nm === 'string' && nm) t.agentName = nm;
    }
    // HOW this session came into being, which is what separates the three kinds a fleet
    // board has to tell apart: 'cli' is a person at a terminal, 'sdk-py' / 'sdk-cli' is a
    // programmatic invocation nobody opened. On this machine the latter outnumber the
    // former roughly 11:1, so calling them all "sessions" hides the distinction that
    // matters most.
    if (t.entrypoint === undefined && typeof line.entrypoint === 'string' && line.entrypoint) {
      t.entrypoint = line.entrypoint;
    }
    // The agent-setting record is the FIRST line of a teammate's transcript — the marker
    // that this session IS an agent regardless of where its file lives.
    if (t.agentSetting === undefined && line.type === 'agent-setting' && typeof line.agentSetting === 'string') {
      t.agentSetting = line.agentSetting;
    }
    if (t.teamName === undefined && typeof line.teamName === 'string' && line.teamName) {
      t.teamName = line.teamName;
    }
    if (t.ownerSession === undefined && typeof line.bridgeSessionId === 'string' && line.bridgeSessionId) {
      t.ownerSession = line.bridgeSessionId;
    }
    // An agent DISPATCH: record the label against the agent's id. Deliberately NOT folded
    // into t.agentName — the description names the agent, and assigning it here would
    // rename the live session that issued it.
    const disp = line.toolUseResult;
    if (disp && typeof disp.agentId === 'string' && typeof disp.description === 'string' && disp.description) {
      (t.dispatched ??= new Map()).set(disp.agentId, disp.description);
    }
    const u = line.message?.usage;
    if (!u || typeof u !== 'object') continue;
    // ONE message, MANY records. The usage block describes the message and is re-emitted on
    // each record that has one, so counting per record double- (or triple-) counts it.
    //
    // The id is claimed AFTER the usage check, never before: a message's leading records
    // (a thinking block) carry no usage at all, and marking the id seen on one of those let
    // it swallow the id so the record actually carrying the usage was skipped — every
    // session then reported ZERO input. Dedupe only among usage-bearing records.
    //
    // A record with no id cannot be deduped and is counted: a silent drop is the same class
    // of error in the other direction.
    // …and a repeat is not always a COPY. Agent transcripts stream PARTIAL usage: the same
    // id reappears with identical input/cache_read and a GROWING output_tokens. Measured on
    // this host: 9,859 duplicated ids in sessions with ZERO differing, versus 3,762 in agents
    // of which 3,112 differ — so skipping the repeat under-counted agent output by ~30x.
    // Keep the LARGEST value seen per id and add only the increment, which is a no-op for a
    // true copy and cannot walk a total backwards if a smaller copy arrives late.
    const mid = line.message?.id;
    let inTok = n(u.input_tokens);
    let outTok = n(u.output_tokens);
    let cwTok = n(u.cache_creation_input_tokens);
    let crTok = n(u.cache_read_input_tokens);
    if (typeof mid === 'string' && mid) {
      const prev = t.seenMsgIds.get(mid);
      if (prev) {
        const dIn = Math.max(0, inTok - prev.i), dOut = Math.max(0, outTok - prev.o);
        const dCw = Math.max(0, cwTok - prev.w), dCr = Math.max(0, crTok - prev.r);
        if (dIn === 0 && dOut === 0 && dCw === 0 && dCr === 0) continue;   // a true copy
        prev.i = Math.max(prev.i, inTok); prev.o = Math.max(prev.o, outTok);
        prev.w = Math.max(prev.w, cwTok); prev.r = Math.max(prev.r, crTok);
        inTok = dIn; outTok = dOut; cwTok = dCw; crTok = dCr;   // count only the increment
      } else {
        t.seenMsgIds.set(mid, { i: inTok, o: outTok, w: cwTok, r: crTok });
        // BOUNDED, evicting oldest-first (a Map iterates in insertion order). This map is the
        // memory cost of keeping accumulators alive across polls — one entry per message, over
        // every transcript on disk. Releasing it entirely for idle files was the alternative,
        // and it was worse twice over: the next append re-read the WHOLE transcript on the 10s
        // poll (the rhythm of resuming a session after lunch), and the release could land
        // between a concurrent scan's read and its digest, so those bytes were counted into an
        // emptied map and doubled.
        //
        // ponytail: a plain cap, because the copies of one message are ADJACENT in the file —
        // dedupe only ever needs the recent past. An id evicted and then genuinely repeated
        // more than MSG_ID_MEMORY messages later would be counted twice; that would require a
        // streamed message spanning hundreds of others, which the format does not produce.
        if (t.seenMsgIds.size > MSG_ID_MEMORY) {
          const oldest = t.seenMsgIds.keys().next().value;
          if (oldest !== undefined) t.seenMsgIds.delete(oldest);
        }
      }
    }
    t.input += inTok;
    t.output += outTok;
    t.cacheCreation += cwTok;
    t.cacheRead += crTok;
    // Bucket by the record's OWN timestamp. A record with no parseable stamp is counted
    // in the lifetime totals but not bucketed — it cannot be placed in time, and guessing
    // (e.g. "now") would smear old history into the current window.
    const ts = line.timestamp ? Date.parse(line.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      const key = Math.floor(ts / BUCKET_MS);
      let b = t.buckets.get(key);
      if (!b) { b = { fresh: 0, output: 0, cacheRead: 0 }; t.buckets.set(key, b); }
      b.fresh += inTok + cwTok;
      b.output += outTok;
      b.cacheRead += crTok;
    }
  }
  return Buffer.byteLength(complete, 'utf8');
}

/** Root of Claude Code's per-project transcript directories. Overridable for tests. */
export function transcriptsRoot(): string {
  return process.env.CAPTAIN_MEMO_TRANSCRIPTS_DIR ?? join(homedir(), '.claude', 'projects');
}

/** A session id looks like a UUID. Enforced because the recall audit also carries
 *  hand-written ids from local testing ('test', 'demo-1'); reporting those to a
 *  cockpit as live sessions would invent sessions that never existed. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An agent transcript, as Claude Code names them. Deliberately NOT `*.jsonl`: a workflow
 *  directory also contains journal.jsonl, which is the workflow's own bookkeeping. */
const AGENT_FILE_RE = /^agent-[0-9a-f]+\.jsonl$/i;

/**
 * Read provider-reported usage for every native session active within `windowMs`.
 *
 * Activity is judged by transcript mtime — a session that has not written a message
 * is not live, whatever else is running. Read-only and best-effort throughout: an
 * unreadable directory or transcript is skipped, never thrown, because this feeds a
 * telemetry poll where a partial answer beats a failed one.
 */
/** Read the appended bytes of one transcript into its accumulator and sum the buckets that
 *  fall inside the window. Shared by the top-level session scan and the agent scan below —
 *  one implementation, so the two can never drift on how a token is counted. */
async function accumulate(
  path: string, size: number, now: number, windowMs: number, mtimeMs = 0,
): Promise<{ t: Totals; wFresh: number; wOut: number; wCr: number }> {
  // Start this file over when it is unseen, when it was truncated/rotated (size < offset), or
  // when a transcript we had SEALED grew again: sealing released its id map, so the appended
  // records can no longer be deduped against what was already counted, and re-reading one file
  // beats risking a streamed message counted twice.
  let t = ACC.get(path);
  if (!t || size < t.offset) {   // unseen, or truncated/rotated ⇒ start over
    t = fresh();
    ACC.set(path, t);
  }
  t.lastTouchedMs = now;
  // Capture the read position BEFORE any await, and make the write idempotent.
  //
  // t.offset used to be read after `await open` and advanced with `+=` after `await read`,
  // on an accumulator shared by every scan of this path. The worker fires allTimeTotals()
  // unawaited — a 365-day scan — while the ~10s fleet poll keeps running, so two scans over
  // one transcript is routine rather than theoretical. Both computed the same range and each
  // ADDED it, leaving the offset ahead of the bytes actually digested; everything later
  // written into that phantom gap was then skipped PERMANENTLY, because the `size < offset`
  // self-heal never fires once the file grows past it. Silently MISSING tokens — not
  // double-counted ones, since the per-message dedupe already makes a re-read idempotent.
  //
  // Both racers now start from the same `from` and digest the same contiguous bytes, so
  // taking the MAX keeps the longer read's real progress and discards the duplicate advance.
  // No lock needed, and an accumulator replaced by a concurrent fresh() is simply orphaned.
  const from = t.offset;
  if (size > from) {
    const fh = await open(path, 'r').catch(() => null);
    if (fh) {
      try {
        const len = size - from;
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, from);
        t.offset = Math.max(t.offset, from + digest(buf.toString('utf8', 0, bytesRead), t));
      } catch {
        /* transient read failure — keep what we have, retry next poll */
      } finally {
        await fh.close();
      }
    }
  }
// Sum the buckets inside the window and drop anything past the retention bound.
  const cutoff = Math.floor((now - windowMs) / BUCKET_MS);
  const pruneBefore = Math.floor((now - MAX_BUCKET_MS) / BUCKET_MS);
  let wFresh = 0, wOut = 0, wCr = 0;
  for (const [key, b] of t.buckets) {
    if (key < pruneBefore) { t.buckets.delete(key); continue; }
    if (key >= cutoff) { wFresh += b.fresh; wOut += b.output; wCr += b.cacheRead; }
  }
  return { t, wFresh, wOut, wCr };
}

/** wfDir → { key, done }. The journal only grows, so a re-read is only needed when its size
 *  or mtime changes — measured at 219 ms per scan across 183 journals (16 MB) when re-read
 *  unconditionally. Keyed on both so a rewrite in place is still caught. */
const WF_DONE = new Map<string, { key: string; done: Set<string> }>();

/** The agent ids a workflow's journal reports as FINISHED.
 *
 *  Liveness elsewhere is transcript-mtime inside the activity window, which is right for a
 *  session — a person idles between prompts — and wrong for an agent, which is a one-shot
 *  task that either writes or is done. A completed 12-agent workflow therefore sat on the
 *  board reading ACTIVE for the rest of the window, with its tokens counting toward "what is
 *  running now". The journal answers it exactly: one `result` line per finished agent.
 *
 *  Cached on the journal's size:mtime, NEVER on first sight: the file grows while the workflow
 *  runs, so freezing the answer would strand finished agents on the board reading ACTIVE. Each
 *  new `result` line moves both size and mtime, so a cache hit can only ever be a journal that
 *  has not changed. An unreadable journal yields an EMPTY set, so every agent stays reported:
 *  absence of evidence is not evidence of completion, and hiding live work is the worse
 *  error. */
async function finishedAgents(wfDir: string): Promise<Set<string>> {
  const jpath = join(wfDir, 'journal.jsonl');
  const st = await stat(jpath).catch(() => null);
  if (!st) return new Set<string>();   // no journal ⇒ report every agent, as before
  const key = st.size + ':' + Math.round(st.mtimeMs);
  const hit = WF_DONE.get(wfDir);
  if (hit && hit.key === key) return hit.done;

  const done = new Set<string>();
  let raw: string;
  try {
    raw = await readFile(jpath, 'utf8');
  } catch {
    return done;
  }
  for (const line of raw.split('\n')) {
    if (!line || line.indexOf('"result"') < 0) continue;
    try {
      const rec = JSON.parse(line) as { type?: unknown; agentId?: unknown };
      if (rec.type === 'result' && typeof rec.agentId === 'string' && rec.agentId) done.add(rec.agentId);
    } catch {
      /* a partial line mid-write — the next poll sees it whole */
    }
  }
  WF_DONE.set(wfDir, { key, done });
  return done;
}

/** sessionId → the wf-id map, cached. The cross-project sweep below costs 65 readdir
 *  attempts per session that owns a workflow — measured at 490 ms across 4,550 attempts on
 *  this host, of which ~4,480 fail. A session's scripts do not move, so this is worth doing
 *  once rather than every scan. */
const WF_NAMES = new Map<string, Map<string, { name: string; path: string }>>();

/** wf id → the workflow's own name, read from the script the Workflow tool persists at
 *  `<session>/workflows/scripts/<meta.name>-<wf id>.js`. That filename is the ONLY place a
 *  workflow run is named: its journal keys on a content hash, and each agent's meta.json
 *  says just `"agentType": "workflow-subagent"`. Matched on the exact wf id so two runs
 *  under one session can never inherit each other's name. */
async function workflowNames(subagentsDir: string, sessionId: string): Promise<Map<string, { name: string; path: string }>> {
  const cached = WF_NAMES.get(sessionId);
  if (cached) return cached;
  const out = new Map<string, { name: string; path: string }>();
  const collect = async (dir: string): Promise<void> => {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return;   // no scripts here — the agents stay unnamed, which is honest
    }
    for (const f of files) {
      const m = /^(.+)-(wf_[A-Za-z0-9-]+)\.js$/.exec(f);
      if (m && !out.has(m[2]!)) out.set(m[2]!, { name: m[1]!, path: join(dir, f) });
    }
  };
  // Beside the agents first — the common case, and one readdir.
  await collect(join(dirname(subagentsDir), 'workflows', 'scripts'));

  // Then the SAME SESSION under every other project directory. A session whose cwd differs
  // when it launches a workflow persists the script under THAT project's dir while its agents
  // stay filed under the project the session belongs to: one session id, two directories.
  // Observed live — both of this session's own workflows landed that way and showed as bare
  // wf_ ids. Only reached when the local directory did not already answer.
  try {
    const root = transcriptsRoot();
    const projects = await readdir(root, { withFileTypes: true });
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const alt = join(root, p.name, sessionId, 'workflows', 'scripts');
      if (alt === join(dirname(subagentsDir), 'workflows', 'scripts')) continue;
      await collect(alt);
    }
  } catch {
    /* unreadable projects root — keep whatever the local directory gave us */
  }
  WF_NAMES.set(sessionId, out);
  return out;
}

/** What the run is FOR, from `meta.description` in its script. Three members repeating the
 *  same name spend a row each saying one thing; the description is what a board actually
 *  lacks. Cached by path — a persisted script never changes, so this reads each one once.
 *
 *  Scoped to the `meta` literal deliberately: workflow scripts routinely define JSON schemas
 *  whose properties carry their own `description:` keys, and an unscoped match would happily
 *  return one of those as the workflow's purpose. The Workflow tool REQUIRES meta to be a
 *  pure literal, so reading it needs no evaluation. */
const WF_DESC = new Map<string, string | undefined>();
async function workflowDescription(path: string): Promise<string | undefined> {
  const hit = WF_DESC.get(path);
  if (hit !== undefined || WF_DESC.has(path)) return hit;
  let desc: string | undefined;
  try {
    const src = await readFile(path, 'utf8');
    const start = src.indexOf('export const meta');
    if (start >= 0) {
      const close = src.indexOf('\n}', start);
      const block = src.slice(start, close < 0 ? start + 4000 : close);
      const m = /\bdescription:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(block);
      if (m) desc = m[2]!.replace(/\\(['"`\\])/g, '$1').trim() || undefined;
    }
  } catch {
    /* unreadable script — a name without a description, never a fabricated one */
  }
  WF_DESC.set(path, desc);
  return desc;
}

/** The team's lead session id, read from the config Claude Code writes per team. Cached by
 *  team name: a team's lead is fixed for its lifetime. Returns undefined when there is no
 *  config — an unresolved parent is honest, a guessed one is not. */
const TEAM_LEAD = new Map<string, string | undefined>();
function teamLeadSession(teamName: string): string | undefined {
  if (TEAM_LEAD.has(teamName)) return TEAM_LEAD.get(teamName);
  let lead: string | undefined;
  try {
    const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const cfg = JSON.parse(readFileSync(join(base, 'teams', teamName, 'config.json'), 'utf8')) as { leadSessionId?: unknown };
    if (typeof cfg.leadSessionId === 'string' && cfg.leadSessionId) lead = cfg.leadSessionId;
  } catch {
    /* no config for this team — report no lead rather than inventing one */
  }
  TEAM_LEAD.set(teamName, lead);
  return lead;
}

/** Depth-bounded scan of one session's agent transcripts. Recurses exactly one level into
 *  `workflows/<wf_id>/`, which is the only nesting Claude Code produces — a wider walk
 *  would be speculative and would cost a stat per stray file. Best-effort throughout: a
 *  session with no agents has no such directory and this returns immediately. */
async function scanAgents(
  dirPath: string, parentSessionId: string, workflowId: string | undefined,
  now: number, windowMs: number, out: NativeSessionUsage[],
  // NOT `workflowDescription` — that is the module-level function this body calls a few lines
  // down, and a parameter of the same name shadows it into `undefined is not a function`.
  names?: ReadonlyMap<string, string>, workflowName?: string, wfDesc?: string,
  includeFinished = false,
): Promise<void> {
  // Inside a workflow directory, the journal says which agents have already FINISHED. They
  // are dropped below rather than reported as running until the window happens to expire.
  const done = (workflowId !== undefined && !includeFinished) ? await finishedAgents(dirPath) : new Set<string>();
  let entries: Dirent[];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;   // no agents for this session — by far the common case
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      // workflows/<wf_id>/agent-*.jsonl — one more level, and only for the workflows dir.
      if (workflowId !== undefined) continue;
      if (e.name === 'workflows') {
        let wfs: Dirent[];
        try { wfs = await readdir(join(dirPath, e.name), { withFileTypes: true }); } catch { continue; }
        // One readdir for the whole session, and only for a session that ran a workflow.
        const wfNames = await workflowNames(dirPath, parentSessionId);
        for (const wf of wfs) {
          if (!wf.isDirectory()) continue;
          // Read the description only for a workflow actually being scanned, not for every
          // script the session ever persisted (ten of them in one session here).
          // A MISS invalidates and re-reads. The cache holds "the wf ids this session had when
          // first scanned", and a session runs many workflows over its life — caching that set
          // permanently blanked the name of every later workflow, which is the exact failure the
          // naming feature exists to prevent. A miss is rare (a new workflow); a hit is every
          // poll, so the 490 ms saving is untouched.
          let script = wfNames.get(wf.name);
          if (!script) {
            WF_NAMES.delete(parentSessionId);
            script = (await workflowNames(dirPath, parentSessionId)).get(wf.name);
          }
          const desc = script ? await workflowDescription(script.path) : undefined;
          await scanAgents(join(dirPath, e.name, wf.name), parentSessionId, wf.name, now, windowMs, out, names, script?.name, desc, includeFinished);
        }
      }
      continue;
    }
    // agent-<hex>.jsonl ONLY. A workflow directory also holds journal.jsonl — its own
    // bookkeeping, not a session — and reporting that as an agent invents a row with no
    // tokens and no meaning.
    if (!AGENT_FILE_RE.test(e.name)) continue;
    // Its own journal reported a result for this one: it is finished, not idle.
    if (done.has(e.name.slice('agent-'.length, -'.jsonl'.length))) continue;
    const path = join(dirPath, e.name);
    let size = 0, mtimeMs = 0;
    try {
      const st = await stat(path);
      size = st.size; mtimeMs = st.mtimeMs;
    } catch { continue; }
    if (now - mtimeMs > windowMs) continue;   // idle ⇒ not live, same rule as a session
    const { t, wFresh, wOut, wCr } = await accumulate(path, size, now, windowMs, mtimeMs);
    // agent-<hex>.jsonl — the id the parent's dispatch record keys on is the bare hex.
    const dispatchedAs = names?.get(e.name.slice('agent-'.length, -'.jsonl'.length));
    out.push({
      session_id: e.name.slice(0, -'.jsonl'.length),
      window_fresh_tokens: wFresh,
      window_output_tokens: wOut,
      window_cache_read_tokens: wCr,
      input_tokens: t.input,
      output_tokens: t.output,
      cache_creation_tokens: t.cacheCreation,
      cache_read_tokens: t.cacheRead,
      last_activity_epoch_ms: Math.round(mtimeMs),
      parentSessionId,
      ...(workflowId ? { workflowId } : {}),
      ...(workflowName ? { workflowName } : {}),
      ...(wfDesc ? { workflowDescription: wfDesc } : {}),
      ...(t.cwd ? { cwd: t.cwd } : {}),
      // Its own name first (a workflow agent resumed with `--resume <name>` declares one),
      // then the label the parent gave it. Bare hex only when neither exists.
      ...((t.agentName ?? dispatchedAs) ? { agentName: t.agentName ?? dispatchedAs } : {}),
      ...(t.entrypoint ? { entrypoint: t.entrypoint } : {}),
    });
  }
}

export async function readNativeSessionUsage(
  windowMs = 30 * 60_000,
  now = Date.now(),
  alwaysLive?: ReadonlySet<string>,
  /** LIFETIME scans must count agents that have already finished; a LIVE board must not show
   *  them as running. One rule for both silently dropped 2,634 finished agent transcripts —
   *  188.9M billed tokens, 27% of the all-time total — the moment the liveness fix landed. */
  opts?: { includeFinished?: boolean },
): Promise<NativeSessionUsage[]> {
  const root = transcriptsRoot();
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(root, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => join(root, d.name));
  } catch {
    return [];   // no transcripts dir ⇒ no native sessions to report
  }

  const out: NativeSessionUsage[] = [];

  for (const dir of projectDirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -'.jsonl'.length);
      if (!SESSION_ID_RE.test(sessionId)) continue;
      const path = join(dir, name);

      let size = 0;
      let mtimeMs = 0;
      try {
        const st = await stat(path);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      // Transcript mtime asks "did this write recently", which is a PROXY for "does this
      // session exist". When the captain has actually resolved the pane's process — the
      // session file is on disk and the pid is alive — that is direct evidence and it wins.
      // Without this a session idle for 31 minutes vanished from the fleet board while its
      // terminal sat open in front of you, taking its name and its tokens with it and
      // leaving a bare ambient row in their place.
      if (now - mtimeMs > windowMs && !(alwaysLive && alwaysLive.has(sessionId))) continue;

      const { t, wFresh, wOut, wCr } = await accumulate(path, size, now, windowMs, mtimeMs);

      out.push({
        session_id: sessionId,
        window_fresh_tokens: wFresh,
        window_output_tokens: wOut,
        window_cache_read_tokens: wCr,
        input_tokens: t.input,
        output_tokens: t.output,
        cache_creation_tokens: t.cacheCreation,
        cache_read_tokens: t.cacheRead,
        last_activity_epoch_ms: Math.round(mtimeMs),
        ...(t.cwd ? { cwd: t.cwd } : {}),
        ...(t.agentName ? { agentName: t.agentName } : {}),
        ...(t.ownerSession ? { ownerSession: t.ownerSession } : {}),
        ...(t.entrypoint ? { entrypoint: t.entrypoint } : {}),
        ...(t.agentSetting ? { agentSetting: t.agentSetting } : {}),
        ...(t.teamName ? { teamName: t.teamName } : {}),
        ...(t.teamName && teamLeadSession(t.teamName) ? { teamLeadSession: teamLeadSession(t.teamName) } : {}),
      });

      // AGENT TRANSCRIPTS for this session. They live under <dir>/<sessionId>/subagents/,
      // optionally nested one more level under workflows/<wf_id>/, and are named
      // agent-<hex>.jsonl rather than <uuid>.jsonl — which is why the UUID gate above skips
      // them and why 33% of billed tokens were invisible. The parent is not inferred: it is
      // the directory this scan is already standing in.
      await scanAgents(join(dir, sessionId, 'subagents'), sessionId, undefined, now, windowMs, out, t.dispatched, undefined, undefined, !!opts?.includeFinished);
    }
  }

  // Drop accumulators nobody has touched in a while, so a long-running worker's memory tracks
  // the sessions still in play rather than every session ever seen.
  //
  // Prune by STALENESS, NEVER by the set of transcripts the call that just ran saw live: that
  // set is only ever as wide as THIS window — 4 transcripts for the 10s poll, 5,254 for the
  // 365-day scan — so keying on it let the narrow scan evict everything the wide one had
  // accumulated, and the wide scan then re-read 2.4 GB from scratch every five minutes: 32.9s
  // cold against 1.6s warm. ACC_IDLE_MS exceeds the widest scan's TTL, so a scan can never
  // evict its own work.
  for (const [path, t] of ACC) if (now - t.lastTouchedMs > ACC_IDLE_MS) ACC.delete(path);

  out.sort((a, b) => b.last_activity_epoch_ms - a.last_activity_epoch_ms);
  return out;
}

/** Test-only: clear the per-process accumulators. */
export function _resetNativeUsageCache(): void {
  ACC.clear();
  // The lookup caches too. Both are module-level and keyed by a name, NOT by the config dir
  // they were resolved under — so a test that ran earlier under a different
  // CLAUDE_CONFIG_DIR left a cached MISS that a later test inherited, and the team-lead test
  // passed alone while failing in the suite. Anything cached across a reset has to be reset.
  TEAM_LEAD.clear();
  WF_DESC.clear();
  WF_NAMES.clear();
  WF_DONE.clear();
}

/** Fleet-reportable aggregate across every live native session. Sums the same
 *  provider-reported numbers the per-session view shows.
 *
 *  Exists because the hub's token columns are fed by usage_by_model, which only the
 *  BROKER populates — and the broker only sees brokered co-sessions. A captain whose
 *  work is native sessions therefore reported nothing, and every token field in the
 *  cockpit read 0 forever. These are the same tokens, counted from the transcripts
 *  the sessions write themselves. */
export interface NativeUsageTotals {
  sessions: number;
  /** WINDOW figures — tokens whose messages were written inside windowMs. This is what a
   *  "last 30 minutes" number must be. The lifetime fields below are the honest all-time
   *  totals for those same sessions; the two are reported separately because mixing them
   *  is what produced "3.2 B in 30 minutes", which is not a rate anyone can act on. */
  window_ms: number;
  window_fresh_tokens: number;
  window_output_tokens: number;
  window_cache_read_tokens: number;
  /** Per-model split of the WINDOW, so the hub can price it. Without this a cost figure
   *  is impossible: input, cache-write, cache-read and output are billed at four
   *  different rates that differ per model — cache-read is roughly a TENTH of input, so
   *  summing the four into one "tokens" number produces something that correlates with
   *  nothing anyone pays. Transcripts name the model on every usage record, so the split
   *  costs nothing to carry. */
  window_by_model?: Record<string, {
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
  }>;
  /** LIFETIME totals for the sessions currently live — all-time per session, from the
   *  transcript's first record. Kept because "how much has this session cost in total"
   *  is a real question; it is simply not a 30-minute one. */
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

/** Per-session rows for the cockpit's task table. BOUNDED: the fleet-status poll runs
 *  every ~10 s, and a busy box can have 20+ live transcripts — sending them all would put
 *  a growing payload on a hot path for rows nobody scrolls to. Newest-active first, so the
 *  cap drops the least interesting. */
export interface NativeSessionRow {
  session_id: string;
  fresh_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  last_activity_epoch_ms: number;
  cwd?: string;
  /** Human name when the session has one (workflow sub-task agents do). */
  agent_name?: string;
  /** The owning session's edge id. */
  owner_session?: string;
  /** The session that spawned this agent — from the transcript's own directory, so exact.
   *  Absent on a top-level session, which is what makes the two distinguishable. */
  parent_session_id?: string;
  /** The workflow whose fan-out this agent belongs to, when the path says so. */
  workflow_id?: string;
  /** That workflow's NAME, so the board can say "geomap-netline-parity" instead of listing
   *  its fan-out as anonymous hex ids. */
  workflow_name?: string;
  /** And what it is FOR, shown once on the workflow row instead of repeating the name on
   *  every member. */
  workflow_description?: string;
  /** How it was started — the cockpit uses this to separate a session someone OPENED from
   *  a programmatic invocation nobody did. */
  entrypoint?: string;
  /** Set when the session declares itself an agent (a teammate does, at top level). */
  agent_setting?: string;
  /** The team a teammate belongs to — groups its members together. */
  team_name?: string;
  /** The team lead's FULL session id, so the board nests a teammate on an exact match
   *  instead of guessing from the 8 hex characters in team_name. */
  team_lead_session?: string;
}

// Raised from 10: a single workflow can fan out a dozen agents, and truncating them would
// show a parent with an arbitrary subset of its children — worse than showing none.
const MAX_REPORTED_SESSIONS = 40;

/** Session ids whose PROCESS is currently alive, from Claude Code's own runtime state.
 *
 *  ~/.claude/sessions/<pid>.json is written by each live session about itself. A file whose
 *  pid is gone is a leftover, so the pid is checked — signal 0 tests existence without
 *  touching the process.
 *
 *  This is DIRECT evidence that a session exists, and it beats the proxy the window uses
 *  (did the transcript change recently). A session idle for 31 minutes used to vanish from
 *  the fleet board while its terminal sat open in front of you, taking its name and its
 *  tokens with it. Cheap: one readdir plus a kill(0) per entry, no tmux and no ps, and it
 *  covers sessions that are not in a terminal multiplexer at all.
 */
export function liveSessionIds(): Set<string> {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const out = new Set<string>();
  let names: string[];
  try { names = readdirSync(join(base, 'sessions')); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const pid = Number(n.slice(0, -'.json'.length));
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try { process.kill(pid, 0); } catch { continue; }   // stale file, process gone
    try {
      const d = JSON.parse(readFileSync(join(base, 'sessions', n), 'utf8')) as { sessionId?: unknown };
      if (typeof d.sessionId === 'string' && d.sessionId) out.add(d.sessionId);
    } catch { /* unreadable or malformed — skip, never throw */ }
  }
  return out;
}

export async function nativeSessionRows(
  windowMs = 30 * 60_000, alwaysLive?: ReadonlySet<string>,
): Promise<NativeSessionRow[]> {
  // Default to the live set: a session with a running process belongs on the board whether
  // or not it wrote a message in the last half hour.
  const alive = alwaysLive ?? liveSessionIds();
  const live = await readNativeSessionUsage(windowMs, Date.now(), alive).catch(() => []);
  return live.slice(0, MAX_REPORTED_SESSIONS).map(s => ({
    session_id: s.session_id,
    // WINDOW figures, matching the headline. A row showing lifetime beside a windowed
    // total is how "3.2 B in 30 minutes" happened in the first place.
    fresh_tokens: s.window_fresh_tokens,
    output_tokens: s.window_output_tokens,
    cache_read_tokens: s.window_cache_read_tokens,
    last_activity_epoch_ms: s.last_activity_epoch_ms,
    ...(s.cwd ? { cwd: s.cwd } : {}),
    ...(s.agentName ? { agent_name: s.agentName } : {}),
    ...(s.ownerSession ? { owner_session: s.ownerSession } : {}),
    ...(s.parentSessionId ? { parent_session_id: s.parentSessionId } : {}),
    ...(s.workflowId ? { workflow_id: s.workflowId } : {}),
    ...(s.workflowName ? { workflow_name: s.workflowName } : {}),
    ...(s.workflowDescription ? { workflow_description: s.workflowDescription } : {}),
    ...(s.teamLeadSession ? { team_lead_session: s.teamLeadSession } : {}),
    ...(s.entrypoint ? { entrypoint: s.entrypoint } : {}),
    ...(s.agentSetting ? { agent_setting: s.agentSetting } : {}),
    ...(s.teamName ? { team_name: s.teamName } : {}),
  }));
}

/** ALL-TIME totals across every transcript on this host, not just live ones.
 *
 *  This is the "how much have we spent, ever" number — the one a window can never give
 *  you. It costs a full scan (measured: 1 479 transcripts, ~19 s cold) which is far too
 *  slow for a 10 s poll, but the incremental accumulator makes repeats ~253 ms, 74x
 *  faster. So it is computed lazily in the BACKGROUND and served from cache: a poll
 *  never waits on it, and a captain that has not finished its first scan simply omits
 *  the field rather than reporting a half-scanned total as if it were complete. */
export interface AllTimeTotals {
  /** SESSIONS only — top-level transcripts. This used to be every row, so a fleet of agents
   *  was reported as sessions: 1,549 sessions and 3,635 agents read as "5,183 sessions". */
  sessions: number;
  /** Agent transcripts, counted apart rather than folded into the above. */
  agents: number;
  /** Start of the OLDEST transcript still on disk. "All time" can only honestly mean "as far
   *  back as the transcripts reach" — here about five weeks, because Claude Code's own
   *  history goes no further. A lifetime total that cannot say how far it sees claims more
   *  than it knows. */
  oldest_epoch_ms: number;
  fresh_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  computed_at_epoch_ms: number;
}

const ALL_TIME_TTL_MS = 5 * 60_000;
const ALL_TIME_WINDOW_MS = 365 * 24 * 60 * 60_000;   // everything on disk
let allTimeCache: AllTimeTotals | null = null;
let allTimeInFlight = false;

/** Cached all-time totals. Returns null until the first scan completes — never a partial
 *  figure, because a total that is quietly missing half the corpus is worse than no total. */
export function allTimeTotals(now = Date.now()): AllTimeTotals | null {
  if (!allTimeInFlight && (!allTimeCache || now - allTimeCache.computed_at_epoch_ms > ALL_TIME_TTL_MS)) {
    allTimeInFlight = true;
    // Fire and forget: the caller returns the previous value (or null) immediately.
    void readNativeSessionUsage(ALL_TIME_WINDOW_MS, now, undefined, { includeFinished: true })
      .then(all => {
        let fresh = 0, out = 0, cr = 0;
        for (const s of all) {
          fresh += s.input_tokens + s.cache_creation_tokens;
          out += s.output_tokens;
          cr += s.cache_read_tokens;
        }
        allTimeCache = {
          // Count sessions and agents APART. This was `all.length`, so 1,549 sessions and
            // 3,635 agents were reported as "5,183 sessions" — 70% of that label was wrong.
            sessions: all.filter(s2 => !s2.parentSessionId).length,
            agents: all.filter(s2 => !!s2.parentSessionId).length,
            oldest_epoch_ms: all.reduce((m, s2) => (s2.last_activity_epoch_ms > 0 && (m === 0 || s2.last_activity_epoch_ms < m) ? s2.last_activity_epoch_ms : m), 0),
            fresh_tokens: fresh, output_tokens: out,
          cache_read_tokens: cr, computed_at_epoch_ms: Date.now(),
        };
      })
      .catch(() => { /* keep the prior value; a failed scan must not blank the total */ })
      .finally(() => { allTimeInFlight = false; });
  }
  return allTimeCache;
}

/** Test-only: drop the all-time cache. */
export function _resetAllTimeCache(): void {
  allTimeCache = null;
  allTimeInFlight = false;
}

export async function nativeUsageTotals(windowMs = 30 * 60_000): Promise<NativeUsageTotals> {
  const live = await readNativeSessionUsage(windowMs).catch(() => []);
  const t: NativeUsageTotals = {
    sessions: live.length, window_ms: windowMs,
    window_fresh_tokens: 0, window_output_tokens: 0, window_cache_read_tokens: 0,
    input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
  };
  for (const s of live) {
    t.window_fresh_tokens += s.window_fresh_tokens;
    t.window_output_tokens += s.window_output_tokens;
    t.window_cache_read_tokens += s.window_cache_read_tokens;
    t.input_tokens += s.input_tokens;
    t.output_tokens += s.output_tokens;
    t.cache_creation_tokens += s.cache_creation_tokens;
    t.cache_read_tokens += s.cache_read_tokens;
  }
  return t;
}

// ── memory's half of the picture ─────────────────────────────────────────────

interface InjectedTotals { tokens: number; injections: number }

const INJ_ACC = new Map<string, { offset: number; by: Map<string, InjectedTotals> }>();

/**
 * Per-session injected-token totals from the recall audit log.
 *
 * Keyed by session_id, which is the SAME id a transcript is named after — that is
 * what lets a caller put memory's cost beside the model spend for one session
 * without any correlation step.
 *
 * Incremental for the same reason as the transcript reader: the audit log is
 * append-only and multi-megabyte, and this is called on a poll.
 */
export async function injectedBySession(auditLogPath: string): Promise<Map<string, InjectedTotals>> {
  let size = 0;
  try {
    size = (await stat(auditLogPath)).size;
  } catch {
    INJ_ACC.delete(auditLogPath);
    return new Map();
  }
  let acc = INJ_ACC.get(auditLogPath);
  if (!acc || size < acc.offset) {          // unseen, or truncated ⇒ rebuild
    acc = { offset: 0, by: new Map() };
    INJ_ACC.set(auditLogPath, acc);
  }
  if (size > acc.offset) {
    const fh = await open(auditLogPath, 'r').catch(() => null);
    if (fh) {
      try {
        const len = size - acc.offset;
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, acc.offset);
        const chunk = buf.toString('utf8', 0, bytesRead);
        const lastNl = chunk.lastIndexOf('\n');
        if (lastNl >= 0) {
          for (const raw of chunk.slice(0, lastNl + 1).split('\n')) {
            if (!raw.trim()) continue;
            let d: { session_id?: string; injected_tokens?: number };
            try {
              d = JSON.parse(raw) as typeof d;
            } catch {
              continue;
            }
            // Presence, not truthiness: a 0-token injection is a real event and must
            // count toward the denominator. Search-path lines omit the field entirely.
            if (typeof d.injected_tokens !== 'number' || !Number.isFinite(d.injected_tokens)) continue;
            const id = d.session_id;
            if (!id) continue;
            const e = acc.by.get(id) ?? { tokens: 0, injections: 0 };
            e.tokens += d.injected_tokens;
            e.injections++;
            acc.by.set(id, e);
          }
          acc.offset += Buffer.byteLength(chunk.slice(0, lastNl + 1), 'utf8');
        }
      } catch {
        /* transient — keep what we have */
      } finally {
        await fh.close();
      }
    }
  }
  return acc.by;
}

/** Test-only: clear the injected-totals accumulator. */
export function _resetInjectedCache(): void {
  INJ_ACC.clear();
}
