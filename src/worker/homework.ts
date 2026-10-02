// src/worker/homework.ts — the captain's HOMEWORK: ideas and todos parked for later, per captain — every AI session on this machine sees the same list.
//
// Kalin, 2026-09-18: "I have ideas and start typing them, but in the session we are still working on something
// else." A homework item is NOT a memory (a memory is a fact; homework is something to DO, with a lifecycle:
// open → claimed → done) and NOT a work claim (a claim is what a session is doing right now; homework waits for a
// session). It is captured without breaking the flow — `idea: …` / `todo: …` typed into any session is filed by the
// hook, or a session files it with todo_add — listed at every session start, and picked up by
// whichever session claims it.
import type { WorkNoteKv as InboxKv } from './work-notes.ts';

export interface HomeworkItem {
  id: string;             // short, sequential per captain — "#12" is how humans refer to it
  text: string;
  topics: string[];       // same normalisation as work claims: lowercase kebab, ≤5
  project?: string;       // the project it was filed from (cwd-derived), when known
  by: string;             // who filed it: a session id / name, or "hook"
  created_at: number;
  claimed_by?: string;
  claimed_at?: number;
  done_at?: number;
  done_by?: string;
  note?: string;          // what was done / why closed
  due?: string;           // when it is due (ISO 8601, UTC); from then on the session-start list leads with it, ⏰
}

const PREFIX = 'hw:';
const SEQ_KEY = 'hw:seq';
const MAX_TEXT = 2_000;
export const HOMEWORK_DONE_KEEP_MS = 7 * 24 * 3600_000;   // done items stay listable a week, then fall away

function normTopics(t: unknown): string[] {
  if (!Array.isArray(t)) return [];
  const out: string[] = [];
  for (const x of t) {
    if (typeof x !== 'string') continue;
    const k = x.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (k && !out.includes(k)) out.push(k);
    if (out.length >= 5) break;
  }
  return out;
}

function rowKey(id: string): string { return `${PREFIX}${id.padStart(8, '0')}`; }   // zero-padded so a prefix scan lists in order

function nextId(kv: InboxKv): string {
  const n = Number(kv.getKv(SEQ_KEY) ?? '0') + 1;
  kv.setKv(SEQ_KEY, String(n));
  return String(n);
}

/** File a homework item. Text is required; topics normalised; the id is the next number on this captain. */
export function addHomework(kv: InboxKv, m: { text: string; topics?: unknown; project?: string; by?: string; due?: unknown }, now: number = Date.now()): HomeworkItem {
  const text = String(m.text ?? '').trim().slice(0, MAX_TEXT);
  if (!text) throw new Error('empty');
  const due = m.due === undefined ? undefined : parseDue(m.due);   // before nextId: a refused due does not use up a number
  const item: HomeworkItem = {
    id: nextId(kv), text, topics: normTopics(m.topics),
    ...(m.project ? { project: String(m.project).slice(0, 128) } : {}),
    by: String(m.by ?? 'hook').slice(0, 128), created_at: now,
    ...(due ? { due } : {}),
  };
  kv.setKv(rowKey(item.id), JSON.stringify(item));
  return item;
}

/** A due time as ISO 8601 UTC. Takes an ISO date or date-time: a date-time without a zone is this host's local time, a
 *  bare date is this host's midnight. Throws 'bad_due' for anything else, an impossible date included. A reminder, not a job. */
export function parseDue(v: unknown): string {
  const t = typeof v === 'string' ? v.trim() : '';
  // JS reads a bare date as UTC midnight but a date-time without a zone as local: "on 2026-10-01" means local.
  // And it rolls an impossible day over (2026-09-31 becomes Oct 1): the day must exist in its month.
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (!d || new Date(Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!)).getUTCDate() !== +d[3]!) throw new Error('bad_due');
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00` : t);
  if (Number.isNaN(ms)) throw new Error('bad_due');
  return new Date(ms).toISOString();
}

export function getHomework(kv: InboxKv, id: string): HomeworkItem | null {
  const raw = kv.getKv(rowKey(String(id).replace(/^#/, '')));
  if (raw === null) return null;
  try { return JSON.parse(raw) as HomeworkItem; } catch { return null; }
}

/** List items: open (default), done (kept a week), or all — oldest first (the order they were filed). */
export function listHomework(kv: InboxKv, opts: { status?: 'open' | 'done' | 'all' } = {}, now: number = Date.now()): HomeworkItem[] {
  const status = opts.status ?? 'open';
  const out: HomeworkItem[] = [];
  for (const r of kv.listKvPrefix(PREFIX)) {
    if (r.key === SEQ_KEY) continue;
    let it: HomeworkItem;
    try { it = JSON.parse(r.value) as HomeworkItem; } catch { continue; }
    if (!it || typeof it.id !== 'string' || typeof it.text !== 'string') continue;
    const done = typeof it.done_at === 'number';
    if (done && now - it.done_at! > HOMEWORK_DONE_KEEP_MS) { kv.deleteKv(r.key); continue; }   // lazy reap
    if (status === 'open' && done) continue;
    if (status === 'done' && !done) continue;
    out.push(it);
  }
  return out.sort((a, b) => Number(a.id) - Number(b.id));
}

/** A session takes an item: visible to the fleet as "claimed by X" so nobody else starts it. Re-claiming is fine. */
export function claimHomework(kv: InboxKv, id: string, by: string, now: number = Date.now()): HomeworkItem | null {
  const it = getHomework(kv, id);
  if (!it || it.done_at) return null;
  const next: HomeworkItem = { ...it, claimed_by: String(by).slice(0, 128), claimed_at: now };
  kv.setKv(rowKey(it.id), JSON.stringify(next));
  return next;
}

export type UnclaimResult = { item: HomeworkItem } | { error: 'not_found' | 'not_claimed' | 'not_yours'; detail: string };

/** Hand back YOUR claim without closing the item: todo_claim had no undo, so an item claimed only to look at it stayed
 *  "claimed by X" for good. Refused when another session holds it, when nobody does. */
export function unclaimHomework(kv: InboxKv, id: string, by: string): UnclaimResult {
  const it = getHomework(kv, id);
  if (!it || it.done_at) return { error: 'not_found', detail: `no open homework #${String(id).replace(/^#/, '')}` };
  if (!it.claimed_by) return { error: 'not_claimed', detail: `#${it.id} is not claimed` };
  if (it.claimed_by !== String(by).slice(0, 128)) return { error: 'not_yours', detail: `#${it.id} is claimed by ${it.claimed_by}, not by you: only that session can hand it back` };
  const next: HomeworkItem = { ...it };
  delete next.claimed_by; delete next.claimed_at;
  kv.setKv(rowKey(it.id), JSON.stringify(next));
  return { item: next };
}

