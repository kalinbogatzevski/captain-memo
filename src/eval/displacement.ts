// src/eval/displacement.ts
//
// DISPLACEMENT PROXY — the closest thing to evidence that memory earns its context
// cost, without re-running real work.
//
// The honest problem: memory's COST is directly measurable (injected_tokens), but its
// SAVING is not. "Tokens you did not spend re-deriving this" has no counter, because
// the road not taken leaves no trace. A single "saved: N" figure would be invented.
//
// What CAN be measured is displacement. If auto-injection is doing its job, a turn that
// received memory should need LESS re-discovery — fewer Read/Grep/Glob calls hunting for
// context the model would otherwise have to rebuild from the filesystem. That is a real
// effect with a real denominator, observable in data already on disk:
//
//   transcripts       → per-turn tool calls, timestamped
//   recall-audit.jsonl → which turns received an injection, timestamped, per session
//
// It is a PROXY, not proof. It shows association, not causation: turns that receive
// memory may differ systematically from those that do not (a fresh session's opening
// turn both lacks history and needs orientation). Reported as an observed difference
// with its sample sizes, never as a savings claim.

import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

/** Tools whose purpose is finding things the model does not already know. These are what
 *  memory is supposed to displace: if the answer was injected, it need not be hunted. */
const DISCOVERY_TOOLS = new Set(['Read', 'Grep', 'Glob']);

export interface TurnObservation {
  session_id: string;
  turn_start_ms: number;
  /** An injection landed for this session within the turn's window. */
  injected: boolean;
  injected_tokens: number;
  discovery_calls: number;
  /** All tool calls, so a change in discovery can be read against overall activity —
   *  fewer Reads because the turn did less of everything is not displacement. */
  total_calls: number;
}

export interface DisplacementReport {
  turns_with_memory: number;
  turns_without_memory: number;
  mean_discovery_with: number;
  mean_discovery_without: number;
  mean_total_with: number;
  mean_total_without: number;
  /** Median is reported alongside the mean because tool counts are heavily skewed —
   *  one 40-Read archaeology turn drags a mean that no typical turn resembles. */
  median_discovery_with: number;
  median_discovery_without: number;
  sessions_analysed: number;
  /** Observed reduction in discovery calls per turn (without − with). Positive means
   *  turns that received memory did less hunting. */
  reduction: number;
  /** Permutation-test p: the share of random label-shuffles that produce a reduction at
   *  least this large. Carried IN the report, never computed separately, because a
   *  difference without it invites exactly the overclaim this whole module exists to
   *  avoid — the first real run showed a 13% reduction at p = 0.38, i.e. noise. */
  p_value: number;
  /** p < 0.05 on a one-sided test. False is a legitimate, publishable answer. */
  significant: boolean;
}

/** One-sided permutation test on the difference in means. Deterministic (seeded), so a
 *  report is reproducible and two runs on the same data cannot disagree. */
function permutationP(withMem: number[], without: number[], iterations = 20_000): number {
  const observed = mean(without) - mean(withMem);
  if (withMem.length === 0 || without.length === 0) return 1;
  const pool = [...withMem, ...without];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let atLeast = 0;
  for (let i = 0; i < iterations; i++) {
    const s = [...pool];
    for (let j = s.length - 1; j > 0; j--) {
      const k = Math.floor(rnd() * (j + 1));
      [s[j], s[k]] = [s[k]!, s[j]!];
    }
    if (mean(s.slice(withMem.length)) - mean(s.slice(0, withMem.length)) >= observed) atLeast++;
  }
  return atLeast / iterations;
}

interface Line {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  message?: { content?: unknown };
}

/** A user-role message that is really a TOOL RESULT, not a prompt.
 *
 *  The API sends tool results back with role "user", so a naive `type === 'user'` split
 *  counts every tool round-trip as a new turn. Measured on a real transcript: 1 actual
 *  prompt against 10 tool results. That inflates the denominator ~10x, drives the
 *  per-turn discovery rate toward zero, and makes both arms look identical — which is
 *  exactly the null result the first run produced. */
function isToolResult(content: unknown): boolean {
  return Array.isArray(content)
    && content.some(b => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result');
}

/** How close an injection must be to a turn's start to count as belonging to it. The
 *  hook fires on UserPromptSubmit, so the audit line lands within a second or two of the
 *  turn beginning; a generous window absorbs clock skew without swallowing the previous
 *  turn's injection. */
const INJECTION_MATCH_MS = 20_000;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Injections keyed by session, as sorted (ts, tokens) pairs for a nearest-match lookup. */
async function injectionsBySession(auditPath: string): Promise<Map<string, Array<[number, number]>>> {
  const by = new Map<string, Array<[number, number]>>();
  let text: string;
  try {
    text = await readFile(auditPath, 'utf8');
  } catch {
    return by;
  }
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let d: { ts?: number; session_id?: string; injected_tokens?: number };
    try {
      d = JSON.parse(raw) as typeof d;
    } catch {
      continue;
    }
    if (typeof d.injected_tokens !== 'number' || !d.session_id || !d.ts) continue;
    const arr = by.get(d.session_id) ?? [];
    arr.push([d.ts, d.injected_tokens]);
    by.set(d.session_id, arr);
  }
  for (const arr of by.values()) arr.sort((a, b) => a[0] - b[0]);
  return by;
}

