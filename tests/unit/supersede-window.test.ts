import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ObservationsStore } from '../../src/worker/observations-store.ts';

// supersedeCandidateWindow reused surfacedWindowRows: `(from_auto+from_search+from_drill) > 0`, newest
// 500. Two compounding failures on a real corpus —
//   • surfaced-only is 14,302 of 122,665 rows (11.7%), so the 108,349 never-surfaced rows are
//     structurally unreachable. That is backwards for supersession: a stale fact that has never
//     surfaced is precisely the one that ambushes you the day it does.
//   • both rows of a pair must land in the SAME 500-row recency slice, but version chains span months.
// Measured: 294 version pairs exist corpus-wide, the live window contained 0.
//
// Only 2.1% of titles parse a version at all, so a full scan stays cheap (~450 ms on 122k, hourly).
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'cm-sw-'));
  return { s: new ObservationsStore(join(dir, 'o.db')), dir };
}
const add = (s: ObservationsStore, title: string, createdAt: number) =>
  s.insert({
    session_id: 'x', project_id: 'p', prompt_number: 1, type: 'change', title,
    narrative: 'n', facts: [], concepts: [], files_read: [], files_modified: [],
    created_at_epoch: createdAt, branch: null, work_tokens: 1, stored_tokens: 1,
  } as never);

test('finds a version pair even when NEITHER row has ever been surfaced', () => {
  const { s, dir } = store();
  add(s, 'Bump captain-memo version to 0.1.1', 1000);
  add(s, 'Bump captain-memo version to 0.1.4', 2000);
  const out = s.supersedeCandidateWindow(500);
  expect(out.length).toBe(1);
  expect(out[0]!.older.version).toBe('0.1.1');
  expect(out[0]!.newer.version).toBe('0.1.4');
  s.close(); rmSync(dir, { recursive: true, force: true });
});

test('finds a pair whose rows are far apart in time (a chain spanning months)', () => {
  const { s, dir } = store();
  add(s, 'Bump captain-memo version to 0.1.5', 1_000_000);
  for (let i = 0; i < 60; i++) add(s, 'unrelated note ' + i, 1_500_000 + i);
  add(s, 'Bump captain-memo version to 0.27.25', 9_000_000);
  const out = s.supersedeCandidateWindow(10);   // a small window must not hide the pair
  expect(out.length).toBe(1);
  s.close(); rmSync(dir, { recursive: true, force: true });
});

// A calendar-style version parses as semver: 2026.0512.24 reads as 2026.512.24 and dominates a real
// v3.12. Without a creation-order check the machine would mark the NEWER note stale — the one failure
// this whole feature must never produce.
test('refuses a pair whose "older" version was actually written LATER', () => {
  const { s, dir } = store();
  add(s, 'Bump ERP_DEPLOY_VERSION to 2026.0512.24', 5000);   // higher semver, written FIRST
  add(s, 'Bump ERP_DEPLOY_VERSION to 3.12', 9000);           // lower semver, written LATER
  expect(s.supersedeCandidateWindow(500)).toEqual([]);
  s.close(); rmSync(dir, { recursive: true, force: true });
});

test('still emits when version order and creation order agree', () => {
  const { s, dir } = store();
  add(s, 'Bump thing to 1.0.0', 1000);
  add(s, 'Bump thing to 2.0.0', 5000);
  expect(s.supersedeCandidateWindow(500).length).toBe(1);
  s.close(); rmSync(dir, { recursive: true, force: true });
});

// The scan selected `WHERE archived = 0` only, so a pair stayed a candidate forever after being
// linked. linkSupersede is idempotent, so nothing was corrupted — but the sweep re-proposed the same
// finished work every hour, and each re-proposal costs a vector read and a cosine compare in the
// slice. Harmless while the pass was opt-in and effectively nobody ran it; now it is on by default.
test('a pair already linked is not proposed again — the sweep converges', () => {
  const { s, dir } = store();
  const older = add(s, 'Bump thing to 1.0.0', 1000);
  const newer = add(s, 'Bump thing to 2.0.0', 5000);
  expect(s.supersedeCandidateWindow(500).length).toBe(1);   // first sweep sees it

  s.linkSupersede(older, newer, {
    entityKey: 'thing', olderVersion: '1.0.0', newerVersion: '2.0.0', atEpoch: 6000,
  });

  expect(s.supersedeCandidateWindow(500)).toEqual([]);      // second sweep has nothing left to do
  s.close(); rmSync(dir, { recursive: true, force: true });
});

// windowLimit was declared, documented as "caps how many PAIRS are emitted", and never read. An
// operator lowering CAPTAIN_MEMO_QM_DEDUP_WINDOW to bound supersede's work got no effect at all.
// Safe to honour only because of the convergence fix above: without it, capping would permanently
// starve whichever partitions sorted last, since finished pairs never left the candidate set.
test('windowLimit caps the number of emitted pairs', () => {
  const { s, dir } = store();
  for (let i = 1; i <= 6; i++) {
    add(s, `Bump package-${i} to 1.0.0`, 1000 + i);
    add(s, `Bump package-${i} to 2.0.0`, 5000 + i);
  }
  expect(s.supersedeCandidateWindow(500).length).toBe(6);   // uncapped: every pair
  expect(s.supersedeCandidateWindow(2).length).toBe(2);     // capped
  s.close(); rmSync(dir, { recursive: true, force: true });
});