/** Close an item, with an optional note of what was done (or why it was dropped). */
export function doneHomework(kv: InboxKv, id: string, by: string, note?: string, now: number = Date.now()): HomeworkItem | null {
  const it = getHomework(kv, id);
  if (!it) return null;
  const next: HomeworkItem = { ...it, done_at: now, done_by: String(by).slice(0, 128), ...(note ? { note: String(note).slice(0, 500) } : {}) };
  kv.setKv(rowKey(it.id), JSON.stringify(next));
  return next;
}

/** `idea: …`, `todo: …`, `homework: …`, `later: …` at the start of a prompt — the capture the hook files without a turn. */
export function parseHomeworkPrompt(prompt: string): string | null {
  const m = /^\s*(?:idea|todo|homework|later|идея|за после)\s*[:\-—]\s*(\S[\s\S]*)$/i.exec(String(prompt));
  return m ? m[1]!.trim() : null;
}

/** The line the hook puts in front of the model once an item is filed — one line, no invitation to act on it now. */
export function homeworkFiledLine(it: HomeworkItem): string {
  return `📝 Filed as homework #${it.id} on this captain (not for now): ${it.text.split('\n')[0]!.slice(0, 160)} — todo_list() shows the list; the user may just want a short "noted".`;
}

/** An open item whose due time has come. */
export function isHomeworkDue(it: HomeworkItem, now: number): boolean {
  return !!it.due && !it.done_at && Date.parse(it.due) <= now;
}

/** Due items first, the one due longest ago first, then the rest in the order given. */
export function homeworkDueFirst(items: HomeworkItem[], now: number): HomeworkItem[] {
  const due = items.filter((it) => isHomeworkDue(it, now)).sort((a, b) => Date.parse(a.due!) - Date.parse(b.due!));
  return [...due, ...items.filter((it) => !isHomeworkDue(it, now))];
}

/** What a list puts before and after an open item's title: ["⏰ ", " (DUE since 2026-10-01 00:05)"] once it is due,
 *  ["", " (due 2026-10-01 00:05)"] before, ["", ""] with no due time. Times in this host's zone. */
export function homeworkDueParts(it: HomeworkItem, now: number): [string, string] {
  if (!it.due || it.done_at) return ['', ''];
  const at = new Date(it.due).toLocaleString('sv-SE').slice(0, 16);   // YYYY-MM-DD HH:MM
  return isHomeworkDue(it, now) ? ['⏰ ', ` (DUE since ${at})`] : ['', ` (due ${at})`];
}

/** The session-start line: what is waiting. Empty when nothing is open. Items that are due lead. */
export function homeworkStartLines(items: HomeworkItem[], now: number = Date.now()): string {
  if (items.length === 0) return '';
  const head = homeworkDueFirst(items, now).slice(0, 6).map((it) => { const [mark, due] = homeworkDueParts(it, now); return `  ${mark}#${it.id} ${it.text.split('\n')[0]!.slice(0, 100)}${due}${it.claimed_by ? ` (claimed by ${it.claimed_by})` : ''}${it.topics.length ? ` #${it.topics.join(' #')}` : ''}`; });
  return [`📝 Open homework on this captain (${items.length}): todo_list() for all; todo_claim(id) before you start one; todo_done(id, note) when it is.`, ...head, ...(items.length > 6 ? [`  … ${items.length - 6} more`] : [])].join('\n');
}
