// kimi CaptureSource — MoonshotAI kimi-cli persists a per-session transcript at
// ~/.kimi/sessions/<workdir-hash>/<session-uuid>/context.jsonl (verified live).
// Plain JSONL, one { role, content } object per line:
//   role ∈ { _system_prompt, user, assistant, tool, ... }, content = text.
// Same read-after-session model as codex.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import type { RawObservationEvent } from '../../shared/types.ts';
import type { CaptureSource, SessionRef } from './types.ts';
import { entriesToTurnEvents, type TranscriptEntry } from './shared.ts';

const DEFAULT_QUIESCE_MS = 60_000;
const TRANSCRIPT = 'context.jsonl';

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

  return {
    id: 'kimi' as CaptureSource['id'],
    available: () => existsSync(dir),
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
      let text: string;
      try { text = readFileSync(ref.path, 'utf8'); } catch { return []; }
      const entries: TranscriptEntry[] = [];
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let o: { role?: unknown; content?: unknown };
        try { o = JSON.parse(line); } catch { continue; }
        const content = typeof o.content === 'string' ? o.content : o.content == null ? '' : JSON.stringify(o.content);
        entries.push({ role: roleOf(o.role), text: content });
      }
      return entriesToTurnEvents(entries, {
        sessionId: ref.sessionId,
        projectId: opts.projectId,
        originAgent: 'kimi',
        toolName: 'kimi-turn',
        sourceTag: 'capture:kimi',
        fallbackTsEpoch: ref.mtimeEpoch,
      });
    },
  };
}
