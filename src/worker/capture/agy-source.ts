// agy (Antigravity CLI) CaptureSource — agy has NO hook system, but it persists
// every session as a SQLite "trajectory" db under
// ~/.gemini/antigravity-cli/conversations/<uuid>.db. The step payloads are an
// undocumented protobuf BLOB, so we recover the human-readable transcript with a
// printable-run extractor (verified: recovers prompts, tool-call JSON, outputs,
// paths). Lossy, but it feeds a summarizer that distills anyway.
//
// ponytail: heuristic protobuf-text extraction, no schema — upgrade if Antigravity
// ever documents the format. A version bump degrades to weaker text, never a crash.
//
// NOTE: we watch the user's REAL ~/.gemini dir. The summarizer's own agy calls run
// under an isolated $HOME (<DATA_DIR>/agy-home), a different conversations dir, so
// they are never captured here.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import type { RawObservationEvent } from '../../shared/types.ts';
import type { CaptureSource, SessionRef } from './types.ts';

const DEFAULT_QUIESCE_MS = 60_000;
const SUMMARY_MAX = 2000;
const MAX_EVENTS = 8; // bound the enqueue; all share prompt_number=1 → one obs window

export interface AgySourceOptions {
  projectId: string;
  dir?: string;
  quiesceMs?: number;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

/** Recover printable ASCII runs (>= minRun chars) from a protobuf BLOB. */
export function extractPrintable(buf: Uint8Array, minRun = 4): string {
  let out = '';
  let run = '';
  const flush = () => { if (run.length >= minRun) out += run + '\n'; run = ''; };
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 9 || b === 10 || (b >= 32 && b <= 126)) run += String.fromCharCode(b);
    else flush();
  }
  flush();
  return out;
}

/** Drop consecutive duplicate lines (agy repeats the prompt across steps). */
function dedupeLines(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t && t !== out[out.length - 1]) out.push(t);
  }
  return out.join('\n');
}

function chunk(text: string, size: number, max: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length && chunks.length < max; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

export function createAgySource(opts: AgySourceOptions): CaptureSource {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? env.CAPTAIN_MEMO_CAPTURE_AGY_DIR ?? join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
  const quiesceMs = opts.quiesceMs ?? Number(env.CAPTAIN_MEMO_CAPTURE_QUIESCE_MS ?? DEFAULT_QUIESCE_MS);
  const now = opts.now ?? (() => Date.now());

  return {
    id: 'agy',
    available: () => existsSync(dir),
    enabled: () => (env.CAPTAIN_MEMO_CAPTURE_AGY ?? '1') !== '0',

    discover(): SessionRef[] {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return []; }
      const refs: SessionRef[] = [];
      for (const name of entries) {
        if (!name.endsWith('.db')) continue;
        const path = join(dir, name);
        // agy leaves a lingering -wal/-shm even AFTER the session ends (it doesn't
        // checkpoint on exit), so the WAL's PRESENCE can't mean "still live" — that
        // would make agy never capturable. Gate on the freshest mtime across
        // .db/-wal/-shm (the WAL is the real last write) and fold the WAL's
        // size/mtime into the marker so a resumed/grown session re-ingests. The
        // transcript lives in the WAL; a readonly open reads it (verified).
        let dbSt;
        try { dbSt = statSync(path); } catch { continue; }
        let freshestMs = dbSt.mtimeMs;
        let walSig = '';
        for (const suffix of ['-wal', '-shm']) {
          try {
            const s = statSync(path + suffix);
            freshestMs = Math.max(freshestMs, s.mtimeMs);
            walSig += `:${Math.floor(s.mtimeMs)}:${s.size}`;
          } catch { /* sibling absent — fine */ }
        }
        if (now() - freshestMs < quiesceMs) continue; // still being written
        refs.push({
          sessionId: name.slice(0, -3),
          path,
          marker: `${Math.floor(dbSt.mtimeMs)}:${dbSt.size}${walSig}`,
          mtimeEpoch: Math.floor(freshestMs / 1000),
        });
      }
      return refs;
    },

    extract(ref): RawObservationEvent[] {
      let text = '';
      let db: Database | null = null;
      try {
        db = new Database(ref.path, { readonly: true });
        const rows = db.query('SELECT step_payload FROM steps ORDER BY idx').all() as Array<{ step_payload: unknown }>;
        const pieces: string[] = [];
        for (const r of rows) {
          const blob = r.step_payload;
          if (blob instanceof Uint8Array) pieces.push(extractPrintable(blob));
          else if (blob && typeof blob === 'object' && 'length' in (blob as object)) pieces.push(extractPrintable(Uint8Array.from(blob as ArrayLike<number>)));
        }
        text = dedupeLines(pieces.join('\n'));
      } catch {
        return []; // unreadable / schema drift — skip, never crash the tick
      } finally {
        db?.close();
      }

      if (!text.trim()) return [];
      const tsEpoch = ref.mtimeEpoch;
      return chunk(text, SUMMARY_MAX, MAX_EVENTS).map((piece, i) => ({
        session_id: ref.sessionId,
        project_id: opts.projectId,
        prompt_number: 1, // agy transcripts have no reliable turn boundaries → one obs window
        tool_name: 'agy-session',
        tool_input_summary: i === 0 ? 'agy session transcript (recovered)' : `part ${i + 1}`,
        tool_result_summary: piece,
        files_read: [],
        files_modified: [],
        ts_epoch: tsEpoch,
        branch: null,
        origin_agent: 'agy' as const,
        source: 'capture:agy',
      }));
    },
  };
}
