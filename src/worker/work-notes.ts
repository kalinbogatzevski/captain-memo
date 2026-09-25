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
  topics?: string[];    // WHAT the work is about, as 1–5 short kebab tags ("fleet-keys", "installer-windows") —
                        // the collision an operator cares about is two sessions on one TOPIC, whatever files they
                        // touch. Absent ⇒ untitled work (a hook auto-claim never derives one: a file is not a topic).
  ts: number;           // epoch-ms the lease was (re)published
  ttl_s: number;        // lease length; live while now < ts + ttl_s*1000
  captain?: string;     // set ONLY for fleet notes (which captain they came from); absent ⇒ this captain
  declared?: boolean;   // the `what` (and topics) came from an explicit work_set, not a hook auto-claim: a later
                        // auto-claim keeps them instead of overwriting them...
  declared_until?: number; // ...until this epoch-ms, the work_set's own lease. The edit heartbeat never extends it.
  meaningful?: boolean; // the `what` is REAL declared intent (explicit, or enriched from an observation), not the
                        // hook's generic "editing N files" placeholder. Only meaningful claims join the semantic
                        // pass — two generic placeholders are byte-identical and would falsely match at cosine ~1.
  repo_root?: string;   // shared-checkout stamp (see resolveRepoClaim): the git working-tree root this claim's
                        // files resolved into. Absent for plain file-claims (relative globs, scratchpad paths).
  branch?: string;      // the repo's current branch at claim time, when repo_root is set.
  is_dirty?: boolean;   // whether the working tree had uncommitted changes at claim time, when repo_root is set.
  // ── COMPUTED ON READ, NEVER STORED ──────────────────────────────────────────────────────────────
  // A claim is a HEARTBEAT: a live session re-`set`s it (the PreToolUse hook does so on every file-touching
  // tool call). `ts` is therefore "last sign of life", and a claim whose ts has not moved in a long while is
  // very likely a ghost — its session died and the lease is simply running out its declared TTL. These two
  // fields say so out loud; they are attached by decorateStaleness() at read time and never written to the kv.
  stale?: boolean;      // ts older than STALE_AFTER_MS ⇒ "probably dead, judge accordingly"
  age_s?: number;       // seconds since the claim was last refreshed
}

export interface OverlapHit {
  agent: string; session_id: string; captain?: string; what: string; files: string[]; overlapping: string[];
  repo_root?: string;            // the peer's checkout root (files hits): its `<repo_root>/**` is a whole-repo claim
  kind?: 'files' | 'semantic' | 'repo' | 'topics';   // how the collision was detected (absent ⇒ 'files', for back-compat)
  similarity?: number;           // cosine similarity in [0,1], semantic hits only
  stale?: boolean; age_s?: number;   // the peer's heartbeat view, copied from a decorated note (see heartbeatOf)
}

/** A live claim paired with the embedding of its meaning text (its `what`). The vector is computed + cached in
 *  the worker (out-of-band from the kv note, which must stay small), so it is passed alongside, not stored on
 *  the note. An empty `vec` means "not embedded" (embedder miss/timeout) — such a claim is skipped, never matched. */
export interface ClaimVec { note: WorkNote; vec: number[]; }

export const WORKNOTE_PREFIX = 'worknote:';
// The whole fleet's notes arrive as ONE snapshot pushed from the fleet thread on each ~10s roster poll.
// Stored under a SINGLE kv key (NOT the worknote: prefix, so listLocalActive never sees it) so it is shared
// across the writer/reader thread split via the SQLite DB — realm-agnostic, unlike an in-process cache. The
// snapshot self-expires: if the fleet thread stops pushing (hub down / disconnected), it goes stale and
// listFleetActive returns nothing, so a dead link can never leave phantom fleet claims on the board.
export const FLEET_SNAPSHOT_KEY = 'fleetnotes:snapshot';
const FLEET_SNAPSHOT_TTL_MS = 30_000;   // a snapshot older than this (no recent push) is ignored wholesale
const DEFAULT_TTL_S = 1800;        // 30 min
const MIN_TTL_S = 60;
const MAX_TTL_S = 8 * 3600;        // 8 h ceiling
/** A requested lease in seconds, clamped the way every claim is (default 30 min, 60 s to 8 h). */
export const leaseSeconds = (ttl: unknown): number => Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, Math.floor(Number(ttl) || DEFAULT_TTL_S)));
const MAX_FILES = 64;
const MAX_NOTE_BYTES = 4000;
const MAX_FLEET_NOTES = 512;       // the whole fleet's claims flattened (per-captain hub-capped at 32)

