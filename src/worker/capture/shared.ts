// Shared helpers for capture sources that read a role-tagged transcript
// (gemini / kimi / opencode). Each source parses its own on-disk format into a
// flat TranscriptEntry[]; this turns that into one RawObservationEvent per user
// turn (Claude-like granularity), so a session yields a few obs, not hundreds.
//
// codex/agy predate this and keep their own inline shaping — left as-is (tested).

import type { RawObservationEvent } from '../../shared/types.ts';
import type { OriginAgent } from '../../shared/origin-agent.ts';
import { redactSecrets } from '../../shared/redact-secrets.ts';

export const SUMMARY_MAX = 2000; // matches the enqueue schema cap on the summary fields

/** What redactSecrets needs to see past a cut to decide about a secret the cut lands in: the widest context of a rule that is not
 *  a lone private-key BEGIN (that one runs to the end of what it is given): a kv value is judged up to 1 024 chars, the XML and
 *  command-line rules look 200-300 ahead. A url password or JWT longer than this can still straddle the window edge.
 *  session-inbox.ts redactedHead() uses 10 200 for the same job, for a whole key body; here the key's BEGIN alone already redacts
 *  to the end of the window, so the reach can be a fifth of that. */
const REDACT_REACH = 2_048;

/** The head of `t` redacted BEFORE it is cut to `max`: a token the cut lands inside, cut first, is a head too short for its rule
 *  to match (a `glpat-` + 20 chars cut after 12 stays whole in the output); redacted first it goes whole. Only a window of `t` is
 *  redacted, widening until the redacted text holds `max` + REDACT_REACH chars or all of `t`: a tool argument of several MB
 *  costs ~1.4 ms to clip instead of the 0.77 s redacting it whole takes (6 MB, 2026-10-23). Over this host's own 982 captured
 *  events (codex, gemini, agy; nice 19, load ~3) the pass is 14 107 calls, 0.92 s of an 8.6 s full extraction (10.6%; call p50
 *  35 µs, p99 0.5 ms, max 8.9 ms). The result may be longer than `max`; the caller cuts. */
export function redactedHead(t: string, max: number): string {
  let end = 2 * max;
  let head = redactSecrets(t.slice(0, end)).text;
  while (head.length < max + REDACT_REACH && end < t.length) {
    end *= 2;
    head = redactSecrets(t.slice(0, end)).text;
  }
  return head;
}

/** Trim, redact credential-shaped values, THEN cut to `max` (redactedHead says why that order). The driver redacts the clipped
 *  event again, as the net for a source that does not clip through here. */
export function clip(s: string, max = SUMMARY_MAX): string {
  const t = redactedHead((s ?? '').trim(), max);
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool' | 'system' | 'info';
  text: string;
  /** Files this entry modified (best-effort; joined into the turn's files_modified). */
  files?: string[] | undefined;
  /** Entry time in epoch seconds, if known. */
  tsEpoch?: number | undefined;
}

export interface TurnMeta {
  sessionId: string;
  projectId: string;
  originAgent: OriginAgent;
  toolName: string;   // e.g. 'gemini-turn'
  sourceTag: string;  // e.g. 'capture:gemini'
  fallbackTsEpoch: number;
}

interface Turn { promptNumber: number; userText: string; parts: string[]; files: Set<string>; tsEpoch: number; start: number }

/** Aggregate a flat role-tagged transcript into one event per user turn. */
export function entriesToTurnEvents(entries: TranscriptEntry[], meta: TurnMeta): RawObservationEvent[] {
  return entriesToTurns(entries, meta).events;
}

/** entriesToTurnEvents plus where its LAST turn began, for an incremental resume. `promptBase` continues the
 *  numbering of turns before entries[0]. `lastStart` is the index in `entries` of the entry that opened the last
 *  turn (0 when it opened implicitly before any user entry; null when there is no turn), `eventsBeforeLast` the
 *  number of events the turns before it produced, `lastPrompt` its prompt number. Resuming from `lastStart` with
 *  promptBase = lastPrompt - 1 re-creates that turn exactly, but only for entries WITHOUT tsEpoch: a turn's
 *  timestamp depends on earlier entries' tsEpoch, which this does not carry across. */
export function entriesToTurns(entries: TranscriptEntry[], meta: TurnMeta, promptBase = 0): {
  events: RawObservationEvent[]; lastStart: number | null; eventsBeforeLast: number; lastPrompt: number;
} {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  let promptNumber = promptBase;
  let lastTs = meta.fallbackTsEpoch;

  const start = (userText: string, ts: number, at: number): Turn => {
    cur = { promptNumber: ++promptNumber, userText, parts: [], files: new Set(), tsEpoch: ts, start: at };
    turns.push(cur);
    return cur;
  };
  const ensure = (): Turn => cur ?? start('', lastTs, 0);

  for (const [i, e] of entries.entries()) {
    if (e.tsEpoch) lastTs = e.tsEpoch;
    if (e.role === 'system' || e.role === 'info') continue;
    let turn: Turn;
    if (e.role === 'user') turn = start(e.text, lastTs, i);
    else if (e.role === 'assistant') { turn = ensure(); if (e.text.trim()) turn.parts.push(`assistant: ${e.text}`); }
    else { turn = ensure(); if (e.text.trim()) turn.parts.push(e.text); } // tool
    if (e.files) for (const f of e.files) turn.files.add(f);
  }

  const keep = (t: Turn) => !!t.userText.trim() || t.parts.length > 0;
  const last = turns[turns.length - 1];
  const events = turns
    .filter(keep)
    .map((t) => ({
      session_id: meta.sessionId,
      project_id: meta.projectId,
      prompt_number: t.promptNumber,
      tool_name: meta.toolName,
      tool_input_summary: clip(t.userText),
      tool_result_summary: clip(t.parts.join('\n')),
      files_read: [],
      files_modified: [...t.files],
      ts_epoch: t.tsEpoch,
      branch: null,
      origin_agent: meta.originAgent,
      source: meta.sourceTag,
    }));
  return {
    events,
    lastStart: last ? last.start : null,
    eventsBeforeLast: turns.slice(0, -1).filter(keep).length,
    lastPrompt: last ? last.promptNumber : promptBase,
  };
}
