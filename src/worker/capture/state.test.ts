import { test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptureState } from './state.ts';

function tmpState(): CaptureState {
  return new CaptureState(join(mkdtempSync(join(tmpdir(), 'cm-capstate-')), 'capture-state.db'));
}

// FINDING 1(b) — doctor's "sessions ingested" count has to answer "did capture actually PRODUCE
// something", not "did capture touch this session". Before this fix, ingestedSessions() was a
// bare COUNT(*) over capture_ingested, so a session marked ingested with events_ingested=0
// (extract ran, decompressed fine, matched nothing — see codex-source's zero-turn warning)
// still counted. A payload-format rename that silently zeroed out every extract would still show
// doctor a green "N session(s) ingested" — exactly the incident this counter exists to catch.

test('ingestedSessions: a session marked ingested with zero events does NOT count', () => {
  const state = tmpState();
  state.markIngested('codex', 's1', 'm1', 1000, 0); // extract produced nothing
  expect(state.ingestedSessions('codex')).toBe(0);
});

test('ingestedSessions: a session with events_ingested > 0 counts', () => {
  const state = tmpState();
  state.markIngested('codex', 's1', 'm1', 1000, 3);
  expect(state.ingestedSessions('codex')).toBe(1);
});

test('ingestedSessions: a mix of zero- and non-zero-event sessions counts only the latter', () => {
  const state = tmpState();
  state.markIngested('codex', 's1', 'm1', 1000, 0);
  state.markIngested('codex', 's2', 'm2', 1000, 2);
  state.markIngested('codex', 's3', 'm3', 1000, 0);
  expect(state.ingestedSessions('codex')).toBe(1);
});

test('ingestedSessions: a session re-marked from zero to non-zero events starts counting', () => {
  const state = tmpState();
  state.markIngested('codex', 's1', 'm1', 1000, 0);
  expect(state.ingestedSessions('codex')).toBe(0);
  state.markIngested('codex', 's1', 'm2', 1001, 4); // same session, later marker, now has events
  expect(state.ingestedSessions('codex')).toBe(1);
});

test('ingestedSessions: scoped per source', () => {
  const state = tmpState();
  state.markIngested('codex', 's1', 'm1', 1000, 2);
  state.markIngested('agy', 's2', 'm2', 1000, 5);
  expect(state.ingestedSessions('codex')).toBe(1);
  expect(state.ingestedSessions('agy')).toBe(1);
  expect(state.ingestedSessions('gemini')).toBe(0);
});
