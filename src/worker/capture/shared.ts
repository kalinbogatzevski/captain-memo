// Shared helpers for capture sources that read a role-tagged transcript
// (gemini / kimi / opencode). Each source parses its own on-disk format into a
// flat TranscriptEntry[]; this turns that into one RawObservationEvent per user
// turn (Claude-like granularity), so a session yields a few obs, not hundreds.
//
// codex/agy predate this and keep their own inline shaping — left as-is (tested).

import type { RawObservationEvent } from '../../shared/types.ts';
import type { OriginAgent } from '../../shared/origin-agent.ts';

export const SUMMARY_MAX = 2000; // matches the enqueue schema cap on the summary fields

export function clip(s: string, max = SUMMARY_MAX): string {
  const t = (s ?? '').trim();
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

interface Turn { promptNumber: number; userText: string; parts: string[]; files: Set<string>; tsEpoch: number }

/** Aggregate a flat role-tagged transcript into one event per user turn. */
export function entriesToTurnEvents(entries: TranscriptEntry[], meta: TurnMeta): RawObservationEvent[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  let promptNumber = 0;
  let lastTs = meta.fallbackTsEpoch;

  const start = (userText: string, ts: number): Turn => {
    cur = { promptNumber: ++promptNumber, userText, parts: [], files: new Set(), tsEpoch: ts };
    turns.push(cur);
    return cur;
  };
  const ensure = (): Turn => cur ?? start('', lastTs);

  for (const e of entries) {
    if (e.tsEpoch) lastTs = e.tsEpoch;
    if (e.role === 'system' || e.role === 'info') continue;
    let turn: Turn;
    if (e.role === 'user') turn = start(e.text, lastTs);
    else if (e.role === 'assistant') { turn = ensure(); if (e.text.trim()) turn.parts.push(`assistant: ${e.text}`); }
    else { turn = ensure(); if (e.text.trim()) turn.parts.push(e.text); } // tool
    if (e.files) for (const f of e.files) turn.files.add(f);
  }

  return turns
    .filter((t) => t.userText.trim() || t.parts.length > 0)
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
}
