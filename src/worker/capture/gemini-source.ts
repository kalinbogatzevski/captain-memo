// gemini CaptureSource — Google Gemini CLI (@google/gemini-cli) session files under
// ~/.gemini/tmp/<projectHash>/chats/. Two on-disk formats:
//
//  * .jsonl (gemini-cli 0.61+, every new session): session-<YYYY-MM-DDTHH-MM>-<first 8 of sessionId>.jsonl,
//    append-only (appendFileSync, one JSON record per line). Resuming an old .json session copies it into
//    `<that path>l` (same stem + "l") and never writes the .json again.
//  * .json (older CLIs): one JSON document { sessionId, projectHash, messages: [...] } rewritten each turn.
//
// Record semantics are copied from gemini's own loader, loadConversationRecord() in
// packages/core/src/services/chatRecordingService.ts (installed 0.61.0 bundle chunk-JDPZ4CE3.js
// ~285980-286190, writer ChatRecordingService ~286190-286610, legacy fallback ~286655), checked in this order:
//   { $rewindTo: id }        delete that message and every message after it; an unknown id clears ALL messages
//   { id, type, content… }   a message; re-appending an existing id replaces it IN PLACE (Map.set keeps order),
//                            which is how the writer updates tool calls / thoughts of the last gemini message
//   { $set: {...} }          metadata merge; if it carries `messages` (array) the whole list is replaced
//   { sessionId, projectHash, messages? }  partial metadata (the first line); its messages are added, not replaced
//   blank / unparseable line skipped
// If no line supplied both sessionId and projectHash the file is parsed as one legacy JSON document,
// which is how a pretty-printed .json session loads, so one parser serves both formats.
// Message content is a string or a Part list ([{ text }, …]; new user messages are Part lists).
//
// Subagent transcripts (chats/<parentSessionId>/<id>.jsonl, no `session-` prefix) are not captured, as before.
// NOTE: distinct from agy, which uses ~/.gemini/antigravity-cli/conversations/*.db.
// Gemini CLI 0.25+ can use native hooks. This reader remains armed for older,
// hooks-disabled, or not-yet-trusted installations and yields once that exact
// session proves its native hook path.

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { RawObservationEvent } from '../../shared/types.ts';
import type { CaptureSource, IncrementalExtract, SessionRef } from './types.ts';
import { clip, entriesToTurns, type TranscriptEntry } from './shared.ts';

const DEFAULT_QUIESCE_MS = 60_000;

export interface GeminiSourceOptions {
  projectId: string;
  dir?: string;
  quiesceMs?: number;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

function tsToEpoch(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : v;
  if (typeof v === 'string') { const t = Date.parse(v); if (!Number.isNaN(t)) return Math.floor(t / 1000); }
  return undefined;
}

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => v !== null && typeof v === 'object';
const isStr = (r: Rec, k: string) => typeof r[k] === 'string';

/** Text of a string / Part / Part[] content, the way gemini joins it for firstUserMessage, minus thought parts
 *  (a $set.messages from updateMessagesFromHistory ~286604 stores model content as raw parts, thoughts included). */
function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(contentText).join('');
  return isObj(c) && typeof c.text === 'string' && !c.thought ? c.text : '';
}

/** A loaded message: its record, and the byte offset of the record that inserted it into the Map (an in-place
 *  update keeps that offset; a delete + re-insert resets it). */
interface Msg { id: string; rec: Rec; at: number }
/** `hist`: offset of the last record that rewrote existing history ($rewindTo, messages in $set / metadata). */
interface LoadState { meta: Rec; msgs: Map<string, Msg>; hist: number }
/** Incremental replay (see parse): crc32 of every closed message's id, and where the already-applied bytes end. */
interface Replay { closed: Uint32Array; end: number }
const crc = (id: string): number => Bun.hash.crc32(id);

/** Apply the records in buf (buf[0] at absolute offset `base`) onto st with gemini's loader rules (see header).
 *  With `replay` it returns false (the caller parses in full) on any record that could change history before the
 *  resume point, and skips closed-turn records the previous parse already applied. */
