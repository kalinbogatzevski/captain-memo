// src/worker/cli-session-usage.ts
//
// Per-session rows for the AI CLIs other than Claude Code: Codex, opencode and Gemini. Same shape as a Claude row
// (NativeSessionUsage), tagged with `cli`, so /sessions/usage and the fleet board can list them beside Claude's.
//
// ROWS ONLY. These never enter the native totals (nativeUsageTotals, allTimeTotals): those keep meaning "Claude Code",
// and a per-CLI breakdown is a separate decision.
//
// Every figure is normalised to the Claude meaning, so a row reads the same whatever CLI wrote it:
//   input_tokens          fresh input, cache reads EXCLUDED (Codex and Gemini count cached input inside input)
//   cache_creation_tokens cache writes
//   cache_read_tokens     cache reads
//   output_tokens         output INCLUDING reasoning/thinking (opencode and Gemini count it apart)
// Window figures come from each record's own timestamp, never from file mtime.
//
// Liveness is activity only: a session appears while it wrote within the window. Claude Code's runtime registry
// (~/.claude/sessions) has no equivalent for these CLIs.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs';
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { basename, join } from 'path';
import { codexHomeDir } from '../shared/codex-home.ts';
import { loadGeminiSession } from './capture/gemini-source.ts';
import type { NativeSessionUsage } from './native-session-usage.ts';

export type CliSessionUsage = NativeSessionUsage & { cli: 'codex' | 'opencode' | 'gemini' };

interface Sum { input: number; cacheCreation: number; cacheRead: number; output: number }
interface Ev extends Sum { ts: number }

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const zero = (): Sum => ({ input: 0, cacheCreation: 0, cacheRead: 0, output: 0 });

function row(cli: CliSessionUsage['cli'], id: string, evs: Ev[], lastMs: number, windowMs: number, now: number,
  extra: { cwd?: string | undefined; model?: string | undefined; effort?: string | undefined; parent?: string | undefined }): CliSessionUsage {
  const life = zero(), win = zero();
  for (const e of evs) {
    life.input += e.input; life.cacheCreation += e.cacheCreation; life.cacheRead += e.cacheRead; life.output += e.output;
    if (now - e.ts <= windowMs) { win.input += e.input; win.cacheCreation += e.cacheCreation; win.cacheRead += e.cacheRead; win.output += e.output; }
  }
  return {
    cli, session_id: id.slice(0, 64),
    input_tokens: life.input, output_tokens: life.output, cache_creation_tokens: life.cacheCreation, cache_read_tokens: life.cacheRead,
    window_fresh_tokens: win.input + win.cacheCreation, window_output_tokens: win.output, window_cache_read_tokens: win.cacheRead,
    last_activity_epoch_ms: Math.round(lastMs),
    ...(extra.parent ? { parentSessionId: extra.parent.slice(0, 64) } : {}),
    ...(extra.cwd ? { cwd: extra.cwd } : {}),
    ...(extra.model ? { model: extra.model.slice(0, 64) } : {}),
    ...(extra.effort ? { effort: extra.effort.slice(0, 16) } : {}),
  } as CliSessionUsage;
}

// ── Codex ────────────────────────────────────────────────────────────────────────────────────────────────────────
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (or $CODEX_HOME/sessions). Per thread:
//   session_meta (the FIRST one: a subagent file repeats its parent's as line 2)  payload.id, payload.cwd,
//     payload.thread_source === 'subagent' with payload.source.subagent.thread_spawn.parent_thread_id
//   turn_context  payload.model, payload.effort, every turn (both can change mid-session)
//   event_msg/token_count  payload.info.{total_token_usage, last_token_usage}; total is cumulative per thread, last is
//     per API call. Consecutive events repeat a total, and a resume resets it, so: skip an event whose total equals the
//     previous one, then sum `last`. Checked against all 77 token-bearing rollouts on the dev captain (2026-11-23):
//     equal to the sum of each segment's final total in every one. cached_input_tokens is INSIDE input_tokens, and
//     output_tokens already includes reasoning (last_usage_includes_reasoning).
// INCREMENTAL, per file: a live rollout can reach 64 MB, so each call reads only what was appended since the last.
// Measured on the dev captain (2026-11-23, 94 rollouts + 48 Gemini chats, one of 34 MB), all three readers together:
// a 30-minute window 18 ms cold / 9 ms warm; a 400-day window 4.7 s cold (once per worker), 20 ms warm.

