// src/worker/work-notes.ts — the work-coordination board's STORE logic (kv-backed, pure over an injected port).
//
// A "work note" is a transient claim a session publishes: "I (agent X, session Y) am working on <what>, touching
// <files>". Other sessions/agents on the SAME captain see it immediately (shared kv via the shared worker —
// cross-AI by construction), and across the fleet once the notes ride the poll (step 2). Notes are LEASES, not
// locks: each carries a TTL, and expired/malformed entries are lazily reaped on read, so a crashed session can
// never leave a ghost claim. See docs/specs/2026-06-14-work-coordination-notes-design.md.

import { globsOverlap } from './glob-overlap.ts';

/** The host-kv operations the board needs (MetaStore satisfies this). Injected so the unit stays pure. */
export interface WorkNoteKv {
  getKv(key: string): string | null;
  setKv(key: string, value: string): void;
  listKvPrefix(prefix: string): Array<{ key: string; value: string }>;
  deleteKv(key: string): void;
}

export interface WorkNote {
  agent: string;        // self-labelled: 'claude' | 'codex' | 'gemini' | 'cursor' | free string
  session_id: string;   // stable per-session id (the session refreshes/clears its OWN note by this)
  what: string;         // short free-text ("refactoring the billing module")
  files: string[];      // claimed globs ("billing/**", "src/auth/*.ts")
  ts: number;           // epoch-ms the lease was (re)published
  ttl_s: number;        // lease length; live while now < ts + ttl_s*1000
  captain?: string;     // set ONLY for fleet notes (which captain they came from); absent ⇒ this captain
  meaningful?: boolean; // the `what` is REAL declared intent (explicit, or enriched from an observation), not the
                        // hook's generic "editing N files" placeholder. Only meaningful claims join the semantic
                        // pass — two generic placeholders are byte-identical and would falsely match at cosine ~1.
}

export interface OverlapHit {
  agent: string; session_id: string; captain?: string; what: string; files: string[]; overlapping: string[];
  kind?: 'files' | 'semantic';   // how the collision was detected (absent ⇒ 'files', for back-compat)
  similarity?: number;           // cosine similarity in [0,1], semantic hits only
}

/** A live claim paired with the embedding of its meaning text (its `what`). The vector is computed + cached in
 *  the worker (out-of-band from the kv note, which must stay small), so it is passed alongside, not stored on
 *  the note. An empty `vec` means "not embedded" (embedder miss/timeout) — such a claim is skipped, never matched. */
export interface ClaimVec { note: WorkNote; vec: number[]; }

export const WORKNOTE_PREFIX = 'worknote:';
// The whole fleet's notes arrive as ONE snapshot pushed from the federation thread on each ~10s roster poll.
// Stored under a SINGLE kv key (NOT the worknote: prefix, so listLocalActive never sees it) so it is shared
// across the writer/reader thread split via the SQLite DB — realm-agnostic, unlike an in-process cache. The
// snapshot self-expires: if the federation thread stops pushing (hub down / un-federated), it goes stale and
// listFleetActive returns nothing, so a dead link can never leave phantom fleet claims on the board.
export const FLEET_SNAPSHOT_KEY = 'fleetnotes:snapshot';
const FLEET_SNAPSHOT_TTL_MS = 30_000;   // a snapshot older than this (no recent push) is ignored wholesale
const DEFAULT_TTL_S = 1800;        // 30 min
const MIN_TTL_S = 60;
const MAX_TTL_S = 8 * 3600;        // 8 h ceiling
const MAX_FILES = 64;
const MAX_NOTE_BYTES = 4000;
const MAX_FLEET_NOTES = 512;       // the whole fleet's claims flattened (per-captain hub-capped at 32)

function keyFor(sessionId: string): string { return WORKNOTE_PREFIX + sessionId; }
function isLive(n: WorkNote, now: number): boolean {
  return typeof n.ts === 'number' && typeof n.ttl_s === 'number' && now < n.ts + n.ttl_s * 1000;
}

export interface SetWorkNoteInput {
  agent?: string; session_id: string; what?: string; files?: string[]; ttl_s?: number;
  meaningful?: boolean;   // persisted onto the note (see WorkNote.meaningful); the route computes it
  // Handler-only routing hint (consumed by the /worknote/set HTTP route, NOT persisted on the note): when set,
  // the route replaces a generic `what` with the session's latest observation title before storing. The pure
  // setWorkNote ignores it.
  enrich_from_observations?: boolean;
}

