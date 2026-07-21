// codex CaptureSource — reads the plain-JSONL rollout transcripts codex persists
// under ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
//
// Verified line shapes (codex-cli 0.144.6):
//   session_meta                → { payload.id, payload.cwd }
//   event_msg/user_message      → { payload.message } — a real user turn boundary
//   event_msg|response_item/agent_message → assistant text (payload.message or content[].text)
//   response_item/custom_tool_call | function_call → { payload.name, payload.input|arguments }
//   event_msg/mcp_tool_call_end  → { payload.invocation.{server,tool,arguments} }
//   event_msg/patch_apply_end    → { payload.stdout } lists "Updated the following files: M /path"
//   event_msg/task_complete      → { payload.last_agent_message }
// reasoning / token_count / world_state / turn_context … are noise → skipped.
//
// We aggregate PER TURN (one event per user_message window) so a session yields
// Claude-like observations, not one obs per tool call.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { RawObservationEvent } from '../../shared/types.ts';
import type { CaptureSource, SessionRef } from './types.ts';

const DEFAULT_QUIESCE_MS = 60_000;
const SUMMARY_MAX = 2000; // matches the enqueue schema cap on the summary fields

export interface CodexSourceOptions {
  /** Corpus this worker owns — stamped as project_id on every captured event. */
  projectId: string;
  dir?: string;
  quiesceMs?: number;
  now?: () => number;
  env?: Record<string, string | undefined>;
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

interface Turn {
  promptNumber: number;
  userText: string;
  parts: string[];
  files: Set<string>;
  tsEpoch: number;
}

export function createCodexSource(opts: CodexSourceOptions): CaptureSource {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? env.CAPTAIN_MEMO_CAPTURE_CODEX_DIR ?? join(homedir(), '.codex', 'sessions');
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
      else if (st.isFile() && name.startsWith('rollout-') && name.endsWith('.jsonl')) acc.push(p);
    }
  }

  return {
    id: 'codex',
    available: () => existsSync(dir),
    enabled: () => (env.CAPTAIN_MEMO_CAPTURE_CODEX ?? '1') !== '0',

    discover(): SessionRef[] {
      const files: string[] = [];
      walk(dir, files);
      const refs: SessionRef[] = [];
      for (const path of files) {
        let st;
        try { st = statSync(path); } catch { continue; }
        if (now() - st.mtimeMs < quiesceMs) continue; // still being written
        const m = /-(\w{8}-\w{4}-\w{4}-\w{4}-\w{12})\.jsonl$/.exec(path);
        const sessionId = m?.[1] ?? path;
        refs.push({ sessionId, path, marker: `${Math.floor(st.mtimeMs)}:${st.size}`, mtimeEpoch: Math.floor(st.mtimeMs / 1000) });
      }
      return refs;
    },

    extract(ref): RawObservationEvent[] {
      let text: string;
      try { text = readFileSync(ref.path, 'utf8'); } catch { return []; }

      const turns: Turn[] = [];
      let cur: Turn | null = null;
      let promptNumber = 0;
      let lastTs = Math.floor(now() / 1000);

      const startTurn = (userText: string) => {
        cur = { promptNumber: ++promptNumber, userText, parts: [], files: new Set(), tsEpoch: lastTs };
        turns.push(cur);
      };
      const ensureTurn = () => { if (!cur) startTurn(''); return cur!; };

      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let o: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
        try { o = JSON.parse(line); } catch { continue; }
        const pt = (o.payload?.type as string | undefined) ?? undefined;
        const p = o.payload ?? {};
        if (o.timestamp) { const t = Date.parse(o.timestamp); if (!Number.isNaN(t)) lastTs = Math.floor(t / 1000); }

        if (o.type === 'session_meta') continue; // sessionId/cwd handled via ref/projectId

        if (pt === 'user_message') {
          startTurn(String(p.message ?? ''));
          continue;
        }
        if (pt === 'agent_message') {
          const msg = typeof p.message === 'string' ? p.message : textOf(p.content);
          if (msg.trim()) ensureTurn().parts.push(`assistant: ${msg}`);
          continue;
        }
        if (pt === 'task_complete') {
          const msg = String(p.last_agent_message ?? '');
          if (msg.trim()) ensureTurn().parts.push(`result: ${msg}`);
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

      return turns
        .filter((t) => t.userText.trim() || t.parts.length > 0)
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
    },
  };
}
