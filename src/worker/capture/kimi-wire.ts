// kimi 2.x transcript reader: `<home>/sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl`.
// Append-only JSONL, line 1 { type:'metadata', protocol_version, created_at }, then { type, ...payload, time }.
// Record semantics are copied from kimi-code's own reducer (agent-core-v2 contextTranscript.ts / loopEventFold.ts
// / conversationTime.ts at 2.2.0), read as source only; nothing here has been run against a real 2.x file.
//
// Handled (everything else is ignored, so an unknown or newer record type can never break a parse):
//   context.append_message     user (origin absent / 'user' / {kind:'user'}) = a prompt; assistant = text + tool calls
//                              (sessions imported by `kimi migrate` carry whole messages instead of loop events);
//                              tool = a tool result
//   context.append_loop_event  step.begin opens an assistant message; content.part text = assistant text (think is
//                              skipped); tool.call / tool.result paired by toolCallId
//   context.undo{count}        removes the last `count` user prompts and what followed them (the reducer's applyUndo)
//   context.clear / apply_compaction   floors an undo cannot cross; the turns before them stay captured, that
//                              conversation did happen
// Ignored on purpose: turn.prompt (the same prompt again), agent.message.appended / human.* (the engine's mirror),
// agent.switched and context.undone (kimi writes them as a triple with a context.undo, which already does the work:
// reading the branch tree as well would remove the same turns twice), metadata, subagent.*, goal.*, ...
// Not captured: a user-prompt hook's text (a text part with meta.source 'user prompt submit hook' wrapped in
// <hook_result>, which is where Captain Memo's own recall envelope arrives), sub-agent files, tool output (only that a
// call failed, like the other sources), images.
//
// Privacy: nothing parsed here is ever logged; a bad line is reported by number only (see wireEntries).

import { clip, type TranscriptEntry } from './shared.ts';

export const WIRE = 'wire.jsonl';
const HOOK_SOURCE = 'user prompt submit hook';
const ARGS_MAX = 300;

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** `time` in epoch seconds. The unit is not verified against a real file: kimi stamps Date.now() (ms), so a value
 *  past 1e12 is divided, anything smaller is taken as seconds (gemini-source's rule). */
const epoch = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? (v > 1e12 ? Math.floor(v / 1000) : v) : undefined;

/** The manifest renders `origin` as a string, the code as { kind, ... }: accept both. */
const originKind = (o: unknown): string | undefined => (typeof o === 'string' ? o : isObj(o) ? str(o.kind) : undefined);

/** conversationTime.ts isUndoAnchorOrigin: what `context.undo{count}` counts. */
function isAnchor(role: unknown, o: unknown): boolean {
  if (role !== 'user' || (isObj(o) && o.inTurn === true)) return false;
  const kind = originKind(o);
  return kind === undefined || kind === 'user'
    || ((kind === 'skill_activation' || kind === 'plugin_command') && isObj(o) && o.trigger === 'user-slash');
}

const isHookPart = (p: Rec, text: string): boolean =>
  (isObj(p.meta) && p.meta.source === HOOK_SOURCE) || /^\s*<(?:hook_result|memory-context)\b/.test(text);

/** The text parts of a message's content (a string in a hand-made file), minus a prompt hook's output when `user`. */
function textOf(content: unknown, user: boolean): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const p of content) {
    if (!isObj(p) || p.type !== 'text' || typeof p.text !== 'string') continue; // think / image / audio / video
    if (!user || !isHookPart(p, p.text)) out.push(p.text);
  }
  return out.join('\n');
}

type E = TranscriptEntry & { at: number };
interface Item { entries: E[]; anchor: boolean; injection: boolean; floor: boolean; id: string | undefined; owner: string | undefined }

const item = (p: Partial<Item> = {}): Item => ({ entries: [], anchor: false, injection: false, floor: false, id: undefined, owner: undefined, ...p });

/** contextTranscript.ts applyUndo. */
function undo(items: Item[], floor: number, count: number): void {
  if (!(count > 0)) return;
  let removed = 0;
  for (let i = items.length - 1; i >= floor; i--) {
    const it = items[i]!;
    if (it.injection) continue;
    if (it.floor) break;
    items.splice(i, 1);
    if (!it.anchor) continue;
    removed++;
    while (i > floor && it.id !== undefined && items[i - 1]!.injection && items[i - 1]!.owner === it.id) { items.splice(i - 1, 1); i--; }
    if (removed >= count) break;
  }
}

export interface WireEntries { entries: TranscriptEntry[]; offsets: number[]; skipped: number[] }