interface CodexAcc {
  offset: number; size: number;
  id?: string; cwd?: string; parent?: string; model?: string; effort?: string;
  prevTotal: number; evs: Ev[];
}
const CODEX = new Map<string, CodexAcc>();
const K_META = Buffer.from('"session_meta"'), K_TURN = Buffer.from('"turn_context"'), K_TOK = Buffer.from('"token_count"');
const READ_PIECE = 1 << 20;

function codexDigest(buf: Buffer, a: CodexAcc): number {
  const end = buf.lastIndexOf(10);
  if (end < 0) return 0;
  for (let pos = 0; pos <= end;) {
    const nl = buf.indexOf(10, pos);
    const line = buf.subarray(pos, nl);
    pos = nl + 1;
    const meta = a.id === undefined && line.includes(K_META);
    if (!meta && !line.includes(K_TURN) && !line.includes(K_TOK)) continue;
    let r: { timestamp?: string; type?: string; payload?: Record<string, any> };
    try { r = JSON.parse(line.toString('utf8')); } catch { continue; }
    const p = r.payload ?? {};
    if (r.type === 'session_meta' && a.id === undefined) {
      if (typeof p.id === 'string') a.id = p.id;
      if (typeof p.cwd === 'string' && p.cwd) a.cwd = p.cwd;
      const par = p.source?.subagent?.thread_spawn?.parent_thread_id;
      if (p.thread_source === 'subagent' && typeof par === 'string') a.parent = par;
    } else if (r.type === 'turn_context') {
      if (typeof p.model === 'string' && p.model) a.model = p.model;
      if (typeof p.effort === 'string' && p.effort) a.effort = p.effort;
    } else if (r.type === 'event_msg' && p.type === 'token_count' && p.info) {
      const total = n(p.info.total_token_usage?.total_tokens);
      if (total === a.prevTotal) continue;   // a repeated report of the same call
      a.prevTotal = total;
      const u = p.info.last_token_usage ?? {};
      const cached = n(u.cached_input_tokens);
      const ts = Date.parse(r.timestamp ?? '');
      a.evs.push({ ts: Number.isFinite(ts) ? ts : 0, input: Math.max(0, n(u.input_tokens) - cached),
        cacheCreation: n(u.cache_write_input_tokens), cacheRead: cached, output: n(u.output_tokens) });
    }
  }
  return end + 1;
}

function readCodex(windowMs: number, now: number, env: Record<string, string | undefined>): CliSessionUsage[] {
  const root = join(codexHomeDir(homedir(), env), 'sessions');
  const files: Array<{ p: string; size: number; mtime: number }> = [];
  const walk = (d: string): void => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (name.startsWith('rollout-') && name.endsWith('.jsonl') && now - st.mtimeMs <= windowMs) files.push({ p, size: st.size, mtime: st.mtimeMs });
    }
  };
  walk(root);
  const out: CliSessionUsage[] = [];
  for (const f of files) {
    let a = CODEX.get(f.p);
    if (!a || f.size < a.size) { a = { offset: 0, size: 0, prevTotal: -1, evs: [] }; CODEX.set(f.p, a); }   // new, or rewritten
    if (f.size > a.offset) {
      let fd: number | undefined;
      try {
        fd = openSync(f.p, 'r');
        while (a.offset < f.size) {
          // A line longer than one piece grows the read until it holds a whole line.
          let len = Math.min(READ_PIECE, f.size - a.offset), used = 0;
          for (;;) {
            const buf = Buffer.alloc(len);
            readSync(fd, buf, 0, len, a.offset);
            used = codexDigest(buf, a);
            if (used > 0 || a.offset + len >= f.size) break;
            len = Math.min(len * 2, f.size - a.offset);
          }
          if (used === 0) break;   // a trailing partial line: the next call reads it whole
          a.offset += used;
        }
      } catch { /* unreadable now: keep what was read */ } finally { if (fd !== undefined) closeSync(fd); }
    }
    a.size = f.size;
    const id = a.id ?? /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i.exec(f.p)?.[1];
    if (!id) continue;
    out.push(row('codex', id, a.evs, f.mtime, windowMs, now, { cwd: a.cwd, model: a.model, effort: a.effort, parent: a.parent }));
  }
  for (const k of CODEX.keys()) if (!files.some(f => f.p === k)) CODEX.delete(k);   // out of the window: forget it
  return out;
}

// ── opencode ─────────────────────────────────────────────────────────────────────────────────────────────────────
// ~/.local/share/opencode/opencode.db (SQLite, opened read-only). session.model is JSON {id, providerID, variant}; the
// variant is opencode's reasoning setting. Assistant messages carry data.tokens {input, output, reasoning,
// cache:{read, write}} and data.time.created; input already excludes the cache read (checked on ae, 2026-11-23).