/** Publish/refresh a session's claim (a heartbeat re-`set`s it). Returns the stored note. Validated + capped. */
export function setWorkNote(kv: WorkNoteKv, input: SetWorkNoteInput, now: number): WorkNote {
  const note: WorkNote = {
    agent: String(input.agent ?? 'unknown').slice(0, 32) || 'unknown',
    session_id: String(input.session_id).slice(0, 64),
    what: String(input.what ?? '').slice(0, 500),
    files: Array.isArray(input.files) ? input.files.slice(0, MAX_FILES).map((f) => String(f).slice(0, 256)) : [],
    ts: now,
    ttl_s: Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, Math.floor(Number(input.ttl_s) || DEFAULT_TTL_S))),
  };
  if (input.meaningful === true) note.meaningful = true;   // only store when true (keeps notes lean + back-compat)
  // Keep the stored value VALID JSON within the byte ceiling: a blind slice() would truncate mid-string and the
  // note would be silently lost (JSON.parse fails → reaped on read). Instead shed files (the only unbounded field
  // — up to MAX_FILES×256) until it fits; the minimal note (no files) is always well under the ceiling.
  while (note.files.length > 0 && JSON.stringify(note).length > MAX_NOTE_BYTES) note.files.pop();
  kv.setKv(keyFor(note.session_id), JSON.stringify(note));
  return note;
}

/** All LOCAL live notes (this captain), lazily reaping any expired/malformed key as it reads. */
export function listLocalActive(kv: WorkNoteKv, now: number): WorkNote[] {
  const out: WorkNote[] = [];
  for (const row of kv.listKvPrefix(WORKNOTE_PREFIX)) {
    let n: WorkNote | null = null;
    try { n = JSON.parse(row.value) as WorkNote; } catch { /* malformed */ }
    if (n && typeof n === 'object' && typeof n.session_id === 'string' && isLive(n, now)) out.push(n);
    else kv.deleteKv(row.key);   // lazy reap — a crashed session's claim evaporates
  }
  return out;
}

/** Drop a session's own claim (task done). */
export function clearWorkNote(kv: WorkNoteKv, sessionId: string): void {
  kv.deleteKv(keyFor(String(sessionId)));
}

/** Active claims (excluding `excludeSession`) whose file globs intersect `mineFiles`. */
export function overlapsAgainst(mineFiles: string[], others: WorkNote[], excludeSession: string): OverlapHit[] {
  const hits: OverlapHit[] = [];
  for (const o of others) {
    if (o.session_id === excludeSession) continue;
    const overlapping = globsOverlap(mineFiles ?? [], o.files ?? []);
    if (overlapping.length > 0) {
      hits.push({ agent: o.agent, session_id: o.session_id, ...(o.captain ? { captain: o.captain } : {}), what: o.what, files: o.files, overlapping, kind: 'files' });
    }
  }
  return hits;
}

/** Cosine similarity of two equal-length vectors, in [-1, 1]. Returns 0 (never NaN/throws) for a zero vector or
 *  a dimension mismatch — those are "no signal", not "perfectly opposite". Embeddings here are already unit-ish,
 *  but we normalise anyway so the function is correct for any vector. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]!, y = b[i]!; dot += x * y; na += x * x; nb += y * y; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Active claims (excluding my own session, and any session `alreadyFiles` already flagged via file overlap) whose
 *  MEANING is close to mine — cosine(myVec, theirVec) >= threshold. This is the cross-file half of coordination:
 *  two agents working on the same THING in different files never share a glob, so `overlapsAgainst` misses them;
 *  this catches them. Returns kind:'semantic' hits (no shared files) sorted most-similar first. Pure — vectors are
 *  supplied by the caller, which owns the embedder + its cache. A claim with no vector is skipped, never matched. */