/** Records of buf[pos..] (buf[0] is file offset bufStart) as role-tagged entries, each with the byte offset of its
 *  line. `full`: buf starts the file. Only a line ended by \n is read: kimi writes JSON + \n in one append, so an
 *  unterminated tail is a writer mid-flush and is picked up whole on a later parse. A line that is not JSON is
 *  skipped and its 1-based line number returned (never its content). A resumed parse (full = false) returns null
 *  instead of guessing whenever the tail holds a `context.undo` (it can remove turns before the resume point) or a
 *  bad line (its number is unknown without the lines before): the caller then parses the whole file. */
export function wireEntries(buf: Buffer, bufStart: number, pos: number, full: boolean, fallbackTs: number): WireEntries | null {
  const items: Item[] = [];
  const calls = new Map<string, E>();
  const skipped: number[] = [];
  let floor = 0;
  let open: { it: Item; uuid: unknown } | null = null;
  let lineNo = 0;

  const text = (role: TranscriptEntry['role'], t: string, at: number, tsEpoch?: number): E => ({ role, text: t, at, ...(tsEpoch !== undefined ? { tsEpoch } : {}) });
  const toolEntry = (into: Item, id: unknown, name: unknown, args: string, at: number): void => {
    const e = text('tool', `${str(name) ?? 'tool'}(${clip(args, ARGS_MAX)})`, at);
    into.entries.push(e);
    if (typeof id === 'string') calls.set(id, e);
  };
  const result = (id: unknown, isError: unknown): void => {
    const e = typeof id === 'string' ? calls.get(id) : undefined;
    if (!e) return;
    calls.delete(id as string);
    if (isError === true) e.text += ' [error]';
  };

  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const at = bufStart + pos;
    const line = buf.toString('utf8', pos, nl);
    pos = nl + 1;
    lineNo++;
    if (!line.trim()) continue;
    let rec: unknown;
    try { rec = JSON.parse(line); } catch {
      if (!full) return null;
      skipped.push(lineNo);
      continue;
    }
    if (!isObj(rec)) continue;

    switch (rec.type) {
      case 'context.append_message': {
        const m = rec.message;
        if (!isObj(m)) break;
        const kind = originKind(m.origin);
        const it = item({
          anchor: isAnchor(m.role, m.origin), injection: kind === 'injection', id: str(m.id),
          owner: isObj(m.origin) ? str(m.origin.ownerPromptId) : undefined,
        });
        if (m.role === 'user' && (kind === undefined || kind === 'user')) {
          it.entries.push(text('user', textOf(m.content, true), at, epoch(rec.time) ?? fallbackTs));
        } else if (m.role === 'assistant' && kind !== 'hook_result' && kind !== 'injection') {
          const t = textOf(m.content, false);
          if (t.trim()) it.entries.push(text('assistant', t, at));
          for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
            if (!isObj(c)) continue;
            const fn: Rec = isObj(c.function) ? c.function : {}; // kimi's pre-1.1 shape nests name/arguments
            toolEntry(it, c.id, c.name ?? fn.name, str(c.arguments ?? fn.arguments) ?? '', at);
          }
        } else if (m.role === 'tool') result(m.toolCallId, m.isError);
        items.push(it);
        break;
      }
      case 'context.append_loop_event': {
        const ev = rec.event;
        if (!isObj(ev)) break;
        if (ev.type === 'step.begin') {
          open = { it: item(), uuid: ev.uuid };
          items.push(open.it);
        } else if (ev.type === 'step.end') {
          if (ev.finishReason !== 'interrupted' && ev.finishReason !== 'error') open = null;
        } else if (ev.type === 'content.part') {
          if (!open || ev.stepUuid !== open.uuid || !isObj(ev.part)) break;
          const t = ev.part.type === 'text' ? str(ev.part.text) : undefined; // think parts are reasoning
          if (t?.trim()) open.it.entries.push(text('assistant', t, at));
        } else if (ev.type === 'tool.call') {
          if (!open || ev.stepUuid !== open.uuid) break;
          toolEntry(open.it, ev.toolCallId, ev.name, JSON.stringify(ev.args ?? {}), at);
        } else if (ev.type === 'tool.result') {
          result(ev.toolCallId, isObj(ev.result) ? ev.result.isError : undefined);
        }
        break;
      }
      case 'context.apply_compaction':
        items.push(item({ floor: true }));
        open = null;
        break;
      case 'context.undo':
        if (!full) return null;
        if (typeof rec.count === 'number') undo(items, floor, rec.count);
        open = null;
        calls.clear();
        break;
      case 'context.clear':
        floor = items.length;
        open = null;
        calls.clear();
        break;
    }
  }

  const entries: TranscriptEntry[] = [];
  const offsets: number[] = [];
  for (const it of items) for (const { at, ...e } of it.entries) { entries.push(e); offsets.push(at); }
  return { entries, offsets, skipped };
}
