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
  userText: string;
  parts: string[];
  files: Set<string>;
  tsEpoch: number;
  lastAssistantText?: string;
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
      let text: string;
      try {
        text = ref.path.endsWith('.zst')
          ? Buffer.from(Bun.zstdDecompressSync(readFileSync(ref.path))).toString('utf8')
          : readFileSync(ref.path, 'utf8');
      } catch (e) {
        // LOUD: a rollout we matched but cannot read is capture silently losing a
        // session. Never return [] without saying which file and why.
        warn(`[capture:codex] unreadable rollout ${ref.path}: ${(e as Error).message}`);
        return [];
      }

      const turns: Turn[] = [];
      let cur: Turn | null = null;
      let promptNumber = 0;
      let lastTs = Math.floor(now() / 1000);
      let totalLines = 0;
      let parseFailures = 0;

      const startTurn = (userText: string) => {
        cur = { promptNumber: ++promptNumber, userText, parts: [], files: new Set(), tsEpoch: lastTs };
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

      for (const line of text.split(/\r?\n/)) {
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

      const events = turns
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

      // LOUD: a rollout that read and decompressed fine but yielded zero turns is
      // the exact shape a codex payload-format rename takes from outside — file
      // matched, parsed, produced nothing, and (before this) nothing said so. An
      // EMPTY file is not interesting (nothing was ever written yet); a file WITH
      // content that turned into nothing is. Reuse the same warn sink as the
      // unreadable-file case above rather than a second mechanism.
      if (events.length === 0 && totalLines > 0) {
        const why = parseFailures > 0
          ? `${parseFailures}/${totalLines} line(s) failed JSON.parse`
          : `${totalLines} line(s) parsed but none matched a recognised payload type`;
        warn(`[capture:codex] ${ref.path} produced zero turns (${why}) — payload format may have changed`);
      }

      return events;
    },

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