// STALENESS CEILING. A claim is a heartbeat — the PreToolUse hook re-`set`s it on every file-touching tool
// call, and work_set is documented as "re-call periodically". So a claim that has not been refreshed in this
// long is almost certainly a GHOST: its session died and the lease is just running out the clock.
//
// WHY FLAG RATHER THAN HIDE. A ghost's harm is that it BLOCKS: a claim saying "do NOT start any concurrent
// call/AEC test until cleared" (ttl 3600s) outlived the session that published it, a dispatched job correctly
// refused to start, and the owner confirmed nothing was running. Dropping stale claims outright would fix the
// blocking and lose the information; leaving them unmarked keeps the blocking. Marking them does both — the
// reader can see "last refreshed 47m ago" and judge, which is exactly what nobody could do.
// 10 minutes: a session actually working refreshes within seconds of each edit, so this is generous, while
// still being far shorter than the 30-minute default and 8-hour maximum lease.
// ponytail: one flat threshold, env-overridable because it is a heuristic about human/agent rhythm, not a
// constant of the system — the one place a tuning knob genuinely earns its keep.
const STALE_AFTER_MS = Math.max(60_000, Number(process.env.CAPTAIN_MEMO_WORKNOTE_STALE_MS ?? 600_000));

function keyFor(sessionId: string): string { return WORKNOTE_PREFIX + sessionId; }
function isLive(n: WorkNote, now: number): boolean {
  return typeof n.ts === 'number' && typeof n.ttl_s === 'number' && now < n.ts + n.ttl_s * 1000;
}

/** Seconds since this claim was last refreshed (its heartbeat age). */
export function claimAgeS(n: WorkNote, now: number): number {
  return Math.max(0, Math.round((now - (typeof n.ts === 'number' ? n.ts : now)) / 1000));
}

/** Has this claim gone quiet past the ceiling? Live by TTL, but no longer evidence of anything running. */
export function isStale(n: WorkNote, now: number): boolean {
  return typeof n.ts === 'number' && now - n.ts > STALE_AFTER_MS;
}

/** Attach the read-time staleness view (`stale`, `age_s`) to each claim. Returns COPIES — the stored notes are
 *  untouched, so nothing is ever persisted with a computed field on it. Apply at every seam a caller reads
 *  claims from, so "is this still real?" is answerable without doing the arithmetic yourself. */
export function decorateStaleness(notes: WorkNote[], now: number): WorkNote[] {
  return notes.map((n) => ({ ...n, age_s: claimAgeS(n, now), ...(isStale(n, now) ? { stale: true } : {}) }));
}

/** A decorated note's `stale`/`age_s`, for the builders below that copy a fixed field list off a peer's note.
 *  Without it every overlap and holder row dropped them (even /worknote/active's contention rows), and a dead
 *  session's ghost claim warned as live. */
function heartbeatOf(n: WorkNote): { stale?: boolean; age_s?: number } {
  return { ...(n.stale ? { stale: true } : {}), ...(typeof n.age_s === 'number' ? { age_s: n.age_s } : {}) };
}

export interface SetWorkNoteInput {
  agent?: string; session_id: string; what?: string; files?: string[]; topics?: string[]; ttl_s?: number;
  meaningful?: boolean;   // persisted onto the note (see WorkNote.meaningful); the route computes it
  declared?: boolean;     // persisted onto the note (see WorkNote.declared); the route computes it
  declared_until?: number;   // persisted (see WorkNote.declared_until); the route computes it
  // Handler-only routing hint (consumed by the /worknote/set HTTP route, NOT persisted on the note): when set,
  // the route replaces a generic `what` with the session's latest observation title before storing. The pure
  // setWorkNote ignores it.
  enrich_from_observations?: boolean;
  // Shared-repo stamp (see resolveRepoClaim), resolved by the /worknote/set route BEFORE calling setWorkNote —
  // setWorkNote stays pure (no git I/O) and just copies these through onto the note.
  repo_root?: string; branch?: string; is_dirty?: boolean;
}

