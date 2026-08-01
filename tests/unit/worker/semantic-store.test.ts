import { test, expect, describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ObservationsStore } from '../../../src/worker/observations-store.ts';

// Store-side inputs for the idle semantic pass: the candidate population it scans, and the
// activity clock the idle gate reads.

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'cm-sem-'));
  return { s: new ObservationsStore(join(dir, 'o.db')), dir };
}
const add = (s: ObservationsStore, title: string, session: string, createdAt: number) =>
  s.insert({
    session_id: session, project_id: 'p', prompt_number: 1, type: 'change', title,
    narrative: '', facts: [], concepts: [], files_read: [], files_modified: [],
    created_at_epoch: createdAt, branch: null, origin_agent: null, work_tokens: null,
  } as never);

describe('sameSessionCandidateRows', () => {
  test('returns only rows from sessions holding at least two live candidates', () => {
    const { s, dir } = store();
    const a = add(s, 'pair one', 's1', 100);
    const b = add(s, 'pair two', 's1', 101);
    const solo = add(s, 'alone', 's2', 102);
    s.bumpRetrieval([a, b, solo], 'auto');

    const ids = s.sameSessionCandidateRows(500).map(r => r.id).sort();
    expect(ids).toEqual([a, b].sort());          // the solo session contributes nothing
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  // Dedup targets what actually reaches the user. A never-surfaced row is not bloating anything.
  test('excludes never-surfaced rows', () => {
    const { s, dir } = store();
    const a = add(s, 'surfaced one', 's1', 100);
    const b = add(s, 'surfaced two', 's1', 101);
    add(s, 'never surfaced', 's1', 102);
    s.bumpRetrieval([a, b], 'auto');

    expect(s.sameSessionCandidateRows(500).map(r => r.id).sort()).toEqual([a, b].sort());
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('excludes archived rows', () => {
    const { s, dir } = store();
    const a = add(s, 'kept', 's1', 100);
    const b = add(s, 'folded away', 's1', 101);
    const c = add(s, 'still here', 's1', 102);
    s.bumpRetrieval([a, b, c], 'auto');
    s.mergeDuplicateGroup(a, [b], 200);

    const ids = s.sameSessionCandidateRows(500).map(r => r.id).sort();
    expect(ids).toEqual([a, c].sort());
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('carries the counters the survivor invariant needs', () => {
    const { s, dir } = store();
    const a = add(s, 'loud', 's1', 100);
    const b = add(s, 'quiet', 's1', 101);
    s.bumpRetrieval([a], 'auto'); s.bumpRetrieval([a], 'search'); s.bumpRetrieval([b], 'auto');

    const rows = s.sameSessionCandidateRows(500);
    const loud = rows.find(r => r.id === a)!;
    expect(loud.from_auto).toBe(1);
    expect(loud.from_search).toBe(1);
    expect(loud.session_id).toBe('s1');
    expect(loud.title).toBe('loud');
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('respects the row limit', () => {
    const { s, dir } = store();
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push(add(s, `row ${i}`, 's1', 100 + i));
    s.bumpRetrieval(ids, 'auto');
    expect(s.sameSessionCandidateRows(4).length).toBe(4);
    s.close(); rmSync(dir, { recursive: true, force: true });
  });
});

describe('lastActivityEpoch', () => {
  test('null on an empty corpus — an unknown clock must not read as "active now"', () => {
    const { s, dir } = store();
    expect(s.lastActivityEpoch()).toBeNull();
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('reports the newest creation time', () => {
    const { s, dir } = store();
    add(s, 'older', 's1', 100);
    add(s, 'newer', 's1', 500);
    expect(s.lastActivityEpoch()).toBe(500);
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  // A recall is activity even when nothing new was written — a user searching their memory is
  // very much using the machine.
  test('a surface bump counts as activity', () => {
    const { s, dir } = store();
    const a = add(s, 'old row', 's1', 100);
    s.bumpRetrieval([a], 'search', 9000);
    expect(s.lastActivityEpoch()).toBe(9000);
    s.close(); rmSync(dir, { recursive: true, force: true });
  });
});