/** Split one transcript into turns and count the tools each used. A turn runs from a user
 *  message to the next one — the unit an injection is scoped to. */
function turnsOf(text: string, sessionId: string, inj: Array<[number, number]>): TurnObservation[] {
  const out: TurnObservation[] = [];
  let cur: TurnObservation | null = null;

  const close = () => { if (cur) out.push(cur); };

  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let d: Line;
    try {
      d = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;

    if (d.type === 'user' && Number.isFinite(ts)) {
      // A tool result is not a new turn — it belongs to the turn already open.
      if (isToolResult(d.message?.content)) continue;
      close();
      // Nearest injection within the match window — the audit line for this turn.
      let injected = false;
      let tokens = 0;
      for (const [its, tok] of inj) {
        const delta = its - ts;
        if (delta > INJECTION_MATCH_MS) break;          // sorted: nothing closer ahead
        if (Math.abs(delta) <= INJECTION_MATCH_MS) { injected = true; tokens = tok; }
      }
      cur = {
        session_id: sessionId, turn_start_ms: ts,
        injected, injected_tokens: tokens,
        discovery_calls: 0, total_calls: 0,
      };
      continue;
    }

    if (!cur) continue;
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      const blk = b as { type?: string; name?: string };
      if (blk.type !== 'tool_use' || !blk.name) continue;
      cur.total_calls++;
      if (DISCOVERY_TOOLS.has(blk.name)) cur.discovery_calls++;
    }
  }
  close();
  return out;
}

/**
 * Compare discovery-tool usage in turns that received memory against turns that did not.
 *
 * Only sessions that have BOTH kinds of turn are analysed. A session where memory never
 * fired contributes only "without" rows and would bias the comparison toward whatever
 * that session happened to be doing — the within-session contrast is the point.
 */
export async function displacementReport(opts: {
  transcriptsRoot?: string;
  auditPath?: string;
  sinceMs?: number;
  now?: number;
} = {}): Promise<DisplacementReport & { turns: TurnObservation[] }> {
  const root = opts.transcriptsRoot ?? join(homedir(), '.claude', 'projects');
  const auditPath = opts.auditPath
    ?? join(process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo'), 'recall-audit.jsonl');
  const now = opts.now ?? Date.now();
  const since = opts.sinceMs ? now - opts.sinceMs : 0;

  const inj = await injectionsBySession(auditPath);
  if (inj.size === 0) {
    return {
      turns_with_memory: 0, turns_without_memory: 0,
      mean_discovery_with: 0, mean_discovery_without: 0,
      mean_total_with: 0, mean_total_without: 0,
      median_discovery_with: 0, median_discovery_without: 0,
      sessions_analysed: 0, reduction: 0, p_value: 1, significant: false, turns: [],
    };
  }

  let dirs: string[] = [];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => join(root, d.name));
  } catch { /* no transcripts */ }

  const all: TurnObservation[] = [];
  let sessions = 0;

  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -'.jsonl'.length);
      const sessionInj = inj.get(sessionId);
      if (!sessionInj || sessionInj.length === 0) continue;   // memory never fired here

      const path = join(dir, name);
      try {
        if (since && (await stat(path)).mtimeMs < since) continue;
      } catch {
        continue;
      }
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      const turns = turnsOf(text, sessionId, sessionInj).filter(t => t.turn_start_ms >= since);
      const withMem = turns.filter(t => t.injected).length;
      // Both kinds required: a within-session contrast, not a cross-session one.
      if (withMem === 0 || withMem === turns.length) continue;
      sessions++;
      all.push(...turns);
    }
  }

  const w = all.filter(t => t.injected);
  const wo = all.filter(t => !t.injected);
  const p = permutationP(w.map(t => t.discovery_calls), wo.map(t => t.discovery_calls));
  return {
    turns_with_memory: w.length,
    turns_without_memory: wo.length,
    mean_discovery_with: mean(w.map(t => t.discovery_calls)),
    mean_discovery_without: mean(wo.map(t => t.discovery_calls)),
    mean_total_with: mean(w.map(t => t.total_calls)),
    mean_total_without: mean(wo.map(t => t.total_calls)),
    median_discovery_with: median(w.map(t => t.discovery_calls)),
    median_discovery_without: median(wo.map(t => t.discovery_calls)),
    sessions_analysed: sessions,
    reduction: mean(wo.map(t => t.discovery_calls)) - mean(w.map(t => t.discovery_calls)),
    p_value: p,
    significant: p < 0.05,
    turns: all,
  };
}