function applyRecords(buf: Buffer, base: number, st: LoadState, replay?: Replay): boolean {
  const addAll = (list: unknown[], at: number) => {
    for (const m of list) if (isObj(m) && isStr(m, 'id')) { const id = m.id as string; st.msgs.set(id, { id, rec: m, at: st.msgs.get(id)?.at ?? at }); }
  };
  let pos = 0;
  while (pos < buf.length) {
    let nl = buf.indexOf(10, pos);
    if (nl < 0) nl = buf.length;
    const at = base + pos;
    // Per-line decode on \n: identical to toString().split('\n') (UTF-8 never contains 0x0A).
    const line = buf.toString('utf8', pos, nl);
    pos = nl + 1;
    if (!line.trim()) continue;
    let r: unknown;
    try { r = JSON.parse(line); } catch { continue; }
    if (!isObj(r)) continue;
    if (isStr(r, '$rewindTo')) {
      if (replay) return false;
      st.hist = at;
      if (!st.msgs.has(r.$rewindTo as string)) { st.msgs.clear(); continue; }
      let found = false;
      for (const id of [...st.msgs.keys()]) { if (id === r.$rewindTo) found = true; if (found) st.msgs.delete(id); }
    } else if (isStr(r, 'id')) {
      const id = r.id as string;
      const had = st.msgs.get(id);
      if (replay && !had && hasHash(replay.closed, crc(id))) {
        if (at < replay.end) continue; // a closed-turn update the previous parse already applied
        return false;                  // a new one changes a turn before the resume point
      }
      st.msgs.set(id, { id, rec: r, at: had?.at ?? at });
    } else if (isObj(r.$set)) {
      if (Array.isArray(r.$set.messages)) { if (replay) return false; st.hist = at; st.msgs.clear(); addAll(r.$set.messages, at); }
      st.meta = { ...st.meta, ...r.$set };
    } else if (isStr(r, 'sessionId') && isStr(r, 'projectHash')) {
      if (replay) return false;
      st.meta = { ...st.meta, ...r };
      if (Array.isArray(r.messages)) { st.hist = at; addAll(r.messages, at); }
    }
  }
  return true;
}

const validMeta = (meta: Rec) => isStr(meta, 'sessionId') && isStr(meta, 'projectHash');

function legacyDocument(buf: Buffer): { sessionId?: string | undefined; messages: Rec[] } {
  try {
    const doc = JSON.parse(buf.toString('utf8')) as unknown;
    if (isObj(doc) && 'sessionId' in doc) {
      return { sessionId: typeof doc.sessionId === 'string' ? doc.sessionId : undefined, messages: Array.isArray(doc.messages) ? doc.messages.filter(isObj) : [] };
    }
  } catch { /* unreadable */ }
  return { messages: [] };
}

/** The session as gemini itself would load it (see header). */
export function loadGeminiSession(text: string | Buffer): { sessionId?: string | undefined; messages: Rec[] } {
  const buf = typeof text === 'string' ? Buffer.from(text) : text;
  const st: LoadState = { meta: {}, msgs: new Map(), hist: -1 };
  applyRecords(buf, 0, st);
  if (validMeta(st.meta)) return { sessionId: st.meta.sessionId as string, messages: [...st.msgs.values()].map((m) => m.rec) };
  return legacyDocument(buf);
}

/** Transcript entries of a message list, and the index of the message each entry came from. */
function toEntries(messages: Rec[]): { entries: TranscriptEntry[]; msgOf: number[] } {
  const entries: TranscriptEntry[] = [];
  const msgOf: number[] = [];
  for (const [i, raw] of messages.entries()) {
    const m = raw as { type?: string; content?: unknown; timestamp?: unknown; toolCalls?: Array<{ name?: string; args?: unknown }> };
    const tsEpoch = tsToEpoch(m.timestamp);
    const content = contentText(m.content);
    const push = (e: TranscriptEntry) => { entries.push(e); msgOf.push(i); };
    // Tool results are recorded as synthetic 'user' messages of functionResponse parts (~332021); they are
    // not prompts, and must not split the turn.
    if (m.type === 'user') { if (typeof m.content === 'string' || content.trim()) push({ role: 'user', text: content, tsEpoch }); }
    else if (m.type === 'gemini') {
      push({ role: 'assistant', text: content, tsEpoch });
      for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) push({ role: 'tool', text: `${tc.name ?? 'tool'}(${clip(JSON.stringify(tc.args ?? {}), 300)})`, tsEpoch });
    }
    // 'info' / 'error' / 'warning' → skipped
  }
  return { entries, msgOf };
}

/** Bump on ANY change to how records become messages, messages entries, or entries turns: a resume point written by
 *  another parser version is refused and the file is parsed in full. */
const PARSER_VERSION = 1;
/** Bytes before the resume offset that must be unchanged, together with everything from it to the applied end. */
const FINGERPRINT_BYTES = 4096;
const fingerprint = (b: Uint8Array): string => Bun.hash(b).toString(36);
const eventHash = (e: RawObservationEvent | undefined): string => e ? Bun.hash(JSON.stringify(e)).toString(36) : '';