/** session id → its assistant-message events, as of the session's time_updated: messages are re-read only when it moves. */
const OPENCODE = new Map<string, { updated: number; evs: Ev[]; lastModel?: string | undefined }>();

function readOpencode(windowMs: number, now: number, env: Record<string, string | undefined>): CliSessionUsage[] {
  const path = env.CAPTAIN_MEMO_CAPTURE_OPENCODE_DB ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(path)) return [];
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const sessions = db.query('SELECT id, parent_id, directory, model, time_updated FROM session WHERE time_updated >= ?')
      .all(now - windowMs) as Array<{ id: string; parent_id: string | null; directory: string | null; model: string | null; time_updated: number }>;
    const msgs = db.query('SELECT data FROM message WHERE session_id = ?');
    for (const k of OPENCODE.keys()) if (!sessions.some(s => s.id === k)) OPENCODE.delete(k);
    return sessions.map((s) => {
      const hit = OPENCODE.get(s.id);
      const evs: Ev[] = hit?.updated === s.time_updated ? hit.evs : [];
      let lastModel: string | undefined = hit?.updated === s.time_updated ? hit.lastModel : undefined;
      if (hit?.updated !== s.time_updated) for (const { data } of msgs.all(s.id) as Array<{ data: string }>) {
        let m: { role?: string; modelID?: string; providerID?: string; tokens?: Record<string, any>; time?: { created?: number } };
        try { m = JSON.parse(data); } catch { continue; }
        if (m.role !== 'assistant' || !m.tokens) continue;
        if (m.modelID) lastModel = m.providerID ? `${m.providerID}/${m.modelID}` : m.modelID;
        evs.push({ ts: n(m.time?.created), input: n(m.tokens.input), cacheCreation: n(m.tokens.cache?.write),
          cacheRead: n(m.tokens.cache?.read), output: n(m.tokens.output) + n(m.tokens.reasoning) });
      }
      OPENCODE.set(s.id, { updated: s.time_updated, evs, lastModel });
      let sm: { id?: string; providerID?: string; variant?: string } = {};
      try { sm = s.model ? JSON.parse(s.model) : {}; } catch { /* malformed: model from the messages */ }
      const model = lastModel ?? (sm.id ? (sm.providerID ? `${sm.providerID}/${sm.id}` : sm.id) : undefined);
      return row('opencode', s.id, evs, s.time_updated, windowMs, now,
        { cwd: s.directory ?? undefined, model, effort: sm.variant, parent: s.parent_id ?? undefined });
    });
  } catch { return []; } finally { db?.close(); }
}

// ── Gemini ───────────────────────────────────────────────────────────────────────────────────────────────────────
// ~/.gemini/tmp/<project>/chats/session-*.json[l]. A gemini message carries `model`, `timestamp` and
// tokens {input, output, cached, thoughts, tool, total}, per request (not cumulative); cached is INSIDE input,
// thoughts are outside output. Gemini records no effort. The project folder is a slug (newer CLIs, mapped back to a
// path by ~/.gemini/projects.json) or a sha256 of the path (older ones, not reversible: no cwd then).

/** path → what its last parse found. A .json session is one JSON document, so a change means a whole re-parse:
 *  measured 1.4 s for a real 34 MB chat (2026-11-23). So a file is re-parsed only when it changed, and one past
 *  GEMINI_BIG_BYTES at most once per GEMINI_BIG_REPARSE_MS: its row lags by up to that long, the writer thread is not
 *  blocked on every poll. ponytail: whole-file parse; a .jsonl offset reader would remove the lag if big live chats
 *  become common (Gemini CLI writes .jsonl since late 2026). */
const GEMINI = new Map<string, { sig: string; parsedAt: number; sid?: string | undefined; evs: Ev[]; model?: string | undefined }>();
const GEMINI_BIG_BYTES = 4 << 20;
const GEMINI_BIG_REPARSE_MS = 5 * 60_000;

