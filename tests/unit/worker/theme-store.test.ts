import { test, expect, describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ObservationsStore } from '../../../src/worker/observations-store.ts';

// The only destructive step in stage 2: a theme is inserted and its members archived beneath it.
// Reversibility is the contract — `theme_member_ids` on the theme and `archived_into_theme_id`
// on each member are the two halves that make undo possible. Both columns have existed since
// migration v6 and neither was ever written to.

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'cm-theme-'));
  return { s: new ObservationsStore(join(dir, 'o.db')), dir };
}
const add = (s: ObservationsStore, title: string, session: string, at: number) =>
  s.insert({
    session_id: session, project_id: 'p', prompt_number: 1, type: 'discovery', title,
    narrative: '', facts: [], concepts: [], files_read: [], files_modified: [],
    created_at_epoch: at, branch: null, origin_agent: null, work_tokens: null,
  } as never);
const draft = {
  title: 'update-status skill is available and callable',
  narrative: 'Confirmed across three sessions.',
  facts: ['registered in erp-platform'], concepts: ['skills'],
};

// The type checker caught this one: an earlier wiring pointed the theme pass at
// sameSessionCandidateRows, which keeps only sessions holding 2+ rows — exactly inverted for
// cross-session themes, where a row alone in its session is a prime candidate.
describe('themeCandidateRows', () => {
  test('includes rows that are ALONE in their session', () => {
    const { s, dir } = store();
    const solo1 = add(s, 'learned it here', 's1', 100);
    const solo2 = add(s, 'learned it again here', 's2', 200);
    s.bumpRetrieval([solo1, solo2], 'auto');
    expect(s.themeCandidateRows(500).map(r => r.id).sort()).toEqual([solo1, solo2].sort());
    // and the same-session query, correctly, sees neither
    expect(s.sameSessionCandidateRows(500)).toEqual([]);
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('excludes generated themes — no themes of themes', () => {
    const { s, dir } = store();
    const ids = [add(s, 'a', 's1', 100), add(s, 'b', 's2', 200)];
    s.bumpRetrieval(ids, 'auto');
    const themeId = s.createTheme(draft, ids, { project_id: 'p', branch: null, atEpoch: 400 });
    s.bumpRetrieval([themeId], 'auto');
    expect(s.themeCandidateRows(500).map(r => r.id)).not.toContain(themeId);
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('carries created_at_epoch, which the judge shows the model', () => {
    const { s, dir } = store();
    const a = add(s, 'dated row', 's1', 12345);
    s.bumpRetrieval([a], 'auto');
    expect(s.themeCandidateRows(500)[0]!.created_at_epoch).toBe(12345);
    s.close(); rmSync(dir, { recursive: true, force: true });
  });
});

describe('createTheme', () => {
  test('inserts the theme and archives its members beneath it', () => {
    const { s, dir } = store();
    const ids = [add(s, 'a', 's1', 100), add(s, 'b', 's2', 200), add(s, 'c', 's3', 300)];
    s.bumpRetrieval(ids, 'auto');

    const themeId = s.createTheme(draft, ids, { project_id: 'p', branch: null, atEpoch: 400 });
    expect(themeId).toBeGreaterThan(0);

    const theme = s.findById(themeId)!;
    expect(theme.title).toBe(draft.title);
    expect(theme.archived).toBe(false);
    expect(theme.theme_member_ids).toEqual(ids);          // the members it stands for

    for (const id of ids) {
      const m = s.findById(id)!;
      expect(m.archived).toBe(true);
      expect(m.archived_into_theme_id).toBe(themeId);     // points back at the theme
    }
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  // Surfacing counts are evidence of usefulness. If they vanished, the theme would look brand
  // new and the tide would treat a well-worn fact as unproven.
  test('sums the members surfacing counts onto the theme', () => {
    const { s, dir } = store();
    const a = add(s, 'a', 's1', 100), b = add(s, 'b', 's2', 200), c = add(s, 'c', 's3', 300);
    s.bumpRetrieval([a], 'auto'); s.bumpRetrieval([a], 'auto');
    s.bumpRetrieval([b], 'search'); s.bumpRetrieval([c], 'auto');

    const themeId = s.createTheme(draft, [a, b, c], { project_id: 'p', branch: null, atEpoch: 400 });
    const theme = s.findById(themeId)!;
    expect(theme.from_auto).toBe(3);
    expect(theme.from_search).toBe(1);
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('refuses to build a theme from fewer than two members', () => {
    const { s, dir } = store();
    const a = add(s, 'a', 's1', 100);
    expect(() => s.createTheme(draft, [a], { project_id: 'p', branch: null, atEpoch: 400 })).toThrow();
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('a theme is searchable — it does not hide behind the archived flag', () => {
    const { s, dir } = store();
    const ids = [add(s, 'a', 's1', 100), add(s, 'b', 's2', 200)];
    const themeId = s.createTheme(draft, ids, { project_id: 'p', branch: null, atEpoch: 400 });
    const live = s.findById(themeId)!;
    expect(live.archived).toBe(false);
    expect(live.session_id).toBe('theme');                // provenance: written by the machine
    s.close(); rmSync(dir, { recursive: true, force: true });
  });
});

// CAUGHT BY RUNNING THE CLI: mergeDuplicateGroup also writes theme_member_ids (on a dedup
// SURVIVOR), so "has theme_member_ids" is not the same as "is a theme". Before this, `theme list`
// reported 200 themes on a corpus with none, and `theme undo` on one of them would have
// un-folded a dedup merge and then archived its survivor. session_id='theme' is the real marker.
describe('themes are distinguishable from dedup survivors', () => {
  test('listThemes ignores a dedup survivor', () => {
    const { s, dir } = store();
    const a = add(s, 'survivor', 's1', 100), b = add(s, 'member', 's1', 110);
    s.bumpRetrieval([a, b], 'auto');
    s.mergeDuplicateGroup(a, [b], 200);
    expect(s.listThemes(10)).toEqual([]);
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('unmakeTheme refuses to touch a dedup survivor', () => {
    const { s, dir } = store();
    const a = add(s, 'survivor', 's1', 100), b = add(s, 'member', 's1', 110);
    s.bumpRetrieval([a, b], 'auto');
    s.mergeDuplicateGroup(a, [b], 200);

    expect(s.unmakeTheme(a)).toBe(0);
    expect(s.findById(a)!.archived).toBe(false);   // survivor untouched
    expect(s.findById(b)!.archived).toBe(true);    // fold intact
    s.close(); rmSync(dir, { recursive: true, force: true });
  });
});

describe('unmakeTheme', () => {
  test('restores every member and retires the theme', () => {
    const { s, dir } = store();
    const ids = [add(s, 'a', 's1', 100), add(s, 'b', 's2', 200), add(s, 'c', 's3', 300)];
    s.bumpRetrieval(ids, 'auto');
    const themeId = s.createTheme(draft, ids, { project_id: 'p', branch: null, atEpoch: 400 });

    expect(s.unmakeTheme(themeId)).toBe(3);
    for (const id of ids) {
      const m = s.findById(id)!;
      expect(m.archived).toBe(false);
      expect(m.archived_into_theme_id).toBeNull();
    }
    expect(s.findById(themeId)!.archived).toBe(true);        // the generated row steps aside
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('undoing a non-theme changes nothing', () => {
    const { s, dir } = store();
    const a = add(s, 'ordinary row', 's1', 100);
    expect(s.unmakeTheme(a)).toBe(0);
    expect(s.findById(a)!.archived).toBe(false);
    s.close(); rmSync(dir, { recursive: true, force: true });
  });

  test('undo is idempotent', () => {
    const { s, dir } = store();
    const ids = [add(s, 'a', 's1', 100), add(s, 'b', 's2', 200)];
    const themeId = s.createTheme(draft, ids, { project_id: 'p', branch: null, atEpoch: 400 });
    expect(s.unmakeTheme(themeId)).toBe(2);
    expect(s.unmakeTheme(themeId)).toBe(0);
    s.close(); rmSync(dir, { recursive: true, force: true });
  });
});

describe('listThemes', () => {
  test('lists live themes newest first', () => {
    const { s, dir } = store();
    const t1 = s.createTheme({ ...draft, title: 'first theme' },
      [add(s, 'a', 's1', 100), add(s, 'b', 's2', 110)], { project_id: 'p', branch: null, atEpoch: 200 });
    const t2 = s.createTheme({ ...draft, title: 'second theme' },
      [add(s, 'c', 's3', 300), add(s, 'd', 's4', 310)], { project_id: 'p', branch: null, atEpoch: 400 });

    const themes = s.listThemes(10);
    expect(themes.map(t => t.id)).toEqual([t2, t1]);
    expect(themes[0]!.member_ids.length).toBe(2);

    s.unmakeTheme(t2);
    expect(s.listThemes(10).map(t => t.id)).toEqual([t1]);   // retired themes drop out
    s.close(); rmSync(dir, { recursive: true, force: true });
  });
});
