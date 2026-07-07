import { test, expect } from 'bun:test';
import {
  setWorkNote, listLocalActive, clearWorkNote, overlapsAgainst, WORKNOTE_PREFIX,
  setFleetSnapshot, listFleetActive, filterActive, sanitizeFleetNotes, FLEET_SNAPSHOT_KEY,
  cosineSimilarity, semanticOverlaps, repoOverlapsAgainst, groupRepoContention,
  type WorkNoteKv, type WorkNote, type ClaimVec,
} from '../../src/worker/work-notes.ts';

// In-memory kv satisfying WorkNoteKv.
function makeKv(): WorkNoteKv & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getKv: (k) => (map.has(k) ? map.get(k)! : null),
    setKv: (k, v) => { map.set(k, v); },
    listKvPrefix: (p) => [...map.entries()].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })),
    deleteKv: (k) => { map.delete(k); },
  };
}
const NOW = 1_700_000_000_000;

test('setWorkNote stores under worknote:<session> and caps/validates fields', () => {
  const kv = makeKv();
  const note = setWorkNote(kv, { agent: 'codex', session_id: 's1', what: 'refactor billing', files: ['billing/**'] }, NOW);
  expect(note.agent).toBe('codex');
  expect(note.ttl_s).toBe(1800);   // default 30 min
  expect(kv.map.has(WORKNOTE_PREFIX + 's1')).toBe(true);
  expect(listLocalActive(kv, NOW).length).toBe(1);
});

test('an oversized note sheds files to stay VALID JSON within the byte cap (never silently lost)', () => {
  const kv = makeKv();
  // 64 files x ~256 chars >> MAX_NOTE_BYTES(4000): a blind slice would corrupt the JSON and lose the note.
  const stored = setWorkNote(kv, { session_id: 'big', what: 'x', files: Array(64).fill('a'.repeat(250)) }, NOW);
  expect(stored.files.length).toBeLessThan(64);                 // some files shed to fit
  const active = listLocalActive(kv, NOW);                      // round-trips: JSON.parse must NOT throw
  expect(active.length).toBe(1);
  expect(active[0]!.session_id).toBe('big');
});

test('ttl_s is clamped to [60, 8h]', () => {
  const kv = makeKv();
  expect(setWorkNote(kv, { session_id: 'a', ttl_s: 5 }, NOW).ttl_s).toBe(60);
  expect(setWorkNote(kv, { session_id: 'b', ttl_s: 999999 }, NOW).ttl_s).toBe(8 * 3600);
});

test('a heartbeat (re-set) refreshes the lease ts', () => {
  const kv = makeKv();
  setWorkNote(kv, { session_id: 's1', what: 'x', ttl_s: 60 }, NOW);
  const later = NOW + 50_000;   // 50s in, still live
  const refreshed = setWorkNote(kv, { session_id: 's1', what: 'x', ttl_s: 60 }, later);
  expect(refreshed.ts).toBe(later);
  expect(listLocalActive(kv, later + 50_000).length).toBe(1);   // would have expired without the refresh
});

test('an EXPIRED note is filtered out AND lazily reaped on read', () => {
  const kv = makeKv();
  setWorkNote(kv, { session_id: 's1', what: 'x', ttl_s: 60 }, NOW);
  const after = NOW + 61_000;   // 61s — past the 60s lease
  expect(listLocalActive(kv, after)).toEqual([]);
  expect(kv.map.has(WORKNOTE_PREFIX + 's1')).toBe(false);   // reaped, no ghost claim
});

test('a malformed kv value is dropped (never crashes the board)', () => {
  const kv = makeKv();
  kv.setKv(WORKNOTE_PREFIX + 'bad', 'not json{');
  expect(listLocalActive(kv, NOW)).toEqual([]);
  expect(kv.map.has(WORKNOTE_PREFIX + 'bad')).toBe(false);
});

