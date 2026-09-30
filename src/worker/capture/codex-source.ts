// codex CaptureSource — reads the plain-JSONL rollout transcripts codex persists
// under ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
//
// Verified line shapes (codex-cli 0.144.6):
//   session_meta                → { payload.id, payload.cwd }
//   event_msg/user_message      → { payload.message } — legacy user turn boundary
//   response_item/message       → { payload.role, payload.content[].text } — current user/assistant messages
//   event_msg/agent_message     → assistant text in the legacy mirrored event stream
//   response_item/custom_tool_call | function_call → { payload.name, payload.input|arguments }
//   event_msg/mcp_tool_call_end  → { payload.invocation.{server,tool,arguments} }
//   event_msg/patch_apply_end    → { payload.stdout } lists "Updated the following files: M /path"
//   event_msg/task_complete      → { payload.last_agent_message }
// reasoning / token_count / world_state / turn_context … are noise → skipped.
//
// We aggregate PER TURN (one event per user_message window) so a session yields
// Claude-like observations, not one obs per tool call.

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { RawObservationEvent } from '../../shared/types.ts';
import type { CaptureSource, IncrementalExtract, SessionRef } from './types.ts';

const DEFAULT_QUIESCE_MS = 60_000;
const SUMMARY_MAX = 2000; // matches the enqueue schema cap on the summary fields
/** Bump on ANY change to the turn rules in parse(). A resume point written by another parser version is
 *  refused, so the file is parsed in full and the driver's eventCountAtMarker guard repairs the cursor. */
const PARSER_VERSION = 1;

export interface CodexSourceOptions {
  /** Corpus this worker owns — stamped as project_id on every captured event. */
  projectId: string;
  dir?: string;
  quiesceMs?: number;
  now?: () => number;
  env?: Record<string, string | undefined>;
  /** Loud-failure sink. Defaults to console.error. Injected so tests can assert
   *  that an unparseable rollout is REPORTED rather than silently skipped. */
  warn?: (message: string) => void;
}

function clip(s: string, max = SUMMARY_MAX): string {
  const t = (s ?? '').trim();
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

/** Join codex `content: [{type,text}]` arrays (and tolerate a plain string). */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
  return '';
}

/** Pull modified paths out of an apply_patch stdout ("… M /abs/path"). */
function parseUpdatedFiles(stdout: string): string[] {
  const out: string[] = [];
  for (const line of (stdout ?? '').split(/\r?\n/)) {
    const m = /^\s*[MAD]\s+(\/\S.*)$/.exec(line);
    if (m && m[1]) out.push(m[1].trim());
  }
  return out;
}

/** Count turns with the same boundary rules as extract(). Used only against an
 *  earlier byte marker of the SAME append-only rollout, so a parser upgrade can
 *  repair its persisted cursor without replaying the already-seen prefix. */
function countTurns(text: string): number {
  let turns = 0;
  let started = false;
  let hasParts = false;
  const userBoundary = (message: string) => {
    if (!message.trim()) return;
    if (started && !hasParts) return; // generated context followed by the real prompt, or a mirrored legacy prompt
    turns++;
    started = true;
    hasParts = false;
  };
  const part = (message = 'present') => {
    if (!message.trim()) return;
    if (!started) { turns++; started = true; }
    hasParts = true;
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o: { type?: string; payload?: Record<string, unknown> };
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload ?? {};
    const pt = (p.type as string | undefined) ?? undefined;
    if (pt === 'user_message') userBoundary(String(p.message ?? ''));
    else if (pt === 'message' && p.role === 'user') userBoundary(textOf(p.content));
    else if (pt === 'message' && p.role === 'assistant') part(textOf(p.content));
    else if (pt === 'agent_message') part(typeof p.message === 'string' ? p.message : textOf(p.content));
    else if (pt === 'task_complete') part(String(p.last_agent_message ?? ''));
    else if (pt === 'custom_tool_call' || pt === 'function_call' || pt === 'mcp_tool_call_end' || pt === 'patch_apply_end') part();
  }
  return turns;
}

