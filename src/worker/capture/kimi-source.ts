// kimi CaptureSource — MoonshotAI kimi-cli persists a per-session transcript at
// ~/.kimi/sessions/<workdir-hash>/<session-uuid>/context.jsonl (verified live).
// Plain JSONL, one { role, content } object per line:
//   role ∈ { _system_prompt, user, assistant, tool, ... }, content = text.
// Kimi 1.28+ can use native hooks. This read-after-session path remains the
// compatibility fallback for older or not-yet-proven native sessions.
// Kimi 2.x (kimi-code) writes <home>/sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl instead and never
// context.jsonl (home = $KIMI_CODE_HOME, else ~/.kimi-code): that layout is read by kimi-wire.ts through the SAME
// source, as gemini reads .json and .jsonl, so one 'kimi' id, one on/off switch and one native-hook dedup cover both.
// A machine may hold both layouts (`kimi migrate` leaves ~/.kimi alone); each is discovered and captured on its own.

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import type { RawObservationEvent } from '../../shared/types.ts';
import type { CaptureSource, IncrementalExtract, SessionRef } from './types.ts';
import { entriesToTurns, type TranscriptEntry } from './shared.ts';
import { WIRE, wireEntries, type WireEntries } from './kimi-wire.ts';

const DEFAULT_QUIESCE_MS = 60_000;
const TRANSCRIPT = 'context.jsonl';
/** Bump on ANY change to how a line becomes an entry or entries become turns: a resume point written by
 *  another parser version is refused and the file is parsed in full. */
const PARSER_VERSION = 1;
/** The same for wire.jsonl, under its own prefix so a 1.x cursor (`v1:`) is never read as a 2.x one. */
const WIRE_PARSER_VERSION = 1;
/** Bytes before the resume offset that must be unchanged for the resume point to be trusted. */
const FINGERPRINT_BYTES = 4096;