test('clearWorkNote removes only the session’s own claim', () => {
  const kv = makeKv();
  setWorkNote(kv, { session_id: 's1', what: 'a' }, NOW);
  setWorkNote(kv, { session_id: 's2', what: 'b' }, NOW);
  clearWorkNote(kv, 's1');
  const active = listLocalActive(kv, NOW);
  expect(active.length).toBe(1);
  expect(active[0]!.session_id).toBe('s2');
});

test('overlapsAgainst flags an overlapping OTHER session and excludes my own', () => {
  const kv = makeKv();
  setWorkNote(kv, { agent: 'claude', session_id: 'mine', what: 'auth', files: ['src/auth/**'] }, NOW);
  setWorkNote(kv, { agent: 'codex', session_id: 'other', what: 'auth too', files: ['src/auth/login.ts'] }, NOW);
  setWorkNote(kv, { agent: 'gemini', session_id: 'unrelated', what: 'docs', files: ['docs/**'] }, NOW);
  const hits = overlapsAgainst(['src/auth/**'], listLocalActive(kv, NOW), 'mine');
  expect(hits.length).toBe(1);
  expect(hits[0]!.agent).toBe('codex');
  expect(hits[0]!.session_id).toBe('other');
  expect(hits[0]!.overlapping).toEqual(['src/auth/**']);
});

test('overlapsAgainst returns nothing when files are disjoint', () => {
  const kv = makeKv();
  setWorkNote(kv, { session_id: 'other', files: ['billing/**'] }, NOW);
  expect(overlapsAgainst(['auth/**'], listLocalActive(kv, NOW), 'mine')).toEqual([]);
});

// ── Fleet propagation (step 2) ───────────────────────────────────────────────
const fleetNote = (over: Partial<WorkNote> = {}): WorkNote => ({
  agent: 'codex', session_id: 'sib1', what: 'auth', files: ['src/auth/**'],
  ts: NOW, ttl_s: 1800, captain: 'erp-main', ...over,
});

test('setFleetSnapshot stores ONE key; listFleetActive returns the live fleet notes', () => {
  const kv = makeKv();
  const n = setFleetSnapshot(kv, [fleetNote()], NOW);
  expect(n).toBe(1);
  expect(kv.map.has(FLEET_SNAPSHOT_KEY)).toBe(true);
  const active = listFleetActive(kv, NOW);
  expect(active.length).toBe(1);
  expect(active[0]!.captain).toBe('erp-main');
});

test('listFleetActive ignores a STALE snapshot (no push within 30s ⇒ no phantom fleet claims)', () => {
  const kv = makeKv();
  setFleetSnapshot(kv, [fleetNote()], NOW);
  expect(listFleetActive(kv, NOW + 5_000).length).toBe(1);    // fresh
  expect(listFleetActive(kv, NOW + 31_000)).toEqual([]);      // snapshot itself went stale
});

test('setFleetSnapshot sanitizes: drops malformed + expired, caps fields, preserves captain', () => {
  const kv = makeKv();
  setFleetSnapshot(kv, [
    fleetNote({ session_id: 'good' }),
    { not: 'a note' },                                         // malformed → dropped
    fleetNote({ session_id: 'expired', ts: NOW - 10_000, ttl_s: 1 }),   // already expired → dropped
    { session_id: 'no-lease', files: ['x'] },                 // missing ts/ttl_s → dropped
  ], NOW);
  const active = listFleetActive(kv, NOW);
  expect(active.map((n) => n.session_id).sort()).toEqual(['good']);
});

test('the fleet snapshot is invisible to listLocalActive (separate key space)', () => {
  const kv = makeKv();
  setWorkNote(kv, { session_id: 'localOnly', files: ['a/**'] }, NOW);
  setFleetSnapshot(kv, [fleetNote()], NOW);
  const local = listLocalActive(kv, NOW);
  expect(local.length).toBe(1);
  expect(local[0]!.session_id).toBe('localOnly');             // the fleetnotes:* key is NOT a worknote:* key
});