interface Turn {
  promptNumber: number;
  /** Absolute byte offset of the line that started this turn, and lastTs just before that line. */
  startOffset: number;
  tsBefore: number;
  userText: string;
  parts: string[];
  files: Set<string>;
  tsEpoch: number;
  lastAssistantText?: string;
}

/** `v<parser>:<size>:<offset>:<eventsBefore>:<promptBefore>:<tsBefore>`; null when absent/foreign/malformed. */
function parseResume(resume: string | null): { size: number; offset: number; events: number; prompt: number; ts: number } | null {
  const f = resume?.split(':');
  if (!f || f.length !== 6 || f[0] !== `v${PARSER_VERSION}`) return null;
  const [size, offset, events, prompt, ts] = f.slice(1).map(Number) as [number, number, number, number, number];
  if (![size, offset, events, prompt, ts].every(Number.isSafeInteger) || offset > size) return null;
  return { size, offset, events, prompt, ts };
}

export function createCodexSource(opts: CodexSourceOptions): CaptureSource {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? env.CAPTAIN_MEMO_CAPTURE_CODEX_DIR ?? join(homedir(), '.codex', 'sessions');
  const quiesceMs = opts.quiesceMs ?? Number(env.CAPTAIN_MEMO_CAPTURE_QUIESCE_MS ?? DEFAULT_QUIESCE_MS);
  const now = opts.now ?? (() => Date.now());
  const warn = opts.warn ?? ((m: string) => console.error(m));

  function walk(d: string, acc: string[]): void {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, acc);
      else if (st.isFile() && name.startsWith('rollout-') && (name.endsWith('.jsonl') || name.endsWith('.jsonl.zst'))) acc.push(p);
    }
  }

  // INCREMENTAL. A live rollout grows once a minute, and re-reading + JSON.parsing all of it each time
  // measured 3.5-5.5 s of blocked writer thread per growth on a 64 MB rollout (plus the same again for
  // eventCountAtMarker). `resume` holds the byte offset of the line that started the LAST turn seen, with
  // the parser state just before that line. Turn k's content depends only on lines from its own start
  // onward, and a new turn always starts with cur=null behaving exactly like cur=<a turn with parts>, so
  // re-parsing from that line reproduces the full extract's events from that turn on, including the
  // still-open turn that spans the old/new boundary. `from` says which full-extract index events[0] is.
  // A shorter file (rewrite/rotation), a byte before the offset that is not a line end, another parser
  // version, or a .zst (not seekable) all fall back to a full parse with from=null.
  // Measured on a copy of a real 64 MB rollout: growth step 5,469 / 3,534 ms max loop gap -> 268 / 290 ms.
  // ponytail: the still-open turn is re-parsed on each growth (that rollout's last turn is 14 MB = the 270 ms);
  // persisting the open turn's parts/files too would make it O(appended bytes) if one huge turn ever matters.
  function parse(ref: SessionRef, resume: string | null): IncrementalExtract {
    let buf: Buffer;
    let pos = 0;           // index into buf of the next line
    let bufStart = 0;      // absolute file offset of buf[0]
    let consumed = -1;     // bytes of the plain file read; -1 for .zst (no resume point)
    let from: number | null = null;
    let promptNumber = 0;
    let lastTs = Math.floor(now() / 1000);
    try {
      if (ref.path.endsWith('.zst')) {
        buf = Buffer.from(Bun.zstdDecompressSync(readFileSync(ref.path)));
      } else {
        const fd = openSync(ref.path, 'r');
        try {
          const size = fstatSync(fd).size;
          const readFrom = (at: number) => { const b = Buffer.allocUnsafe(size - at); return b.subarray(0, readSync(fd, b, 0, b.length, at)); };
          const r = parseResume(resume);
          if (r && r.size <= size) {
            // Read one byte early: it must be the newline ending the previous line, or the file was rewritten.
            bufStart = Math.max(0, r.offset - 1);
            buf = readFrom(bufStart);
            if (r.offset === 0 || buf[0] === 10) {
              pos = r.offset - bufStart;
              from = r.events; promptNumber = r.prompt; lastTs = r.ts;
            } else {
              bufStart = 0;
              buf = readFrom(0);
            }
          } else {
            buf = readFrom(0);
          }
          consumed = bufStart + buf.length;
        } finally { closeSync(fd); }
      }
    } catch (e) {
      // LOUD: a rollout we matched but cannot read is capture silently losing a
      // session. Never return [] without saying which file and why.
      warn(`[capture:codex] unreadable rollout ${ref.path}: ${(e as Error).message}`);
      return { events: [], from: null, resume: null };
    }

    const turns: Turn[] = [];
    let cur: Turn | null = null;
    let totalLines = 0;
    let parseFailures = 0;
    let lineStart = 0;
    let tsBefore = lastTs;

    const startTurn = (userText: string) => {
      cur = { promptNumber: ++promptNumber, startOffset: lineStart, tsBefore, userText, parts: [], files: new Set(), tsEpoch: lastTs };
      turns.push(cur);
    };
    const ensureTurn = () => { if (!cur) startTurn(''); return cur!; };
    // Current Codex rollouts can place generated context (for example an
    // <environment_context> message) immediately before the real prompt. No
    // assistant work separates them, so the last consecutive user message is
    // the actual turn boundary. This also collapses the legacy pair where the
    // same prompt appears as response_item/message and event_msg/user_message.
    const startOrReplaceTurn = (userText: string) => {
      if (cur && cur.parts.length === 0 && cur.files.size === 0) {
        cur.userText = userText;
        cur.tsEpoch = lastTs;
        return;
      }
      startTurn(userText);
    };
    // Legacy rollouts mirror an assistant message in both event_msg and
    // response_item, while task_complete repeats the final answer once more.
    // Preserve distinct assistant updates but never store the same text twice.
    const appendAssistant = (turn: Turn, message: string, label: 'assistant' | 'result') => {
      const normalized = message.trim();
      if (!normalized || turn.lastAssistantText === normalized) return;
      turn.lastAssistantText = normalized;
      turn.parts.push(`${label}: ${message}`);
    };

    while (pos < buf.length) {
      let nl = buf.indexOf(10, pos);
      if (nl < 0) nl = buf.length;
      lineStart = bufStart + pos;
      tsBefore = lastTs;
      // Per-line decode, split on \n: identical to toString().split(/\r?\n/) because a UTF-8 multibyte
      // sequence never contains 0x0A and JSON.parse / trim() ignore a trailing \r.
      const line = buf.toString('utf8', pos, nl);
      pos = nl + 1;
      if (!line.trim()) continue;
      totalLines++;
      let o: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
      try { o = JSON.parse(line); } catch { parseFailures++; continue; }
      const pt = (o.payload?.type as string | undefined) ?? undefined;
      const p = o.payload ?? {};
      if (o.timestamp) { const t = Date.parse(o.timestamp); if (!Number.isNaN(t)) lastTs = Math.floor(t / 1000); }

      if (o.type === 'session_meta') continue; // sessionId/cwd handled via ref/projectId

      if (pt === 'user_message') {
        const msg = String(p.message ?? '');
        if (msg.trim()) startOrReplaceTurn(msg);
        continue;
      }
      if (pt === 'message' && p.role === 'user') {
        const msg = textOf(p.content);
        if (msg.trim()) startOrReplaceTurn(msg);
        continue;
      }
      if (pt === 'message' && p.role === 'assistant') {
        appendAssistant(ensureTurn(), textOf(p.content), 'assistant');
        continue;
      }
      if (pt === 'agent_message') {
        const msg = typeof p.message === 'string' ? p.message : textOf(p.content);
        appendAssistant(ensureTurn(), msg, 'assistant');
        continue;
      }
      if (pt === 'task_complete') {
        const msg = String(p.last_agent_message ?? '');
        appendAssistant(ensureTurn(), msg, 'result');
        continue;
      }
      if (pt === 'custom_tool_call' || pt === 'function_call') {
        const name = String(p.name ?? 'tool');
        const arg = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : '';
        ensureTurn().parts.push(`${name}(${clip(arg, 300)})`);
        continue;
      }
      if (pt === 'mcp_tool_call_end') {
        const inv = (p.invocation ?? {}) as { server?: string; tool?: string; arguments?: unknown };
        ensureTurn().parts.push(`${inv.server ?? 'mcp'}:${inv.tool ?? 'tool'}(${clip(JSON.stringify(inv.arguments ?? {}), 300)})`);
        continue;
      }
      if (pt === 'patch_apply_end') {
        const t = ensureTurn();
        for (const f of parseUpdatedFiles(String(p.stdout ?? ''))) t.files.add(f);
        t.parts.push('applied a code patch');
        continue;
      }
      // everything else (reasoning, token_count, world_state, outputs, …) skipped
    }

    const keep = (t: Turn) => !!t.userText.trim() || t.parts.length > 0;
    const events = turns
      .filter(keep)
      .map((t) => ({
        session_id: ref.sessionId,
        project_id: opts.projectId,
        prompt_number: t.promptNumber,
        tool_name: 'codex-turn',
        tool_input_summary: clip(t.userText),
        tool_result_summary: clip(t.parts.join('\n')),
        files_read: [],
        files_modified: [...t.files],
        ts_epoch: t.tsEpoch,
        branch: null,
        origin_agent: 'codex' as const,
        source: 'capture:codex',
      }));

    // LOUD: a rollout that read and decompressed fine but yielded zero turns is
    // the exact shape a codex payload-format rename takes from outside — file
    // matched, parsed, produced nothing, and (before this) nothing said so. An
    // EMPTY file is not interesting (nothing was ever written yet); a file WITH
    // content that turned into nothing is. Reuse the same warn sink as the
    // unreadable-file case above rather than a second mechanism.
    if ((from ?? 0) + events.length === 0 && totalLines > 0) {
      const why = parseFailures > 0
        ? `${parseFailures}/${totalLines} line(s) failed JSON.parse`
        : `${totalLines} line(s) parsed but none matched a recognised payload type`;
      warn(`[capture:codex] ${ref.path} produced zero turns (${why}) — payload format may have changed`);
    }

    const last = turns[turns.length - 1];
    const next = consumed >= 0 && last
      ? [`v${PARSER_VERSION}`, consumed, last.startOffset, (from ?? 0) + turns.slice(0, -1).filter(keep).length, last.promptNumber - 1, last.tsBefore].join(':')
      : null;
    return { events, from, resume: next };
  }

  return {
    id: 'codex',
    available: () => existsSync(dir),
    describe: () => dir,
    enabled: () => (env.CAPTAIN_MEMO_CAPTURE_CODEX ?? '1') !== '0',

    discover(): SessionRef[] {
      const files: string[] = [];
      walk(dir, files);
      const refs: SessionRef[] = [];
      for (const path of files) {
        let st;
        try { st = statSync(path); } catch { continue; }
        if (now() - st.mtimeMs < quiesceMs) continue; // still being written
        const m = /-(\w{8}-\w{4}-\w{4}-\w{4}-\w{12})\.jsonl(\.zst)?$/.exec(path);
        const sessionId = m?.[1] ?? path;
        refs.push({ sessionId, path, marker: `${Math.floor(st.mtimeMs)}:${st.size}`, mtimeEpoch: Math.floor(st.mtimeMs / 1000) });
      }
      return refs;
    },

    extract(ref): RawObservationEvent[] {
      return parse(ref, null).events;
    },

    extractFrom: parse,

    eventCountAtMarker(ref, marker): number | null {
      if (ref.path.endsWith('.zst')) return null; // compressed rollouts are immutable; a byte prefix is not independently decodable
      const m = /:(\d+)$/.exec(marker);
      const size = Number(m?.[1]);
      if (!Number.isSafeInteger(size) || size < 0) return null;
      try {
        const bytes = readFileSync(ref.path);
        if (size > bytes.length) return null; // rewritten/truncated: let the driver's shorter-session rule re-ingest it
        return countTurns(bytes.subarray(0, size).toString('utf8'));
      } catch {
        return null;
      }
    },
  };
}
