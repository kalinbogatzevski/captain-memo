// tests/integration/semantic-fold.test.ts
//
// The semantic finder feeding the REAL dedup slice. Proves the composition rather than the
// pieces: findSemanticGroups discovers by cosine, runQmDedupSlice applies every guard it
// applies for title-found groups, and the store archives into the survivor reversibly.
//
// The point of the feature: these titles share almost no words, so the title-gated path could
// never have found them. Measured on a 124k corpus, that path found ZERO semantic pairs at any
// threshold.

import { test, expect, describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ObservationsStore } from '../../src/worker/observations-store.ts';
import { findSemanticGroups } from '../../src/worker/semantic-candidates.ts';
import { runQmDedupSlice } from '../../src/worker/quartermaster.ts';
import { DEFAULT_QM_CONFIG } from '../../src/worker/qm.ts';

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'cm-semfold-'));
  return { s: new ObservationsStore(join(dir, 'o.db')), dir };
}
const add = (s: ObservationsStore, title: string, session: string, at: number) =>
  s.insert({
    session_id: session, project_id: 'p', prompt_number: 1, type: 'discovery', title,
    narrative: '', facts: [], concepts: [], files_read: [], files_modified: [],
    created_at_epoch: at, branch: null, origin_agent: null, work_tokens: null,
  } as never);

const at = (deg: number) => Float32Array.from([
  Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0,
]);

/** Run the real slice over semantically-found candidates. */
async function runSemantic(
  s: ObservationsStore, vecs: Record<number, Float32Array>, limit = 500,
) {
  return runQmDedupSlice({
    candidates: () => findSemanticGroups({
      rows: s.sameSessionCandidateRows(limit),
      representativeVector: (id) => vecs[id] ?? null,
      cosineThreshold: DEFAULT_QM_CONFIG.semanticCosineThreshold,
      maxGroups: DEFAULT_QM_CONFIG.semanticMaxGroups,
    }),
    representativeVector: (id) => vecs[id] ?? null,
    memberIsProtected: (id) => s.isProtected(id),
    mergeGroup: (sur, mem, epoch) => s.mergeDuplicateGroup(sur, mem, epoch, 'semantic'),
    shouldAbort: () => false,
    cfg: { ...DEFAULT_QM_CONFIG, dedupCosineThreshold: DEFAULT_QM_CONFIG.semanticCosineThreshold },
    now: () => 5000,
    yieldToLoop: () => Promise.resolve(),
  });
}

describe('semantic fold, end to end', () => {
  test('folds a restatement the TITLE path could never have found', async () => {
    const { s, dir } = store();
    // Real pair from the corpus. Shared significant tokens: essentially none.
    const a = add(s, 'TalQ: native Qt/C++ Nextcloud Talk client for constrained environments', 's1', 100);
    const b = add(s, 'Retrieved TalQ discovery from memory', 's1', 140);
    s.bumpRetrieval([a], 'auto'); s.bumpRetrieval([a], 'auto'); s.bumpRetrieval([b], 'auto');

    // The title path finds nothing here — that is the premise of the feature.
    expect(s.findDuplicateGroups(0.5).length).toBe(0);

    const r = await runSemantic(s, { [a]: at(0), [b]: at(4) });   // cos ~0.998
    expect(r.merges).toBe(1);

    const db = s as unknown as { db: { query: (q: string) => { get: (x: number) => unknown } } };
    const rowB = db.db.query('SELECT archived, archived_into_theme_id FROM observations WHERE id = ?').get(b) as
      { archived: number; archived_into_theme_id: number | null };
    expect(rowB.archived).toBe(1);
    expect(rowB.archived_into_theme_id).toBe(a);          // folded INTO the survivor
    const rowA = db.db.query('SELECT archived, from_auto FROM observations WHERE id = ?').get(a) as
      { archived: number; from_auto: number };
    expect(rowA.archived).toBe(0);
    expect(rowA.from_auto).toBe(3);                        // 2 + 1 summed onto the survivor
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('refuses to cross a session boundary, however close the vectors', async () => {
    const { s, dir } = store();
    const a = add(s, 'update-status skill verified and available', 's1', 100);
    const b = add(s, 'update-status skill registered and callable', 's2', 900_000);
    s.bumpRetrieval([a, b], 'auto');

    const r = await runSemantic(s, { [a]: at(0), [b]: at(1) });  // cos ~0.9998
    expect(r.merges).toBe(0);
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('never folds a protected row — the slice gate still applies', async () => {
    const { s, dir } = store();
    const a = add(s, 'first phrasing of one finding', 's1', 100);
    const b = add(s, 'second phrasing of that finding', 's1', 140);
    s.bumpRetrieval([a], 'auto'); s.bumpRetrieval([a], 'auto');
    s.bumpRetrieval([b], 'drill');                        // drilled ⇒ protected

    const r = await runSemantic(s, { [a]: at(0), [b]: at(3) });
    expect(r.merges).toBe(0);
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  // Fail-closed: no vector means no evidence, and no evidence means no fold.
  test('does not fold when a row has no vector', async () => {
    const { s, dir } = store();
    const a = add(s, 'has an embedding', 's1', 100);
    const b = add(s, 'awaiting embedding', 's1', 140);
    s.bumpRetrieval([a, b], 'auto');

    const r = await runSemantic(s, { [a]: at(0) });
    expect(r.merges).toBe(0);
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('a semantic fold is reversible and labelled as its own job', async () => {
    const { s, dir } = store();
    const a = add(s, 'the surviving phrasing', 's1', 100);
    const b = add(s, 'the folded phrasing', 's1', 140);
    s.bumpRetrieval([a], 'auto'); s.bumpRetrieval([a], 'auto'); s.bumpRetrieval([b], 'auto');
    await runSemantic(s, { [a]: at(0), [b]: at(3) });

    const db = s as unknown as { db: { query: (q: string) => { all: (...x: unknown[]) => unknown[] } } };
    const jobs = db.db.query('SELECT job FROM merge_events WHERE undone = 0').all() as Array<{ job: string }>;
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.job).toBe('semantic');               // distinguishable from title-found folds

    s.unmergeDuplicateGroup(a);
    const rowB = db.db.query('SELECT archived FROM observations WHERE id = ?').all(b) as Array<{ archived: number }>;
    expect(rowB[0]!.archived).toBe(0);                    // restored
    s.close(); rmSync(dir, { recursive: true, force: true });
  });
});
