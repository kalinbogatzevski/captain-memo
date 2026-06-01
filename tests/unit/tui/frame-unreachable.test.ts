// tests/unit/tui/frame-unreachable.test.ts — when the worker stops answering,
// `top`/`watch` must stop pretending the on-screen stats are live. Before the fix
// it kept rendering the last-good stats with a ticking clock and only a dim
// footnote — so a dead/zombie worker "looked live" (field complaint 2026-06-01).
// Now a prominent banner is prepended on every mode and the stats are marked stale.
//
// Color is off under `bun test` (stdout is not a TTY), so the banner is plain
// text — we assert on the WORDS, not the ANSI codes.
import { test, expect } from 'bun:test';
import { buildFrame, unreachableBanner, type FrameData } from '../../../src/cli/tui/frame.ts';
import { initialState } from '../../../src/cli/tui/state.ts';

const dims = { cols: 80, rows: 24 };

test('unreachableBanner names the problem and says the data is stale', () => {
  const b = unreachableBanner(80, null).join('\n');
  expect(b).toContain('WORKER UNREACHABLE');
  expect(b.toUpperCase()).toContain('STALE');
});

test('unreachableBanner shows the last-ok time when known, omits it when not', () => {
  expect(unreachableBanner(80, 1_700_000_000_000).join('\n')).toContain('last ok');
  expect(unreachableBanner(80, null).join('\n')).not.toContain('last ok');
});

test('buildFrame prepends the unreachable banner on EVERY mode when the worker is down', () => {
  for (const mode of ['dashboard', 'table', 'detail', 'help'] as const) {
    const state = { ...initialState(), mode };
    const data: FrameData = { workerUnreachable: true, lastOkAtMs: 1_700_000_000_000 };
    const frame = buildFrame(state, data, dims);
    expect(frame[0]).toContain('WORKER UNREACHABLE');
  }
});

test('buildFrame shows NO banner when the worker is reachable (backward-compatible)', () => {
  const frame = buildFrame(initialState(), {}, dims).join('\n');
  expect(frame).not.toContain('WORKER UNREACHABLE');
});

test('stale stats are still shown BELOW the banner (data preserved, not blanked)', () => {
  const frame = buildFrame(initialState(), { workerUnreachable: true, lastOkAtMs: null }, dims);
  expect(frame[0]).toContain('WORKER UNREACHABLE');
  expect(frame.length).toBeGreaterThan(1); // body still rendered beneath the banner
});