test('filterActive keeps only live notes from an in-memory array', () => {
  const live = fleetNote({ session_id: 'a' });
  const dead = fleetNote({ session_id: 'b', ts: NOW - 10_000, ttl_s: 1 });
  expect(filterActive([live, dead], NOW).map((n) => n.session_id)).toEqual(['a']);
});

test('sanitizeFleetNotes length-caps files and clamps fields', () => {
  const huge = sanitizeFleetNotes([{ session_id: 's', ts: NOW, ttl_s: 999999, files: Array(200).fill('f/**'), agent: 'x'.repeat(99) }], NOW);
  expect(huge.length).toBe(1);
  expect(huge[0]!.files.length).toBe(64);          // MAX_FILES
  expect(huge[0]!.ttl_s).toBe(8 * 3600);           // clamped to the 8h ceiling
  expect(huge[0]!.agent.length).toBe(32);          // capped
});

test('overlap merge: a local session is warned about a FLEET claim on the same files', () => {
  const kv = makeKv();
  setWorkNote(kv, { agent: 'claude', session_id: 'mine', what: 'auth', files: ['src/auth/**'] }, NOW);
  setFleetSnapshot(kv, [fleetNote({ session_id: 'sib', files: ['src/auth/login.ts'], captain: 'win-desktop' })], NOW);
  const merged = [...listLocalActive(kv, NOW), ...listFleetActive(kv, NOW)];
  const hits = overlapsAgainst(['src/auth/**'], merged, 'mine');
  expect(hits.length).toBe(1);
  expect(hits[0]!.captain).toBe('win-desktop');    // the overlap names the sibling captain
  expect(hits[0]!.session_id).toBe('sib');
});

// ── Semantic overlap (intent-by-meaning, not just files) ─────────────────────
function claim(p: Partial<WorkNote> & { session_id: string }, vec: number[]): ClaimVec {
  return { note: { agent: 'claude', what: 'x', files: [], ts: NOW, ttl_s: 1800, ...p }, vec };
}

test('cosineSimilarity: identical=1, orthogonal=0, opposite=-1, magnitude-invariant, zero-safe', () => {
  expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
  expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 6);
  expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1, 6);
  expect(cosineSimilarity([3, 0], [6, 0])).toBeCloseTo(1, 6);     // normalised, not raw dot
  expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);               // zero vector ⇒ 0, never NaN
  expect(cosineSimilarity([1, 0], [1])).toBe(0);                  // mismatched dims ⇒ 0, never throws
});

test('semanticOverlaps flags a meaning-similar claim above threshold and tags it kind=semantic', () => {
  const mine = { session_id: 'me', vec: [1, 0, 0] };
  const others = [
    claim({ session_id: 'sim', what: 'same task other files', files: ['a.ts'], agent: 'codex' }, [0.99, 0.14, 0]),
    claim({ session_id: 'diff', what: 'unrelated', files: ['b.ts'] }, [0, 1, 0]),
    claim({ session_id: 'me', what: 'self', files: ['c.ts'] }, [1, 0, 0]),   // same session ⇒ never self-overlap
  ];
  const hits = semanticOverlaps(mine, others, 0.82);
  expect(hits.length).toBe(1);
  expect(hits[0]!.session_id).toBe('sim');
  expect(hits[0]!.kind).toBe('semantic');
  expect(hits[0]!.similarity).toBeCloseTo(0.99, 2);
  expect(hits[0]!.overlapping).toEqual([]);        // semantic hits claim no shared files
  expect(hits[0]!.agent).toBe('codex');
});

test('semanticOverlaps skips sessions already reported as file overlaps (no double-warn)', () => {
  const mine = { session_id: 'me', vec: [1, 0, 0] };
  const others = [claim({ session_id: 'sim', files: ['a.ts'] }, [0.99, 0.14, 0])];
  expect(semanticOverlaps(mine, others, 0.82, new Set(['sim'])).length).toBe(0);
});

