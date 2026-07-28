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

import { stat, open, readdir } from 'fs/promises';
import type { Dirent } from 'fs';
import { join } from 'path';
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
  /** The session that OWNS this one. Present ONLY for agent transcripts, where it is not
   *  inferred at all: an agent's transcript lives at <project>/<PARENT-UUID>/subagents/...,
   *  so the parent id IS the directory name. Deterministic, unlike every heuristic tried
   *  against `agentName` / cwd / env, all of which were wrong. */
  parentSessionId?: string | undefined;
  /** The workflow that spawned it, when the path says so
   *  (<parent>/subagents/workflows/<wf_id>/agent-*.jsonl). Lets a UI group one workflow's
   *  fan-out together instead of scattering a dozen agents under their parent. */
  workflowId?: string | undefined;
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
  /** Per-MINUTE token buckets, keyed by floor(epochMs / 60000). Summing the buckets
   *  inside a window gives usage genuinely accrued in that window, and old buckets fall
   *  out on their own — so the figure decays instead of lurching. Bounded by pruning
   *  past MAX_BUCKET_MS, so a long-running worker holds at most a day per session. */
  buckets: Map<number, Bucket>;
}

/** How much bucket history to retain. Caps memory (1 440 buckets/session at worst) and
 *  bounds the widest window that can be asked for honestly. */
const MAX_BUCKET_MS = 24 * 60 * 60_000;
const BUCKET_MS = 60_000;

const ACC = new Map<string, Totals>();

function fresh(): Totals {
  return { offset: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, buckets: new Map() };
}

/** A transcript line's shape, narrowed to the one field we read. Everything else in
 *  the line — the prompt, the response, tool calls — is deliberately untouched: this
 *  module reads COUNTS, never content, matching the corpus-telemetry posture. */
interface TranscriptLine {
  message?: { usage?: Record<string, unknown>; model?: string };
  cwd?: string;
  agentName?: string;
  customTitle?: string;
  bridgeSessionId?: string;
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
    if (t.ownerSession === undefined && typeof line.bridgeSessionId === 'string' && line.bridgeSessionId) {
      t.ownerSession = line.bridgeSessionId;
    }
    const u = line.message?.usage;
    if (!u || typeof u !== 'object') continue;
    const inTok = n(u.input_tokens);
    const outTok = n(u.output_tokens);
    const cwTok = n(u.cache_creation_input_tokens);
    const crTok = n(u.cache_read_input_tokens);
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
  path: string, size: number, now: number, windowMs: number,
): Promise<{ t: Totals; wFresh: number; wOut: number; wCr: number }> {
  let t = ACC.get(path);
  if (!t || size < t.offset) {   // unseen, or truncated/rotated ⇒ start over
    t = fresh();
    ACC.set(path, t);
  }
  if (size > t.offset) {
    const fh = await open(path, 'r').catch(() => null);
    if (fh) {
      try {
        const len = size - t.offset;
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, t.offset);
        t.offset += digest(buf.toString('utf8', 0, bytesRead), t);
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

/** Depth-bounded scan of one session's agent transcripts. Recurses exactly one level into
 *  `workflows/<wf_id>/`, which is the only nesting Claude Code produces — a wider walk
 *  would be speculative and would cost a stat per stray file. Best-effort throughout: a
 *  session with no agents has no such directory and this returns immediately. */
async function scanAgents(
  dirPath: string, parentSessionId: string, workflowId: string | undefined,
  now: number, windowMs: number, out: NativeSessionUsage[], live: Set<string>,
): Promise<void> {
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
        for (const wf of wfs) {
          if (!wf.isDirectory()) continue;
          await scanAgents(join(dirPath, e.name, wf.name), parentSessionId, wf.name, now, windowMs, out, live);
        }
      }
      continue;
    }
    // agent-<hex>.jsonl ONLY. A workflow directory also holds journal.jsonl — its own
    // bookkeeping, not a session — and reporting that as an agent invents a row with no
    // tokens and no meaning.
    if (!AGENT_FILE_RE.test(e.name)) continue;
    const path = join(dirPath, e.name);
    let size = 0, mtimeMs = 0;
    try {
      const st = await stat(path);
      size = st.size; mtimeMs = st.mtimeMs;
    } catch { continue; }
    if (now - mtimeMs > windowMs) continue;   // idle ⇒ not live, same rule as a session
    live.add(path);
    const { t, wFresh, wOut, wCr } = await accumulate(path, size, now, windowMs);
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
      ...(t.cwd ? { cwd: t.cwd } : {}),
      ...(t.agentName ? { agentName: t.agentName } : {}),
    });
  }
}

export async function readNativeSessionUsage(
  windowMs = 30 * 60_000,
  now = Date.now(),
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
  const live = new Set<string>();

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
      if (now - mtimeMs > windowMs) continue;   // idle ⇒ not a live session
      live.add(path);

      const { t, wFresh, wOut, wCr } = await accumulate(path, size, now, windowMs);

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
      });

      // AGENT TRANSCRIPTS for this session. They live under <dir>/<sessionId>/subagents/,
      // optionally nested one more level under workflows/<wf_id>/, and are named
      // agent-<hex>.jsonl rather than <uuid>.jsonl — which is why the UUID gate above skips
      // them and why 33% of billed tokens were invisible. The parent is not inferred: it is
      // the directory this scan is already standing in.
      await scanAgents(join(dir, sessionId, 'subagents'), sessionId, undefined, now, windowMs, out, live);
    }
  }

  // Drop accumulators for transcripts that fell out of the window, so a long-running
  // worker's memory tracks LIVE sessions rather than every session ever seen.
  for (const path of ACC.keys()) if (!live.has(path)) ACC.delete(path);

  out.sort((a, b) => b.last_activity_epoch_ms - a.last_activity_epoch_ms);
  return out;
}

/** Test-only: clear the per-process accumulators. */
export function _resetNativeUsageCache(): void {
  ACC.clear();
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
}

// Raised from 10: a single workflow can fan out a dozen agents, and truncating them would
// show a parent with an arbitrary subset of its children — worse than showing none.
const MAX_REPORTED_SESSIONS = 40;

export async function nativeSessionRows(windowMs = 30 * 60_000): Promise<NativeSessionRow[]> {
  const live = await readNativeSessionUsage(windowMs).catch(() => []);
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
  sessions: number;
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
    void readNativeSessionUsage(ALL_TIME_WINDOW_MS, now)
      .then(all => {
        let fresh = 0, out = 0, cr = 0;
        for (const s of all) {
          fresh += s.input_tokens + s.cache_creation_tokens;
          out += s.output_tokens;
          cr += s.cache_read_tokens;
        }
        allTimeCache = {
          sessions: all.length, fresh_tokens: fresh, output_tokens: out,
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
