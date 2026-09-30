// kimi CaptureSource — MoonshotAI kimi-cli persists a per-session transcript at
// ~/.kimi/sessions/<workdir-hash>/<session-uuid>/context.jsonl (verified live).
// Plain JSONL, one { role, content } object per line:
//   role ∈ { _system_prompt, user, assistant, tool, ... }, content = text.
// Kimi 1.28+ can use native hooks. This read-after-session path remains the
// compatibility fallback for older or not-yet-proven native sessions.

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import type { RawObservationEvent } from '../../shared/types.ts';
import type { CaptureSource, IncrementalExtract, SessionRef } from './types.ts';
import { entriesToTurns, type TranscriptEntry } from './shared.ts';

const DEFAULT_QUIESCE_MS = 60_000;
const TRANSCRIPT = 'context.jsonl';
/** Bump on ANY change to how a line becomes an entry or entries become turns: a resume point written by
 *  another parser version is refused and the file is parsed in full. */
const PARSER_VERSION = 1;
/** Bytes before the resume offset that must be unchanged for the resume point to be trusted. */
const FINGERPRINT_BYTES = 4096;

export interface KimiSourceOptions {
  projectId: string;
  dir?: string;
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

/** `v<parser>:<size>:<offset>:<eventsBefore>:<promptBefore>:<fingerprint>`; null when absent/foreign/malformed. */
function parseResume(resume: string | null): { size: number; offset: number; events: number; prompt: number; fp: string } | null {
  const f = resume?.split(':');
  if (!f || f.length !== 6 || f[0] !== `v${PARSER_VERSION}`) return null;
  const [size, offset, events, prompt] = f.slice(1, 5).map(Number) as [number, number, number, number];
  if (![size, offset, events, prompt].every(Number.isSafeInteger) || offset > size) return null;
  return { size, offset, events, prompt, fp: f[5]! };
}

export function createKimiSource(opts: KimiSourceOptions): CaptureSource {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? env.CAPTAIN_MEMO_CAPTURE_KIMI_DIR ?? env.KIMI_SHARE_DIR ?? join(homedir(), '.kimi', 'sessions');
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
  function parse(ref: SessionRef, resume: string | null): IncrementalExtract {
    let buf!: Buffer;
    let bufStart = 0; // absolute file offset of buf[0]
    let pos = 0;      // index into buf of the next line
    let r = parseResume(resume);
    try {
      const fd = openSync(ref.path, 'r');
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
    } catch { return { events: [], from: null, resume: null }; }

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
    const t = entriesToTurns(entries, {
      sessionId: ref.sessionId,
      projectId: opts.projectId,
      originAgent: 'kimi',
      toolName: 'kimi-turn',
      sourceTag: 'capture:kimi',
      fallbackTsEpoch: ref.mtimeEpoch,
    }, r?.prompt ?? 0);

    const from = r ? r.events : null;
    let next: string | null = null;
    if (t.lastStart !== null) {
      const offset = offsets[t.lastStart]!;
      const fp = fingerprint(buf.subarray(Math.max(0, offset - FINGERPRINT_BYTES) - bufStart, offset - bufStart));
      next = [`v${PARSER_VERSION}`, bufStart + buf.length, offset, (from ?? 0) + t.eventsBeforeLast, t.lastPrompt - 1, fp].join(':');
    }
    return { events: t.events, from, resume: next };
  }

  return {
    id: 'kimi' as CaptureSource['id'],
    available: () => existsSync(dir),
    describe: () => dir,
    enabled: () => (env.CAPTAIN_MEMO_CAPTURE_KIMI ?? '1') !== '0',

    discover(): SessionRef[] {
      const files: string[] = [];
      walk(dir, files);
      const refs: SessionRef[] = [];
      for (const path of files) {
        let st;
        try { st = statSync(path); } catch { continue; }
        if (now() - st.mtimeMs < quiesceMs) continue;
        refs.push({ sessionId: basename(dirname(path)), path, marker: `${Math.floor(st.mtimeMs)}:${st.size}`, mtimeEpoch: Math.floor(st.mtimeMs / 1000) });
      }
      return refs;
    },

    extract(ref): RawObservationEvent[] {
      return parse(ref, null).events;
    },

    extractFrom: parse,
  };
}
