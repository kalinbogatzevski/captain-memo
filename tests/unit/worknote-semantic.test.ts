import { test, expect, beforeEach } from 'bun:test';
import {
  embedAndCache, getWorknoteVec, semanticOverlapPass, hasIntent, __clearWorknoteVecCache,
} from '../../src/worker/worknote-semantic.ts';
import type { WorkNote } from '../../src/worker/work-notes.ts';

const NOW = 1_700_000_000_000;
// Default to meaningful:true — these matching tests assume a claim with real declared intent. The gate tests
// below override it to false to prove generic placeholders never enter the pass.
function note(p: Omit<Partial<WorkNote>, 'meaningful'> & { session_id: string; what: string; meaningful?: boolean | undefined }): WorkNote {
  // `meaningful` may be overridden to undefined (an unset flag — the real state of notes captured before the
  // flag existed) to exercise the intent gate; that's out of WorkNote's nominal `boolean`, hence the cast.
  return { agent: 'claude', files: [], ts: NOW, ttl_s: 1800, meaningful: true, ...p } as WorkNote;
}
// Deterministic fake embedder: each known phrase maps to a fixed unit-ish vector.
const VEC: Record<string, number[]> = {
  'refactor the billing module': [1, 0, 0],
  'rework billing pro-ration':   [0.98, 0.2, 0],   // ~same area, cosine ≈ 0.98 vs the first
  'fix the map tile loader':     [0, 1, 0],         // unrelated
};
const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => VEC[t.trim()] ?? [0, 0, 1]);

beforeEach(() => __clearWorknoteVecCache());

test('embedAndCache populates the cache; getWorknoteVec returns it (trim-insensitive)', async () => {
  expect(getWorknoteVec('refactor the billing module')).toBeUndefined();
  await embedAndCache(['refactor the billing module'], fakeEmbed);
  expect(getWorknoteVec('  refactor the billing module  ')).toEqual([1, 0, 0]);
});

test('semanticOverlapPass flags a meaning-similar claim once both are cached', async () => {
  const mine = note({ session_id: 'me', what: 'refactor the billing module' });
  const them = note({ session_id: 'them', what: 'rework billing pro-ration', agent: 'codex' });
  await embedAndCache([mine.what, them.what], fakeEmbed);
  const hits = semanticOverlapPass(mine, [them], new Set());
  expect(hits.length).toBe(1);
  expect(hits[0]!.session_id).toBe('them');
  expect(hits[0]!.kind).toBe('semantic');
});

test('semanticOverlapPass returns [] until mine is embedded (eventually-consistent, never blocks)', () => {
  const mine = note({ session_id: 'me', what: 'refactor the billing module' });
  const them = note({ session_id: 'them', what: 'rework billing pro-ration' });
  expect(semanticOverlapPass(mine, [them], new Set())).toEqual([]);   // nothing cached yet ⇒ no hit this call
});

test('semanticOverlapPass does not flag an unrelated claim', async () => {
  const mine = note({ session_id: 'me', what: 'refactor the billing module' });
  const them = note({ session_id: 'them', what: 'fix the map tile loader' });
  await embedAndCache([mine.what, them.what], fakeEmbed);
  expect(semanticOverlapPass(mine, [them], new Set())).toEqual([]);
});

// ── Intent gate: generic placeholders (meaningful:false) must NEVER enter the semantic pass ───────────────────
test('hasIntent: true only for a meaningful claim with non-empty what', () => {
  expect(hasIntent(note({ session_id: 'a', what: 'real intent' }))).toBe(true);
  expect(hasIntent(note({ session_id: 'a', what: '   ', meaningful: true }))).toBe(false);   // empty what
  expect(hasIntent(note({ session_id: 'a', what: 'editing 3 files', meaningful: false }))).toBe(false);
  expect(hasIntent(note({ session_id: 'a', what: 'no flag' , meaningful: undefined }))).toBe(false);
});

test('semanticOverlapPass returns [] when MINE is not meaningful, even if vectors match (no false ~1.0)', async () => {
  // Two generic placeholders are byte-identical → cosine 1.0. Without the gate this would false-fire.
  const mine = note({ session_id: 'me', what: 'editing 3 file(s) in repoX', meaningful: false });
  const them = note({ session_id: 'them', what: 'editing 3 file(s) in repoX', meaningful: false });
  await embedAndCache([mine.what], async (t) => t.map(() => [1, 0, 0]));   // both share the SAME cache key → vec exists
  expect(semanticOverlapPass(mine, [them], new Set())).toEqual([]);
});

test('semanticOverlapPass excludes a non-meaningful PEER even when its vector matches', async () => {
  const mine = note({ session_id: 'me', what: 'refactor the billing module' });            // meaningful
  const them = note({ session_id: 'them', what: 'editing 2 file(s) in x', meaningful: false }); // generic peer
  await embedAndCache([mine.what], fakeEmbed);
  await embedAndCache([them.what], async (t) => t.map(() => [1, 0, 0]));   // force a high-similarity vector
  expect(semanticOverlapPass(mine, [them], new Set())).toEqual([]);        // peer filtered out by hasIntent
});

test('embedAndCache is fail-open: a throwing embedder never rejects and leaves the cache cold (logged once)', async () => {
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(String(a[0])); };
  try {
    await embedAndCache(['some intent'], async () => { throw new Error('embedder 401'); });   // must NOT throw
    await embedAndCache(['other intent'], async () => { throw new Error('embedder 401'); });   // 2nd outage call
  } finally { console.warn = orig; }
  expect(getWorknoteVec('some intent')).toBeUndefined();                  // cold — degrades to file-only
  expect(warned.filter((w) => w.includes('warm embed failed')).length).toBe(1);   // ONE line per outage, not spam
});