export const MAX_TOPICS = 5;
const MAX_TOPIC_CHARS = 40;

/** Topics as stored: lowercase, non-alphanumerics collapsed to '-', trimmed of dashes, deduped, ≤ MAX_TOPICS of
 *  ≤ MAX_TOPIC_CHARS. "Fleet Keys" and "fleet-keys" are the same topic; junk (non-strings, empties) is dropped. */
export function normalizeTopics(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const t = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_TOPIC_CHARS).replace(/-+$/, '');
    if (!t || out.includes(t)) continue;
    out.push(t);
    if (out.length >= MAX_TOPICS) break;
  }
  return out;
}

/** Publish/refresh a session's claim (a heartbeat re-`set`s it). Returns the stored note. Validated + capped. */
export function setWorkNote(kv: WorkNoteKv, input: SetWorkNoteInput, now: number): WorkNote {
  const note: WorkNote = {
    agent: String(input.agent ?? 'unknown').slice(0, 32) || 'unknown',
    session_id: String(input.session_id).slice(0, 64),
    what: String(input.what ?? '').slice(0, 500),
    files: Array.isArray(input.files) ? input.files.slice(0, MAX_FILES).map((f) => String(f).slice(0, 256)) : [],
    ts: now,
    ttl_s: leaseSeconds(input.ttl_s),
  };
  if (input.meaningful === true) note.meaningful = true;   // only store when true (keeps notes lean + back-compat)
  if (input.declared === true) note.declared = true;
  if (note.declared && typeof input.declared_until === 'number') note.declared_until = input.declared_until;
  const topics = normalizeTopics(input.topics);
  if (topics.length > 0) note.topics = topics;
  if (typeof input.repo_root === 'string' && input.repo_root) note.repo_root = input.repo_root.slice(0, 512);
  if (typeof input.branch === 'string' && input.branch) note.branch = input.branch.slice(0, 256);
  if (typeof input.is_dirty === 'boolean') note.is_dirty = input.is_dirty;
  // Keep the stored value VALID JSON within the byte ceiling: a blind slice() would truncate mid-string and the
  // note would be silently lost (JSON.parse fails → reaped on read). Instead shed files (the only unbounded field
  // — up to MAX_FILES×256) until it fits; the minimal note (no files) is always well under the ceiling.
  while (note.files.length > 0 && JSON.stringify(note).length > MAX_NOTE_BYTES) note.files.pop();
  kv.setKv(keyFor(note.session_id), JSON.stringify(note));
  return note;
}

/** An auto-claim (the PreToolUse hook: files only, a generic `what`) keeps what this session DECLARED with work_set:
 *  its topics and its `what`. Before, the next edit replaced the whole note, so the board went back to "untitled work"
 *  right after the session said what it was doing. Returns whether the declaration was kept (the route then skips the
 *  observation enrichment). An explicit work_set replaces all. */