export interface KimiSourceOptions {
  projectId: string;
  /** The 1.x sessions dir (context.jsonl). */
  dir?: string;
  /** The 2.x sessions dir (<home>/sessions, wire.jsonl). */
  codeDir?: string;
  /** Sink for "skipped unparseable line N of <path>" (the line's number only, never its content). Default console.warn. */
  warn?: (msg: string) => void;
  quiesceMs?: number;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

function roleOf(r: unknown): TranscriptEntry['role'] {
  const s = String(r ?? '');
  if (s === 'user') return 'user';
  if (s === 'assistant') return 'assistant';
  // kimi-internal bookkeeping (_system_prompt, _usage, _checkpoint, …) → skip.
  if (s.startsWith('_') || s.includes('system')) return 'system';
  return 'tool';
}

const fingerprint = (b: Uint8Array): string => Bun.hash(b).toString(36);

/** `<tag><parser>:<size>:<offset>:<eventsBefore>:<promptBefore>:<fingerprint>`, tag `v` (context.jsonl) or `w`
 *  (wire.jsonl); null when absent/foreign/malformed. */
function parseResume(resume: string | null, tag: string): { size: number; offset: number; events: number; prompt: number; fp: string } | null {
  const f = resume?.split(':');
  if (!f || f.length !== 6 || f[0] !== tag) return null;
  const [size, offset, events, prompt] = f.slice(1, 5).map(Number) as [number, number, number, number];
  if (![size, offset, events, prompt].every(Number.isSafeInteger) || offset > size) return null;
  return { size, offset, events, prompt, fp: f[5]! };
}

export function createKimiSource(opts: KimiSourceOptions): CaptureSource {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? env.CAPTAIN_MEMO_CAPTURE_KIMI_DIR ?? env.KIMI_SHARE_DIR ?? join(homedir(), '.kimi', 'sessions');
  // 2.x: where kimi-code itself keeps sessions. CAPTAIN_MEMO_CAPTURE_KIMI_DIR keeps its 1.x meaning and does not move this.
  const codeDir = opts.codeDir ?? join(env.KIMI_CODE_HOME || join(homedir(), '.kimi-code'), 'sessions');
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const warned = new Set<string>();
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
      else if (st.isFile() && name === TRANSCRIPT) acc.push(p);
    }
  }

  // INCREMENTAL, the codex scheme (see codex-source.ts parse): `resume` holds the byte offset of the line that
  // opened the LAST turn, the event count and prompt number before it, and the file size seen. Kimi lines carry
  // no timestamp (every event takes ref.mtimeEpoch), so no ts state is carried. Unlike a codex rollout,
  // context.jsonl IS rewritten: write_system_prompt prepends a line to a legacy file, revert_to/clear rotate it
  // and start over (kimi_cli/soul/context.py, 1.52.0), and the file can then outgrow the old size before we look.
  // A byte-before-offset newline check passes whenever such a shift happens to land on a line boundary, so the
  // resume point also fingerprints the FINGERPRINT_BYTES before the offset; any mismatch, a shorter file or
  // another parser version parses in full with from=null.
  // Measured on a synthetic 64.3 MB / 2,200-turn context.jsonl: growth by one turn 4,262 ms -> 1.2 ms; a full
  // parse 3,806 -> 1,293 ms (per-line decode instead of one 64 MB string + split), identical events.
  // ponytail: the fingerprint proves only the last 4 KiB before the offset unchanged, not the whole prefix; a
  // rewrite that keeps those bytes byte-identical but changes something earlier would resume. Every kimi rewrite
  // path either keeps the prefix verbatim (revert past the offset: resuming is then correct) or shifts it.
  type Resume = NonNullable<ReturnType<typeof parseResume>>;
  /** ref.path from the resume point when its fingerprint still holds, else whole; null when it cannot be read. */
  function load(path: string, resumeAt: Resume | null): { buf: Buffer; bufStart: number; pos: number; r: Resume | null } | null {
    let buf!: Buffer;
    let bufStart = 0; // absolute file offset of buf[0]
    let pos = 0;      // index into buf of the next line
    let r = resumeAt;
    try {
      const fd = openSync(path, 'r');
      try {
        const size = fstatSync(fd).size;
        const readFrom = (at: number) => { const b = Buffer.allocUnsafe(size - at); return b.subarray(0, readSync(fd, b, 0, b.length, at)); };
        if (r && r.size <= size) {
          bufStart = Math.max(0, r.offset - FINGERPRINT_BYTES);
          buf = readFrom(bufStart);
          pos = r.offset - bufStart;
          if (fingerprint(buf.subarray(0, pos)) !== r.fp) r = null;
        } else r = null;
        if (!r) { bufStart = 0; pos = 0; buf = readFrom(0); }
      } finally { closeSync(fd); }
    } catch { return null; }
    return { buf, bufStart, pos, r };
  }

  function legacyEntries(buf: Buffer, bufStart: number, pos: number): WireEntries {
    const entries: TranscriptEntry[] = [];
    const offsets: number[] = []; // absolute byte offset of each entry's line
    while (pos < buf.length) {
      let nl = buf.indexOf(10, pos);
      if (nl < 0) nl = buf.length;
      const lineStart = pos;
      // Per-line decode on \n: identical to toString().split(/\r?\n/) (UTF-8 never contains 0x0A; JSON.parse ignores \r).
      const line = buf.toString('utf8', pos, nl);
      pos = nl + 1;
      if (!line.trim()) continue;
      let o: { role?: unknown; content?: unknown };
      try { o = JSON.parse(line); } catch { continue; }
      const content = typeof o.content === 'string' ? o.content : o.content == null ? '' : JSON.stringify(o.content);
      entries.push({ role: roleOf(o.role), text: content });
      offsets.push(bufStart + lineStart);
    }
    return { entries, offsets, skipped: [] };
  }

  const turnMeta = (ref: SessionRef) => ({
    sessionId: ref.sessionId,
    projectId: opts.projectId,
    originAgent: 'kimi' as const,
    toolName: 'kimi-turn',
    sourceTag: 'capture:kimi',
    fallbackTsEpoch: ref.mtimeEpoch,
  });

  // wire.jsonl (2.x) goes through the same resume machinery, with two differences. It carries real `time`s, which
  // wireEntries puts on the user entries only (a turn's ts is its prompt's), so no ts state is carried either. And
  // it is not append-only in meaning: a `context.undo` in the new bytes can remove turns before the resume point,
  // so wireEntries hands back null for a tail that holds one (or an unparseable line, to report its number) and the
  // whole file is parsed instead. kimi also rewrites the file itself on a protocol migration or a repair, which the
  // fingerprint catches the same way.
  function parse(ref: SessionRef, resume: string | null): IncrementalExtract {
    const wire = basename(ref.path) === WIRE;
    const tag = wire ? `w${WIRE_PARSER_VERSION}` : `v${PARSER_VERSION}`;
    let ld = load(ref.path, parseResume(resume, tag));
    if (!ld) return { events: [], from: null, resume: null };
    let built = wire ? wireEntries(ld.buf, ld.bufStart, ld.pos, ld.r === null, ref.mtimeEpoch) : legacyEntries(ld.buf, ld.bufStart, ld.pos);
    if (!built && ld.r) {
      ld = load(ref.path, null);
      built = ld && wireEntries(ld.buf, 0, 0, true, ref.mtimeEpoch);
    }
    if (!ld || !built) return { events: [], from: null, resume: null };
    for (const n of built.skipped) {
      if (warned.has(`${ref.path}:${n}`)) continue;
      warned.add(`${ref.path}:${n}`);
      warn(`[capture:kimi] skipped unparseable line ${n} of ${ref.path}`);
    }
    const { buf, bufStart, r } = ld;
    const { entries, offsets } = built;
    const t = entriesToTurns(entries, turnMeta(ref), r?.prompt ?? 0);

    const from = r ? r.events : null;
    let next: string | null = null;
    if (t.lastStart !== null) {
      const offset = offsets[t.lastStart]!;
      const fp = fingerprint(buf.subarray(Math.max(0, offset - FINGERPRINT_BYTES) - bufStart, offset - bufStart));
      next = [tag, bufStart + buf.length, offset, (from ?? 0) + t.eventsBeforeLast, t.lastPrompt - 1, fp].join(':');
    }
    return { events: t.events, from, resume: next };
  }

  const subdirs = (d: string): string[] => {
    try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => join(d, e.name)); } catch { return []; }
  };

  return {
    id: 'kimi' as CaptureSource['id'],
    available: () => existsSync(dir) || existsSync(codeDir),
    describe: () => `${dir} + ${codeDir}`,
    enabled: () => (env.CAPTAIN_MEMO_CAPTURE_KIMI ?? '1') !== '0',

    discover(): SessionRef[] {
      const files: Array<[path: string, sessionId: string]> = [];
      const legacy: string[] = [];
      walk(dir, legacy);
      for (const path of legacy) files.push([path, basename(dirname(path))]);
      // sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl, three levels deep (not a walk: the home also holds
      // credentials/ and blobs). The main agent only: sub-agent transcripts are agents/<id>/wire.jsonl, not captured yet.
      for (const sdir of subdirs(codeDir).flatMap(subdirs)) files.push([join(sdir, 'agents', 'main', WIRE), basename(sdir)]);
      const refs: SessionRef[] = [];
      for (const [path, sessionId] of files) {
        let st;
        try { st = statSync(path); } catch { continue; }
        if (now() - st.mtimeMs < quiesceMs) continue;
        refs.push({ sessionId, path, marker: `${Math.floor(st.mtimeMs)}:${st.size}`, mtimeEpoch: Math.floor(st.mtimeMs / 1000) });
      }
      return refs;
    },

    extract(ref): RawObservationEvent[] {
      return parse(ref, null).events;
    },

    extractFrom: parse,

    // wire.jsonl only. The driver slices a same-or-longer extract by eventsIngested, but an undo removes turns that
    // were already ingested, so after one the slice would hide the replacement turns (or, with nothing replacing
    // them, replay what is left). Gemini's answer, adopted: how many of the events at the old marker (the file's
    // prefix at the old size, parsed) are still the same events now (the whole file); the driver re-enqueues from the
    // first one that changed. An undone turn that was already ingested stays in the corpus: nothing retracts it.
    // 0 (re-ingest all: duplicates, never loss) when the file is now shorter than the old size, i.e. rewritten.
    // ponytail: parses prefix and whole file, 2 full parses on a path only a full parse (a rewind, a rewrite, a
    // parser bump) reaches; gemini caches the last parse's events if the measured cost ever matters.
    eventCountAtMarker(ref, marker): number | null {
      const old = /^\d+:(\d+)$/.exec(marker);
      if (!old || basename(ref.path) !== WIRE) return null;
      let buf: Buffer;
      try { buf = readFileSync(ref.path); } catch { return null; }
      const size = Number(old[1]);
      if (buf.length < size) return 0;
      const events = (b: Buffer) => entriesToTurns(wireEntries(b, 0, 0, true, ref.mtimeEpoch)!.entries, turnMeta(ref)).events;
      const before = events(buf.subarray(0, size));
      const after = events(buf);
      let k = 0;
      while (k < before.length && k < after.length && JSON.stringify(before[k]) === JSON.stringify(after[k])) k++;
      return k;
    },
  };
}