test('semanticOverlaps ignores empty/missing vectors and an empty mine vector', () => {
  const others = [claim({ session_id: 'sim' }, [])];                     // other has no vector
  expect(semanticOverlaps({ session_id: 'me', vec: [1, 0] }, others, 0.5).length).toBe(0);
  expect(semanticOverlaps({ session_id: 'me', vec: [] }, [claim({ session_id: 's' }, [1, 0])], 0.5).length).toBe(0);
});

// ── meaningful flag: persisted + survives the fleet snapshot (drives the semantic intent gate) ────────────────
test('setWorkNote persists meaningful only when true (lean note, back-compat default)', () => {
  const kv = makeKv();
  const m = setWorkNote(kv, { session_id: 'm', what: 'real intent', meaningful: true }, NOW);
  expect(m.meaningful).toBe(true);
  const g = setWorkNote(kv, { session_id: 'g', what: 'editing 3 files', meaningful: false }, NOW);
  expect('meaningful' in g).toBe(false);                          // absent, not false — kept off the wire
  expect(JSON.stringify(g).includes('meaningful')).toBe(false);
});

test('sanitizeFleetNotes preserves a sibling meaningful flag (so cross-captain intent matching works)', () => {
  const ok = sanitizeFleetNotes([{ session_id: 's', ts: NOW, ttl_s: 1800, what: 'refactor billing', meaningful: true, agent: 'codex' }], NOW);
  expect(ok[0]!.meaningful).toBe(true);
  const generic = sanitizeFleetNotes([{ session_id: 's2', ts: NOW, ttl_s: 1800, what: 'editing 2 files', agent: 'codex' }], NOW);
  expect('meaningful' in generic[0]!).toBe(false);                // absent ⇒ file-only for that sibling
});

// ── Shared-repo stamp (repo_root/branch/is_dirty) ─────────────────────────────
test('setWorkNote stores optional repo fields when provided', () => {
  const kv = makeKv();
  const n = setWorkNote(kv, { session_id: 's1', files: ['/proj/erp/a.php'], repo_root: '/proj/erp', branch: 'master', is_dirty: true }, 1000);
  expect(n.repo_root).toBe('/proj/erp'); expect(n.branch).toBe('master'); expect(n.is_dirty).toBe(true);
});
test('setWorkNote omits repo fields when absent (scratchpad claim)', () => {
  const kv = makeKv();
  const n = setWorkNote(kv, { session_id: 's2', files: ['/tmp/x/scratchpad/a.ts'] }, 1000);
  expect(n.repo_root).toBeUndefined();
});

// ── repoOverlapsAgainst / groupRepoContention (same-repo-root collision) ──────
const repoNote = (session_id: string, repo_root?: string, branch?: string): WorkNote => ({
  agent: 'claude', session_id, what: 'w', files: [], ts: 1, ttl_s: 60,
  ...(repo_root ? { repo_root } : {}), ...(branch ? { branch } : {}),
});

test('repoOverlapsAgainst fires on same repo_root, excludes self + no-repo', () => {
  const others = [repoNote('a', '/proj/erp', 'master'), repoNote('b', '/proj/other'), repoNote('c')];
  const hits = repoOverlapsAgainst('/proj/erp', others, 'me');
  expect(hits.map((h) => h.session_id)).toEqual(['a']);
  expect(hits[0]!.kind).toBe('repo');
});

test('groupRepoContention returns only roots with >=2 distinct sessions', () => {
  const notes = [repoNote('a', '/proj/erp', 'master'), repoNote('b', '/proj/erp', 'feat'), repoNote('c', '/proj/solo', 'master')];
  const g = groupRepoContention(notes);
  expect(g.length).toBe(1);
  expect(g[0]!.repo_root).toBe('/proj/erp');
  expect(g[0]!.holders.map((h) => h.session_id).sort()).toEqual(['a', 'b']);
  expect(g[0]!.branches.sort()).toEqual(['feat', 'master']);
});
