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

interface Totals {
  offset: number;   // bytes already parsed (always at a newline boundary)
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  cwd?: string;
}

const ACC = new Map<string, Totals>();

function fresh(): Totals {
  return { offset: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

/** A transcript line's shape, narrowed to the one field we read. Everything else in
 *  the line — the prompt, the response, tool calls — is deliberately untouched: this
 *  module reads COUNTS, never content, matching the corpus-telemetry posture. */
interface TranscriptLine {
  message?: { usage?: Record<string, unknown> };
  cwd?: string;
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
    const u = line.message?.usage;
    if (!u || typeof u !== 'object') continue;
    t.input += n(u.input_tokens);
    t.output += n(u.output_tokens);
    t.cacheCreation += n(u.cache_creation_input_tokens);
    t.cacheRead += n(u.cache_read_input_tokens);
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

/**
 * Read provider-reported usage for every native session active within `windowMs`.
 *
 * Activity is judged by transcript mtime — a session that has not written a message
 * is not live, whatever else is running. Read-only and best-effort throughout: an
 * unreadable directory or transcript is skipped, never thrown, because this feeds a
 * telemetry poll where a partial answer beats a failed one.
 */
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

      out.push({
        session_id: sessionId,
        input_tokens: t.input,
        output_tokens: t.output,
        cache_creation_tokens: t.cacheCreation,
        cache_read_tokens: t.cacheRead,
        last_activity_epoch_ms: Math.round(mtimeMs),
        ...(t.cwd ? { cwd: t.cwd } : {}),
      });
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
