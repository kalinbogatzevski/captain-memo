// The work-board overlap warning printed the CALLER's own paths (the worker's `overlapping`) under the peer's session
// id and called every peer "another captain", so two sessions each looked like they were editing the other's files.
// formatOverlapWarning names the PEER's own matching paths. Whole-repo claims never reach it (the worker drops them).
import { test, expect } from 'bun:test';
import { formatOverlapWarning, formatDeny } from '../../src/hooks/pre-tool-use.ts';

test('no overlaps, no warning', () => {
  expect(formatOverlapWarning([])).toBeNull();
});

test('a file hit names the PEER\'s matching paths, and the caller\'s side separately', () => {
  const w = formatOverlapWarning([{
    session_id: '0b5a87fc-17ae-4f3c', agent: 'claude', kind: 'files',
    files: ['/repo/tasks/loader.php', '/repo/notes/list.html'], overlapping: ['/repo/notes/list.html'],
  }])!;
  expect(w).toContain('another session on this captain (0b5a87fc-17a, claude)');
  expect(w).toContain('holds /repo/notes/list.html, which overlaps your /repo/notes/list.html');
  expect(w).not.toContain('another captain');
  expect(w).not.toContain('loader.php');   // only what actually overlaps
});

test('a topic hit, a repo hit and a semantic hit each read as what they are', () => {
  const w = formatOverlapWarning([
    { session_id: 'topic-1', agent: 'claude', kind: 'topics', overlapping: ['billing-rounding'], what: 'fixing rounding' },
    { session_id: 'repo-1', agent: 'claude', kind: 'repo', overlapping: ['/r'] },
    { session_id: 'sem-1', agent: 'claude', kind: 'semantic', what: 'same idea', similarity: 0.91 },
  ])!;
  expect(w).toContain('holds the same topic: billing-rounding ("fixing rounding")');
  expect(w).toContain('works in the same repository (/r)');
  expect(w).toContain('by meaning: "same idea" (~0.91)');
  expect(w).not.toContain('holds billing-rounding');   // a topic is never printed as a file
});

// #103: a ghost claim must not read like live work. 2026-09-30: but "stale" only means no recent edit (a live session
// that was reading got overwritten), so even a stale-only overlap says tell the user before writing, never "carry on".
test('a stale peer is worded as no recent edit, and a stale-only overlap still says tell the user before writing', () => {
  const ghost = { session_id: 'ghost-1', agent: 'codex', kind: 'topics' as const, overlapping: ['billing'], what: 'x', stale: true, age_s: 47 * 60 };
  const only = formatOverlapWarning([ghost])!;
  expect(only).toContain('(ghost-1, codex; stale: no edit for 47m, may be reading or ended)');
  expect(only).toContain('tell the user which session holds it before writing the same files');
  expect(only).not.toContain('probably ended');
  expect(only).not.toContain('not a blocker');
  expect(only).not.toContain('continue');   // it can merge with pre-git's advice to isolate a mutating git op
  const mixed = formatOverlapWarning([ghost, { session_id: 'live-1', agent: 'claude', kind: 'topics', overlapping: ['billing'], what: 'y' }])!;
  expect(mixed).toContain('(live-1, claude) holds the same topic');
  expect(mixed).toContain('Stop and tell the user which session holds it');
  expect(mixed).toContain('never edit or deploy over another session\'s claim');
  expect(mixed).not.toContain('fleet_send');   // OSS has no peer channel: the user decides
});

// Guard 2 (2026-09-30): a live claim blocks. The deny names the holder and says the user decides; the only lift is the
// user typing `override: <file>`, which the holder then sees on its own overlap line.
test('the deny text names the file and holder, says tell the user, and gives the override', () => {
  const d = formatDeny(['/repo/hr/functions.php'], [{ session_id: '0b005e40', agent: 'claude', age_s: 180, what: 'HR fingerprints' }]);
  expect(d).toStartWith('WORK-BOARD: BLOCKED. /repo/hr/functions.php is held by another session on this captain (0b005e40, claude, last edit 3 min ago: "HR fingerprints")');
  expect(d).toContain('Stop and tell the user which session holds it');
  expect(d).toContain('`override: /repo/hr/functions.php`');
  expect(d).toContain('Do not route around this');
  expect(d).not.toContain('fleet_send');
  expect(d).not.toMatch(/\u2014/);
});

test('a peer whose user overrode the claim says so on the holder\'s overlap line', () => {
  const w = formatOverlapWarning([{ session_id: 'B', agent: 'claude', kind: 'files', files: ['/r/a.php'], overlapping: ['/r/a.php'], override: { files: ['/r/a.php'], until: Date.now() + 60_000 } }])!;
  expect(w).toContain('its user typed `override:` for /r/a.php until');
  expect(w).toContain('re-read them before your next write');
});