interface Resume {
  v: number;
  end: number;        // absolute offset just past the last complete line applied
  offset: number;     // where the open turn's first message was inserted: the replay starts here
  events: number;     // full-extract events before the open turn
  prompt: number;     // prompt number before the open turn
  ts: number | null;  // entriesToTurns' lastTs just before the open turn; null = none seen (ref.mtimeEpoch then)
  user: boolean;      // the open turn opened on a user prompt, not implicitly
  sid: string;        // the session id every event carries
  fp: string;         // fingerprint of [offset - FINGERPRINT_BYTES, end)
  open: string;       // eventHash of the open turn's event ('' when it made none)
  closed: string;     // base64 Uint32Array of crc32(id) of every message before the open turn
}

function readResume(resume: string | null): Resume | null {
  if (!resume) return null;
  try {
    const r = JSON.parse(resume) as Resume;
    if (r.v !== PARSER_VERSION || ![r.end, r.offset, r.events, r.prompt].every(Number.isSafeInteger) || r.offset > r.end
      || !(r.ts === null || typeof r.ts === 'number') || typeof r.user !== 'boolean'
      || ![r.sid, r.fp, r.open, r.closed].every((s) => typeof s === 'string') || Buffer.from(r.closed, 'base64').length % 4) return null;
    return r;
  } catch { return null; }
}
// The closed ids' crc32s stay a sorted Uint32Array: a Set of 7,700 measured ~20 ms to build from it, this ~0.1 ms.
const decodeClosed = (s: string): Uint32Array => new Uint32Array(Uint8Array.from(Buffer.from(s, 'base64')).buffer);
const encodeClosed = (a: Uint32Array): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
function hasHash(sorted: Uint32Array, h: number): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid]! < h) lo = mid + 1; else hi = mid; }
  return sorted[lo] === h;
}

