// opencode CaptureSource — opencode persists ALL sessions in one SQLite db at
// ~/.local/share/opencode/opencode.db (verified live on ae.123net.link):
//   session(id, project_id, directory, title, time_created, time_updated, time_archived)
//   message(id, session_id, time_created, data)   data JSON: { role, agent, model }
//   part(id, message_id, session_id, time_created, data)  data JSON: { type:'text', text }
//                                                          or { type:'tool', tool, state{input,output} }
// One shared db (not per-session files), so discover() lists sessions IN the db
// and extract() reconstructs one. Times are epoch-MILLIS.

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import type { RawObservationEvent } from '../../shared/types.ts';
import type { CaptureSource, SessionRef } from './types.ts';
import { clip, entriesToTurnEvents, type TranscriptEntry } from './shared.ts';

const DEFAULT_QUIESCE_MS = 60_000;

export interface OpencodeSourceOptions {
  projectId: string;
  dbPath?: string;
  quiesceMs?: number;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

function partText(dataJson: string): { text: string; role: TranscriptEntry['role'] } | null {
  let d: { type?: string; text?: string; tool?: string; state?: { input?: unknown; output?: unknown } };
  try { d = JSON.parse(dataJson); } catch { return null; }
  if (d.type === 'text') return d.text?.trim() ? { text: d.text, role: 'assistant' } : null;
  if (d.type === 'tool') {
    const io = d.state?.input ?? d.state ?? {};
    return { text: `${d.tool ?? 'tool'}(${clip(JSON.stringify(io), 200)})`, role: 'tool' };
  }
  return null; // reasoning / step-start / file → skipped
}

export function createOpencodeSource(opts: OpencodeSourceOptions): CaptureSource {
  const env = opts.env ?? process.env;
  const dbPath = opts.dbPath ?? env.CAPTAIN_MEMO_CAPTURE_OPENCODE_DB ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  const quiesceMs = opts.quiesceMs ?? Number(env.CAPTAIN_MEMO_CAPTURE_QUIESCE_MS ?? DEFAULT_QUIESCE_MS);
  const now = opts.now ?? (() => Date.now());

  const open = (): Database => new Database(dbPath, { readonly: true });

  return {
    id: 'opencode' as CaptureSource['id'],
    available: () => existsSync(dbPath),
    enabled: () => (env.CAPTAIN_MEMO_CAPTURE_OPENCODE ?? '1') !== '0',

    discover(): SessionRef[] {
      let db: Database | null = null;
      try {
        db = open();
        const rows = db.query('SELECT id, time_updated, time_created FROM session').all() as Array<{ id: string; time_updated: number | null; time_created: number | null }>;
        const refs: SessionRef[] = [];
        for (const r of rows) {
          const updated = r.time_updated ?? r.time_created ?? 0;
          if (now() - updated < quiesceMs) continue; // still active
          refs.push({ sessionId: r.id, path: dbPath, marker: String(updated), mtimeEpoch: Math.floor(updated / 1000) });
        }
        return refs;
      } catch { return []; }
      finally { db?.close(); }
    },

    extract(ref): RawObservationEvent[] {
      let db: Database | null = null;
      try {
        db = open();
        const messages = db.query('SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC').all(ref.sessionId) as Array<{ id: string; data: string; time_created: number }>;
        const entries: TranscriptEntry[] = [];
        for (const m of messages) {
          let role: TranscriptEntry['role'] = 'assistant';
          try { const md = JSON.parse(m.data) as { role?: string }; if (md.role === 'user') role = 'user'; } catch { /* default assistant */ }
          const tsEpoch = m.time_created ? Math.floor(m.time_created / 1000) : undefined;
          const parts = db.query('SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC').all(m.id) as Array<{ data: string }>;
          const textBits: string[] = [];
          for (const p of parts) {
            const pt = partText(p.data);
            if (!pt) continue;
            if (pt.role === 'tool') entries.push({ role: 'tool', text: pt.text, tsEpoch });
            else textBits.push(pt.text);
          }
          if (textBits.length > 0) entries.push({ role, text: textBits.join('\n'), tsEpoch });
        }
        // Interleaving note: tool parts are emitted before the message's text bits within a
        // message; turn grouping is by user boundary, so ordering within a turn is cosmetic.
        return entriesToTurnEvents(entries, {
          sessionId: ref.sessionId,
          projectId: opts.projectId,
          originAgent: 'opencode',
          toolName: 'opencode-turn',
          sourceTag: 'capture:opencode',
          fallbackTsEpoch: ref.mtimeEpoch,
        });
      } catch { return []; }
      finally { db?.close(); }
    },
  };
}