/** The session id, model and per-request token events of one Gemini chat file; {} with no events when unreadable. */
function parseGeminiFile(p: string): { sid?: string | undefined; evs: Ev[]; model?: string | undefined } {
  let sess;
  try { sess = loadGeminiSession(readFileSync(p)); } catch { return { evs: [] }; }
  const evs: Ev[] = [];
  let model: string | undefined;
  for (const raw of sess.messages) {
    const m = raw as { type?: string; model?: string; timestamp?: string; tokens?: Record<string, unknown> };
    if (m.type !== 'gemini') continue;
    if (typeof m.model === 'string' && m.model) model = m.model;
    if (!m.tokens) continue;
    const cached = n(m.tokens.cached);
    const ts = Date.parse(m.timestamp ?? '');
    evs.push({ ts: Number.isFinite(ts) ? ts : 0, input: Math.max(0, n(m.tokens.input) - cached), cacheCreation: 0,
      cacheRead: cached, output: n(m.tokens.output) + n(m.tokens.thoughts) });
  }
  return { sid: sess.sessionId, evs, model };
}

function readGemini(windowMs: number, now: number, env: Record<string, string | undefined>): CliSessionUsage[] {
  const tmp = env.CAPTAIN_MEMO_CAPTURE_GEMINI_DIR ?? join(homedir(), '.gemini', 'tmp');
  let slugToPath = new Map<string, string>();
  try {
    const pj = JSON.parse(readFileSync(join(tmp, '..', 'projects.json'), 'utf8')) as { projects?: Record<string, string> };
    slugToPath = new Map(Object.entries(pj.projects ?? {}).map(([p, slug]) => [slug, p]));
  } catch { /* none: older CLI */ }
  let projects: string[];
  try { projects = readdirSync(tmp); } catch { return []; }
  // One session can span several files (a resume writes a new one with the same sessionId): merged per session.
  const bySid = new Map<string, { evs: Ev[]; last: number; cwd?: string | undefined; model?: string | undefined; modelAt: number }>();
  const seen = new Set<string>();
  for (const proj of projects) {
    const chats = join(tmp, proj, 'chats');
    let names: string[];
    try { names = readdirSync(chats); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('session-') || !(name.endsWith('.json') || name.endsWith('.jsonl'))) continue;
      if (name.endsWith('.json') && names.includes(name + 'l')) continue;   // the .jsonl sibling is the live one
      const p = join(chats, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (now - st.mtimeMs > windowMs) continue;
      seen.add(p);
      const sig = `${st.mtimeMs}:${st.size}`;
      let hit = GEMINI.get(p);
      const stale = !hit || (hit.sig !== sig && (st.size < GEMINI_BIG_BYTES || now - hit.parsedAt >= GEMINI_BIG_REPARSE_MS));
      if (stale) {
        hit = { sig, parsedAt: now, ...parseGeminiFile(p) };   // unreadable caches as empty: no retry every poll
        GEMINI.set(p, hit);
      }
      let cwd = slugToPath.get(proj);
      if (!cwd) { try { cwd = readFileSync(join(tmp, proj, '.project_root'), 'utf8').trim() || undefined; } catch { /* hash folder */ } }
      const sid = hit!.sid ?? basename(name).replace(/\.jsonl?$/, '');
      const acc = bySid.get(sid) ?? { evs: [], last: 0, modelAt: -1 };
      acc.evs.push(...hit!.evs);
      if (st.mtimeMs > acc.modelAt && hit!.model) { acc.model = hit!.model; acc.modelAt = st.mtimeMs; }   // the newest file's model
      acc.last = Math.max(acc.last, st.mtimeMs);
      acc.cwd ??= cwd;
      bySid.set(sid, acc);
    }
  }
  for (const k of GEMINI.keys()) if (!seen.has(k)) GEMINI.delete(k);
  return [...bySid].map(([sid, a]) => row('gemini', sid, a.evs, a.last, windowMs, now, { cwd: a.cwd, model: a.model }));
}

/** Rows for every non-Claude CLI session active within the window, newest first. Never throws: a CLI whose store is
 *  missing or unreadable contributes nothing. */
export function readCliSessionUsage(windowMs = 30 * 60_000, now = Date.now(), env: Record<string, string | undefined> = process.env): CliSessionUsage[] {
  // A worker that owns no host sessions (a gateway device worker: same user, same HOME as the operator's captain) sets
  // this, or it would report the operator's Codex/opencode/Gemini sessions under its own captain id.
  if (env.CAPTAIN_MEMO_CLI_SESSION_ROWS === '0') return [];
  const out: CliSessionUsage[] = [];
  for (const read of [readCodex, readOpencode, readGemini]) {
    try { out.push(...read(windowMs, now, env)); } catch { /* one CLI's failure never hides the others */ }
  }
  return out.sort((a, b) => b.last_activity_epoch_ms - a.last_activity_epoch_ms);
}

export function _resetCliUsageCache(): void { CODEX.clear(); OPENCODE.clear(); GEMINI.clear(); }