export function inheritDeclaredIntent(kv: WorkNoteKv, input: SetWorkNoteInput, now: number): boolean {
  let prev: WorkNote | null = null;
  try { prev = JSON.parse(kv.getKv(keyFor(String(input.session_id).slice(0, 64))) ?? 'null') as WorkNote | null; } catch { return false; }
  // The declaration lives for the work_set's own lease, not for as long as the session keeps editing: the hook's
  // heartbeat refreshes ts on every edit, so a session that moved on would otherwise keep its old intent forever.
  if (!prev || !isLive(prev, now) || !prev.declared || !(typeof prev.declared_until === 'number' && now < prev.declared_until)) return false;
  if (normalizeTopics(input.topics).length === 0 && prev.topics?.length) input.topics = prev.topics;
  input.what = prev.what;
  input.declared = true;
  input.declared_until = prev.declared_until;
  return true;
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

/** Drop a session's own claim (task done). Returns whether a claim actually existed and was removed.
 *
 *  IT USED TO RETURN void, and the route reported `{ok:true}` either way — so a clear that removed nothing (a
 *  session_id this captain holds no claim for) said it had worked, and the caller walked away believing the
 *  blocker was gone. A false success is worse than a refusal. The caller now gets the truth and can act on it. */
export function clearWorkNote(kv: WorkNoteKv, sessionId: string): boolean {
  const key = keyFor(String(sessionId));
  const existed = kv.getKv(key) !== null;
  kv.deleteKv(key);   // unconditional: a malformed/expired value must still be swept
  return existed;
}

/** Active claims (excluding `excludeSession`) whose file globs intersect `mineFiles`. */
export function overlapsAgainst(mineFiles: string[], others: WorkNote[], excludeSession: string): OverlapHit[] {
  const hits: OverlapHit[] = [];
  for (const o of others) {
    if (o.session_id === excludeSession) continue;
    const overlapping = globsOverlap(mineFiles ?? [], o.files ?? []);
    if (overlapping.length > 0) {
      hits.push({ agent: o.agent, session_id: o.session_id, ...(o.captain ? { captain: o.captain } : {}), ...(o.repo_root ? { repo_root: o.repo_root } : {}), what: o.what, files: o.files, overlapping, kind: 'files', ...heartbeatOf(o) });
    }
  }
  return hits;
}

/** Live claims (not mine) that share at least one TOPIC tag with `mineTopics`: kind 'topics', `overlapping` = the
 *  shared tags. Exact tags only — the semantic pass covers the fuzzy half. [] when I claim no topics. */
export function topicOverlapsAgainst(mineTopics: string[], others: WorkNote[], excludeSession: string): OverlapHit[] {
  const mine = new Set(normalizeTopics(mineTopics));
  if (mine.size === 0) return [];
  const hits: OverlapHit[] = [];
  for (const o of others) {
    if (o.session_id === excludeSession) continue;
    const shared = (o.topics ?? []).filter((t) => mine.has(t));
    if (shared.length > 0) {
      hits.push({ agent: o.agent, session_id: o.session_id, ...(o.captain ? { captain: o.captain } : {}), what: o.what, files: o.files, overlapping: shared, kind: 'topics', ...heartbeatOf(o) });
    }
  }
  return hits;
}

export interface TopicContention { topic: string; holders: { agent: string; session_id: string; captain?: string; what: string; stale?: boolean; age_s?: number }[] }

/** Every topic two or more live sessions claim at once, fleet-wide, with the holders — the board's "two people on
 *  the installer" row. Sorted by most holders, then topic. */
export function groupTopicContention(notes: WorkNote[]): TopicContention[] {
  const byTopic = new Map<string, TopicContention['holders']>();
  for (const n of notes) {
    for (const t of n.topics ?? []) {
      const list = byTopic.get(t) ?? [];
      if (!list.some((h) => h.session_id === n.session_id)) list.push({ agent: n.agent, session_id: n.session_id, ...(n.captain ? { captain: n.captain } : {}), what: n.what, ...heartbeatOf(n) });
      byTopic.set(t, list);
    }
  }
  return [...byTopic.entries()].filter(([, h]) => h.length >= 2).map(([topic, holders]) => ({ topic, holders }))
    .sort((a, b) => b.holders.length - a.holders.length || a.topic.localeCompare(b.topic));
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
        what: o.note.what, files: o.note.files, overlapping: [], kind: 'semantic', similarity: sim, ...heartbeatOf(o.note),
      });
    }
  }
  return hits.sort((x, y) => y.similarity - x.similarity);
}

/** The live subset of an IN-MEMORY note array (the fleet cache holds notes pushed from the fleet thread,
 *  not the kv; each still carries its own lease). Pure — no reaping side effect. */
export function filterActive(notes: WorkNote[], now: number): WorkNote[] {
  return (notes ?? []).filter((n) => n && typeof n === 'object' && typeof n.session_id === 'string' && isLive(n, now));
}

/** Store the fleet's current notes as ONE timestamped snapshot (the fleet thread pushes this each poll).
 *  Input is sanitized + capped here. Returns the count stored. Replacing the whole snapshot each push is the
 *  reap: a sibling's dropped claim simply isn't in the next snapshot. */