export function createGeminiSource(opts: GeminiSourceOptions): CaptureSource {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? env.CAPTAIN_MEMO_CAPTURE_GEMINI_DIR ?? join(homedir(), '.gemini', 'tmp');
  const quiesceMs = opts.quiesceMs ?? Number(env.CAPTAIN_MEMO_CAPTURE_QUIESCE_MS ?? DEFAULT_QUIESCE_MS);
  const now = opts.now ?? (() => Date.now());

  function walk(d: string, acc: string[]): void {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, acc);
      else if (st.isFile() && name.startsWith('session-') && /\.jsonl?$/.test(name)) acc.push(p);
    }
  }

  function turns(messages: Rec[], sessionId: string, fallbackTsEpoch: number, promptBase = 0) {
    const { entries, msgOf } = toEntries(messages);
    const t = entriesToTurns(entries, {
      sessionId,
      projectId: opts.projectId,
      originAgent: 'gemini',
      toolName: 'gemini-turn',
      sourceTag: 'capture:gemini',
      fallbackTsEpoch, // entriesToTurns' lastTs before entries[0]: how a resumed parse carries the timestamp over
    }, promptBase);
    return { entries, msgOf, t };
  }

  /** The resume point after a parse whose Map (in order) is `msgs`, or null when the last turn cannot be resumed
   *  from: its first message came in through a history-rewriting record, or an open id collides with a closed one. */
  function nextResume(msgs: Msg[], p: ReturnType<typeof turns>, sid: string, eventsBase: number, closedBefore: Uint32Array,
    hist: number, buf: Buffer, bufStart: number, tsBase: number | null): string | null {
    const { entries, msgOf, t } = p;
    if (t.lastStart === null) return null;
    const mi = msgOf[t.lastStart]!;
    // Map order is insertion order, so every open message was inserted at or after its first one.
    const offset = msgs[mi]!.at;
    if (hist >= offset) return null;
    const closed = new Uint32Array(closedBefore.length + mi);
    closed.set(closedBefore);
    closed.set(msgs.slice(0, mi).map((m) => crc(m.id)), closedBefore.length);
    closed.sort();
    if (msgs.slice(mi).some((m) => hasHash(closed, crc(m.id)))) return null;
    let ts = tsBase;
    for (const e of entries.slice(0, t.lastStart)) if (e.tsEpoch) ts = e.tsEpoch;
    const end = bufStart + buf.lastIndexOf(10) + 1;
    const r: Resume = {
      v: PARSER_VERSION, end, offset, events: eventsBase + t.eventsBeforeLast, prompt: t.lastPrompt - 1, ts,
      user: entries[t.lastStart]!.role === 'user', sid,
      fp: fingerprint(buf.subarray(Math.max(0, offset - FINGERPRINT_BYTES) - bufStart, end - bufStart)),
      open: eventHash(t.events[t.eventsBeforeLast]), closed: encodeClosed(closed),
    };
    return JSON.stringify(r);
  }

  function full(ref: SessionRef, buf: Buffer): IncrementalExtract {
    const st: LoadState = { meta: {}, msgs: new Map(), hist: -1 };
    applyRecords(buf, 0, st);
    if (!validMeta(st.meta)) {
      const doc = legacyDocument(buf);
      return { events: turns(doc.messages, doc.sessionId ?? ref.sessionId, ref.mtimeEpoch).t.events, from: null, resume: null };
    }
    const sid = st.meta.sessionId as string;
    const msgs = [...st.msgs.values()];
    const p = turns(msgs.map((m) => m.rec), sid, ref.mtimeEpoch);
    const resume = ref.path.endsWith('.jsonl') ? nextResume(msgs, p, sid, 0, new Uint32Array(0), st.hist, buf, 0, null) : null;
    return { events: p.t.events, from: null, resume };
  }

  /** Replay the open turn from r.offset, then the new bytes; null when the tail changes anything before it. */
  function incremental(ref: SessionRef, r: Resume, buf: Buffer, bufStart: number): IncrementalExtract | null {
    const st: LoadState = { meta: { sessionId: r.sid, projectHash: '' }, msgs: new Map(), hist: -1 };
    const closed = decodeClosed(r.closed);
    if (!applyRecords(buf.subarray(r.offset - bufStart), r.offset, st, { closed, end: r.end })) return null;
    if (!validMeta(st.meta) || st.meta.sessionId !== r.sid) return null; // a $set renamed the session: every event changes
    const msgs = [...st.msgs.values()];
    const p = turns(msgs.map((m) => m.rec), r.sid, r.ts ?? ref.mtimeEpoch, r.prompt);
    // The open turn must still open on its first message, or it merges into the closed turn before it.
    if (r.user && (p.entries[0]?.role !== 'user' || p.msgOf[0] !== 0)) return null;
    // Its event changed since the last tick: only the driver's eventCountAtMarker (full-parse path) re-enqueues it.
    if (r.open && eventHash(p.t.events[0]) !== r.open) return null;
    return { events: p.t.events, from: r.events, resume: nextResume(msgs, p, r.sid, r.events, closed, -1, buf, bufStart, r.ts) };
  }

  let last: { ref: SessionRef; events: RawObservationEvent[] } | null = null;

  // INCREMENTAL (.jsonl), the codex/kimi scheme adapted to gemini's keyed records: `resume` holds the offset where
  // the open (last) turn's first message was inserted, the event count / prompt number / lastTs before it, whether it
  // opened on a user prompt, the session id, the crc32 of every closed message's id, the open turn's event hash,
  // and a fingerprint of the 4 KiB before the offset through the end of the bytes applied. The next parse replays
  // from the offset: open-turn records rebuild the open messages in Map order, closed-turn records before the old
  // end are skipped (already applied), and the new bytes are applied with gemini's rules. Anything that could
  // change history before the offset parses in full with from=null: a $rewindTo, a $set carrying messages or
  // renaming the session, a metadata record, a (re-)appended closed id, a shorter file, a fingerprint mismatch,
  // another parser version, the open turn no longer opening on its first message. So does a change to the open
  // turn's already-ingested event: the driver slices a resumed extract by eventsIngested, and only
  // eventCountAtMarker, on the full-parse path, re-enqueues a changed turn. .json files are full reads, no resume.
  // None of these is per-turn: the writer re-appends only its last message (~286378-286500), and $set.messages
  // (updateMessagesFromHistory) comes from session start/resume, an aborted or failed turn's rollback, and setHistory
  // (~331930, 332156/332165, 332420).
  // Measured on a synthetic 36.5 MB / 1,933-turn .jsonl (4 messages + a $set per turn): one-turn growth
  // 1,246-1,400 ms (extract + eventCountAtMarker) -> 5-12 ms; a full parse unchanged (490-810 ms, both builds).
  // The resume point is 41 KB there (~5.3 B per closed message; this host's largest real session, 34 MB, has 395).
  // ponytail: like kimi's, the fingerprint proves only the 4 KiB before the offset (and the replayed bytes)
  // unchanged; gemini's one rewrite path (rewriteConversationFile) re-serialises the whole file, shifting it.
  // ponytail: a tick that finds the open turn's event changed (the turn grew across a quiesce gap) pays a full parse
  // plus eventCountAtMarker; an "unchanged count" field on IncrementalExtract, honoured by the driver, if it matters.
  function parse(ref: SessionRef, resume: string | null): IncrementalExtract {
    let r = ref.path.endsWith('.jsonl') ? readResume(resume) : null;
    let buf!: Buffer;
    let bufStart = 0;
    try {
      const fd = openSync(ref.path, 'r');
      try {
        const size = fstatSync(fd).size;
        const readFrom = (at: number) => { const b = Buffer.allocUnsafe(size - at); return b.subarray(0, readSync(fd, b, 0, b.length, at)); };
        if (r && r.end <= size) {
          bufStart = Math.max(0, r.offset - FINGERPRINT_BYTES);
          buf = readFrom(bufStart);
          if (buf.length < r.end - bufStart || fingerprint(buf.subarray(0, r.end - bufStart)) !== r.fp) r = null;
        } else r = null;
        const inc = r && incremental(ref, r, buf, bufStart);
        if (inc) return inc;
        if (bufStart > 0 || !buf) { bufStart = 0; buf = readFrom(0); }
      } finally { closeSync(fd); }
    } catch { return { events: [], from: null, resume: null }; }
    const res = full(ref, buf);
    last = { ref, events: res.events };
    return res;
  }

  return {
    id: 'gemini' as CaptureSource['id'],
    available: () => existsSync(dir),
    describe: () => dir,
    enabled: () => (env.CAPTAIN_MEMO_CAPTURE_GEMINI ?? '1') !== '0',

    discover(): SessionRef[] {
      const files: string[] = [];
      walk(dir, files);
      const all = new Set(files);
      const refs: SessionRef[] = [];
      for (const path of files) {
        // A resumed .json lives on as `<path>l`; the .json is frozen. Skipped before the quiesce check so a
        // still-active .jsonl never lets its old copy through. Both share the 8-hex id in the name, so the
        // .jsonl inherits the .json's cursor and the driver slices away the copied turns.
        if (path.endsWith('.json') && all.has(path + 'l')) continue;
        let st;
        try { st = statSync(path); } catch { continue; }
        if (now() - st.mtimeMs < quiesceMs) continue;
        const m = /session-.*-([0-9a-f]{6,})\.jsonl?$/.exec(path);
        // `:jsonl` tags a marker whose size is a byte offset into THIS append-only file (eventCountAtMarker).
        const marker = `${Math.floor(st.mtimeMs)}:${st.size}${path.endsWith('.jsonl') ? ':jsonl' : ''}`;
        refs.push({ sessionId: m?.[1] ?? path.replace(/l$/, ''), path, marker, mtimeEpoch: Math.floor(st.mtimeMs / 1000) });
      }
      return refs;
    },

    extract(ref): RawObservationEvent[] {
      return parse(ref, null).events;
    },

    extractFrom: parse,

    // A .jsonl is append-only in bytes but not in meaning: $rewindTo / $set.messages / a re-appended id change
    // turns that were already ingested. The driver slices a same-or-longer extract by eventsIngested, so a
    // rewind that regrows to the old length would hide the replacement turns. So instead of "events at the old
    // marker" this returns how many of those are still unchanged now (the file's prefix at the old size, parsed,
    // vs the whole file) and the driver re-enqueues from the first changed turn: nothing lost, nothing unchanged
    // replayed. null (driver falls back to eventsIngested) when the old marker was a .json's (resume copy: same
    // turns, plain slice is right). 0 (re-ingest all: duplicates, never loss) when the old size is no longer a
    // line boundary of this file, i.e. gemini rewrote it (rewriteConversationFile ~286323, only when a resume
    // could not reload the file). The driver calls this only after a full parse (from=null), i.e. when extractFrom
    // had no usable resume point or fell back.
    // Measured on a synthetic 36.5 MB .jsonl (1,500 turns; this host's largest .json is 34 MB): extract 759 ms,
    // this 2,230 ms parsing both prefix and whole file, 1,440 ms reusing extract's events.
    eventCountAtMarker(ref, marker): number | null {
      const old = /^\d+:(\d+):jsonl$/.exec(marker);
      if (!old || !ref.path.endsWith('.jsonl')) return null;
      let buf: Buffer;
      try { buf = readFileSync(ref.path); } catch { return null; }
      const size = Number(old[1]);
      if (buf.length < size || (size > 0 && buf[size - 1] !== 0x0a)) return 0;
      const before = full(ref, buf.subarray(0, size)).events;
      // The driver calls this right after extract(ref): compare against exactly the events it is about to slice.
      const after = last?.ref === ref ? last.events : full(ref, buf).events;
      let k = 0;
      while (k < before.length && k < after.length && JSON.stringify(before[k]) === JSON.stringify(after[k])) k++;
      return k;
    },
  };
}