export function semanticOverlaps(
  mine: { session_id: string; vec: number[] },
  others: ClaimVec[],
  threshold: number,
  alreadyFiles?: Set<string>,
): OverlapHit[] {
  if (!mine.vec || mine.vec.length === 0) return [];
  const hits: Array<OverlapHit & { similarity: number }> = [];
  for (const o of others) {
    const sid = o.note.session_id;
    if (sid === mine.session_id) continue;            // never overlap with myself
    if (alreadyFiles?.has(sid)) continue;             // a file overlap already warns about this session
    if (!o.vec || o.vec.length === 0) continue;       // not embedded ⇒ no semantic signal
    const sim = cosineSimilarity(mine.vec, o.vec);
    if (sim >= threshold) {
      hits.push({
        agent: o.note.agent, session_id: sid, ...(o.note.captain ? { captain: o.note.captain } : {}),
        what: o.note.what, files: o.note.files, overlapping: [], kind: 'semantic', similarity: sim,
      });
    }
  }
  return hits.sort((x, y) => y.similarity - x.similarity);
}

/** The live subset of an IN-MEMORY note array (the fleet cache holds notes pushed from the federation thread,
 *  not the kv; each still carries its own lease). Pure — no reaping side effect. */
export function filterActive(notes: WorkNote[], now: number): WorkNote[] {
  return (notes ?? []).filter((n) => n && typeof n === 'object' && typeof n.session_id === 'string' && isLive(n, now));
}

/** Store the fleet's current notes as ONE timestamped snapshot (the federation thread pushes this each poll).
 *  Input is sanitized + capped here. Returns the count stored. Replacing the whole snapshot each push is the
 *  reap: a sibling's dropped claim simply isn't in the next snapshot. */
export function setFleetSnapshot(kv: WorkNoteKv, input: unknown, now: number): number {
  const notes = sanitizeFleetNotes(input, now);
  kv.setKv(FLEET_SNAPSHOT_KEY, JSON.stringify({ at: now, notes }));
  return notes.length;
}

/** The live fleet notes (siblings' active claims), or [] if the snapshot is missing, malformed, or STALE (no
 *  push within FLEET_SNAPSHOT_TTL_MS ⇒ the federation link is down, so we surface no fleet claims at all). */
export function listFleetActive(kv: WorkNoteKv, now: number): WorkNote[] {
  const raw = kv.getKv(FLEET_SNAPSHOT_KEY);
  if (!raw) return [];
  try {
    const snap = JSON.parse(raw) as { at?: unknown; notes?: unknown };
    if (typeof snap.at !== 'number' || now - snap.at >= FLEET_SNAPSHOT_TTL_MS) return [];
    return filterActive(Array.isArray(snap.notes) ? (snap.notes as WorkNote[]) : [], now);
  } catch { return []; }
}

/** Validate + cap an UNTRUSTED array of FLEET notes (sibling captains' self-report, relayed via the hub) into
 *  clean, currently-live WorkNotes. Same field caps as setWorkNote; drops malformed/expired entries; preserves
 *  the `captain` tag the receiver stamped. Defense-in-depth: the hub already bounds these, but the worker route
 *  must not trust its input either. */
export function sanitizeFleetNotes(input: unknown, now: number): WorkNote[] {
  if (!Array.isArray(input)) return [];
  const out: WorkNote[] = [];
  for (const raw of input.slice(0, MAX_FLEET_NOTES)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const session_id = typeof r.session_id === 'string' ? r.session_id.slice(0, 64) : '';
    if (!session_id) continue;
    const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : NaN;
    const ttl_s = typeof r.ttl_s === 'number' && Number.isFinite(r.ttl_s) ? r.ttl_s : NaN;
    if (!Number.isFinite(ts) || !Number.isFinite(ttl_s)) continue;
    const note: WorkNote = {
      agent: (typeof r.agent === 'string' ? r.agent.slice(0, 32) : '') || 'unknown',
      session_id,
      what: typeof r.what === 'string' ? r.what.slice(0, 500) : '',
      files: Array.isArray(r.files)
        ? r.files.slice(0, MAX_FILES).filter((f): f is string => typeof f === 'string').map((f) => f.slice(0, 256))
        : [],
      ts,
      ttl_s: Math.min(MAX_TTL_S, Math.max(0, Math.floor(ttl_s))),
      ...(typeof r.captain === 'string' && r.captain ? { captain: r.captain.slice(0, 64) } : {}),
      ...(r.meaningful === true ? { meaningful: true } : {}),   // a sibling's declared-intent flag (else file-only)
    };
    if (isLive(note, now)) out.push(note);
  }
  return out;
}