export function setFleetSnapshot(kv: WorkNoteKv, input: unknown, now: number): number {
  const notes = sanitizeFleetNotes(input, now);
  kv.setKv(FLEET_SNAPSHOT_KEY, JSON.stringify({ at: now, notes }));
  return notes.length;
}

/** The live fleet notes (siblings' active claims), or [] if the snapshot is missing, malformed, or STALE (no
 *  push within FLEET_SNAPSHOT_TTL_MS ⇒ the fleet link is down, so we surface no fleet claims at all). */
export function listFleetActive(kv: WorkNoteKv, now: number): WorkNote[] {
  const raw = kv.getKv(FLEET_SNAPSHOT_KEY);
  if (!raw) return [];
  try {
    const snap = JSON.parse(raw) as { at?: unknown; notes?: unknown };
    if (typeof snap.at !== 'number' || now - snap.at >= FLEET_SNAPSHOT_TTL_MS) return [];
    return filterActive(Array.isArray(snap.notes) ? (snap.notes as WorkNote[]) : [], now);
  } catch { return []; }
}

export interface RepoContention {
  repo_root: string;
  holders: Array<{ session_id: string; agent?: string; branch?: string; is_dirty?: boolean; ts: number; stale?: boolean; age_s?: number }>;
  branches: string[];
}

/** Live claims (excluding my session) that share my working-tree root — the shared-checkout collision the
 *  file-glob pass misses (peers claim different files but mutate the same HEAD/branch/dirty tree). */
export function repoOverlapsAgainst(myRepoRoot: string | undefined, others: WorkNote[], excludeSession: string): OverlapHit[] {
  if (!myRepoRoot) return [];
  const hits: OverlapHit[] = [];
  for (const o of others) {
    if (o.session_id === excludeSession || o.repo_root !== myRepoRoot) continue;
    hits.push({ agent: o.agent, session_id: o.session_id, ...(o.captain ? { captain: o.captain } : {}), what: o.what, files: o.files, overlapping: [myRepoRoot], kind: 'repo', ...heartbeatOf(o) });
  }
  return hits;
}

/** Group live repo-stamped claims by working-tree root; return only roots held by >=2 DISTINCT sessions. */
export function groupRepoContention(notes: WorkNote[]): RepoContention[] {
  const byRoot = new Map<string, WorkNote[]>();
  for (const n of notes) {
    if (!n.repo_root) continue;
    const bucket = byRoot.get(n.repo_root);
    if (bucket) bucket.push(n);
    else byRoot.set(n.repo_root, [n]);
  }
  const out: RepoContention[] = [];
  for (const [repo_root, ns] of byRoot) {
    const sessions = new Set(ns.map((n) => n.session_id));
    if (sessions.size < 2) continue;
    out.push({
      repo_root,
      holders: ns.map((n) => ({
        session_id: n.session_id, agent: n.agent, ts: n.ts,
        ...(n.branch ? { branch: n.branch } : {}),
        ...(n.is_dirty !== undefined ? { is_dirty: n.is_dirty } : {}),
        ...heartbeatOf(n),
      })),
      branches: [...new Set(ns.map((n) => n.branch).filter((b): b is string => !!b))],
    });
  }
  return out;
}

/** Holders (session/agent/branch/dirty/ts) of a specific working-tree root among live claims. */
export function repoActiveHolders(notes: WorkNote[], repoRoot: string): RepoContention['holders'] {
  return notes.filter((n) => n.repo_root === repoRoot).map((n) => ({
    session_id: n.session_id, agent: n.agent, ts: n.ts,
    ...(n.branch ? { branch: n.branch } : {}),
    ...(n.is_dirty !== undefined ? { is_dirty: n.is_dirty } : {}),
    ...heartbeatOf(n),
  }));
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
      ...(normalizeTopics(r.topics).length ? { topics: normalizeTopics(r.topics) } : {}),
      ...(typeof r.repo_root === 'string' && r.repo_root ? { repo_root: r.repo_root.slice(0, 512) } : {}),
      ...(typeof r.branch === 'string' && r.branch ? { branch: r.branch.slice(0, 256) } : {}),
      ...(r.is_dirty === true ? { is_dirty: true } : {}),
    };
    if (isLive(note, now)) out.push(note);
  }
  return out;
}
