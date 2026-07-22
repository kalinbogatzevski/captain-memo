// gemini CaptureSource — Google Gemini CLI (@google/gemini-cli) writes one JSON
// file per session at ~/.gemini/tmp/<projectHash>/chats/session-<ISO>-<id>.json:
//   { sessionId, projectHash, startTime, lastUpdated, messages: [
//       { id, timestamp, type: 'user'|'gemini'|'info', content,
//         thoughts?, toolCalls?: [{ name, args, result, status }] } ] }
// A single JSON object rewritten each turn (not append-only) — fully readable.
// NOTE: distinct from agy, which uses ~/.gemini/antigravity-cli/conversations/*.db.
// Gemini CLI has no hook system, so we read the file after the session goes idle.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { RawObservationEvent } from '../../shared/types.ts';
import type { CaptureSource, SessionRef } from './types.ts';
import { clip, entriesToTurnEvents, type TranscriptEntry } from './shared.ts';

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
      else if (st.isFile() && name.startsWith('session-') && name.endsWith('.json')) acc.push(p);
    }
  }

  return {
    id: 'gemini' as CaptureSource['id'],
    available: () => existsSync(dir),
    describe: () => dir,
    enabled: () => (env.CAPTAIN_MEMO_CAPTURE_GEMINI ?? '1') !== '0',

    discover(): SessionRef[] {
      const files: string[] = [];
      walk(dir, files);
      const refs: SessionRef[] = [];
      for (const path of files) {
        let st;
        try { st = statSync(path); } catch { continue; }
        if (now() - st.mtimeMs < quiesceMs) continue;
        const m = /session-.*-([0-9a-f]{6,})\.json$/.exec(path);
        refs.push({ sessionId: m?.[1] ?? path, path, marker: `${Math.floor(st.mtimeMs)}:${st.size}`, mtimeEpoch: Math.floor(st.mtimeMs / 1000) });
      }
      return refs;
    },

    extract(ref): RawObservationEvent[] {
      let doc: { sessionId?: string; messages?: unknown[] };
      try { doc = JSON.parse(readFileSync(ref.path, 'utf8')); } catch { return []; }
      const messages = Array.isArray(doc.messages) ? doc.messages : [];
      const entries: TranscriptEntry[] = [];
      for (const raw of messages) {
        const m = raw as { type?: string; content?: unknown; timestamp?: unknown; toolCalls?: Array<{ name?: string; args?: unknown }> };
        const tsEpoch = tsToEpoch(m.timestamp);
        const content = typeof m.content === 'string' ? m.content : '';
        if (m.type === 'user') entries.push({ role: 'user', text: content, tsEpoch });
        else if (m.type === 'gemini') {
          entries.push({ role: 'assistant', text: content, tsEpoch });
          for (const tc of m.toolCalls ?? []) entries.push({ role: 'tool', text: `${tc.name ?? 'tool'}(${clip(JSON.stringify(tc.args ?? {}), 300)})`, tsEpoch });
        }
        // 'info' → skipped
      }
      return entriesToTurnEvents(entries, {
        sessionId: doc.sessionId ?? ref.sessionId,
        projectId: opts.projectId,
        originAgent: 'gemini',
        toolName: 'gemini-turn',
        sourceTag: 'capture:gemini',
        fallbackTsEpoch: ref.mtimeEpoch,
      });
    },
  };
}
