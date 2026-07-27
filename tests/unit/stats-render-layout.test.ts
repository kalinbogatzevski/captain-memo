// tests/unit/stats-render-layout.test.ts — the panel's column layout: which blocks
// share a row at which widths, and the invariant that nothing ever exceeds the panel.
//
// Origin (2026-07-27): measured at a 160-column panel the dashboard was 69 rows with
// 5 873 unused cells — 85 blank columns per row, 53% of the panel — because most of
// the blocks hugged the left margin. `top` renders the same panel into a live viewport
// and did not clip, so a panel taller than the terminal scrolled its own header out of
// the alt buffer.
import { test, expect } from 'bun:test';
import { renderStats, type StatsResponse } from '../../src/cli/stats-render.ts';
import { visibleWidth } from '../../src/shared/ansi.ts';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const BASE: StatsResponse = {
  total_chunks: 126_624,
  by_channel: { memory: 1_537, observation: 125_087 },
  observations: {
    total: 111_399, queue_pending: 0, queue_processing: 0,
    by_origin: { 'claude-code': 111_151, agy: 246, codex: 1, gemini: 1 },
  },
  indexing: {
    status: 'ready', total: 640, done: 640, errors: 0,
    started_at_epoch: 0, finished_at_epoch: 0, last_error: null, elapsed_s: 3, percent: 100,
  },
  project_id: 'default',
  worker: { started_at_epoch: 0, uptime_s: 300 },
  embedder: { model: 'voyage-4-lite', endpoint: 'https://api.voyageai.com/v1/embeddings' },
  disk: { bytes: 1_920_000_000, path: '/x' },
  summarizer: { provider: 'claude-oauth', model: 'claude-haiku-4-5', enabled: true },
  tide: {
    enabled: true, tiering_enabled: true, relevance_floor: 0.3,
    strengthened: 11_662,
    by_state: { active: 111_399, dormant: 0, archived: 0 },
    anchored: 0, max_stability_days: 11_730.2,
  },
  dream: {
    audit_log: { path: '/x/audit.jsonl', bytes: 20_100_000, entries: 6_681, last_entry_epoch_ms: Date.now() },
    co_retrieval: { pairs: 219_222, docs_covered: 15_884 },
  },
};

const render = (panelWidth: number, over: Partial<StatsResponse> = {}): string[] =>
  renderStats({ ...BASE, ...over } as StatsResponse, { panelWidth });

/** The single line carrying a section's rule, e.g. "  Tide ─────". */
const ruleLineFor = (lines: string[], title: string): string | undefined =>
  lines.find(l => new RegExp(`(^|\\s)${title} ─`).test(strip(l)));

test('Tide and Dream share one row on a panel wide enough for both', () => {
  const shared = ruleLineFor(render(160), 'Tide');
  expect(shared).toBeDefined();
  expect(strip(shared!)).toContain('Dream');
});

test('Tide and Dream stack below their pairing threshold', () => {
  const tideRule = ruleLineFor(render(120), 'Tide');
  expect(tideRule).toBeDefined();
  expect(strip(tideRule!)).not.toContain('Dream');
});

test('AI sources spans the full panel', () => {
  // Nothing pairs with it on this line, so it must fill the panel rather than sit in
  // a half-width column with an empty space beside it.
  const rule = ruleLineFor(render(160), 'AI sources');
  expect(rule).toBeDefined();
  expect(visibleWidth(rule!)).toBe(160);
});

test('no rendered line exceeds the panel width', () => {
  // The guard that catches a paired block whose content is wider than its column —
  // e.g. Tide at 81 columns dropped into a 78-column half.
  for (const width of [100, 120, 145, 160, 200]) {
    for (const line of render(width)) {
      if (visibleWidth(line) > width) {
        throw new Error(`at panel ${width}, line is ${visibleWidth(line)} cells: ${strip(line)}`);
      }
    }
  }
});

test('a busy queue does not push the panel wider than its width', () => {
  const busy = { ...BASE.observations, queue_pending: 2_949, queue_processing: 20, queue_failed: 678 };
  for (const line of render(160, { observations: busy })) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(160);
  }
});

test('no left block outgrows its column and shoves the right one out of line', () => {
  // twoColumn pads the left block to the column width but cannot shrink a line that
  // is already wider, so an over-long left row silently pushes that one right-column
  // line out of the grid. The gap columns are the tell: on a correctly-sized pair they
  // are blank on every line, and only left-block overflow can put content there.
  const lw = Math.floor((160 - 3) / 2);
  const lines = render(160).map(strip);
  const pairStart = lines.findIndex(l => /Tide ─/.test(l) && l.includes('Dream'));
  expect(pairStart).toBeGreaterThan(-1);
  for (const line of lines.slice(pairStart, pairStart + 5)) {
    if (line.slice(lw, lw + 3).trim() !== '') {
      throw new Error(`left column overflows into the gap at ${lw}: ${line}`);
    }
  }
});

test('the status block folds Summarizer and Disk beside Worker/Project/Indexing', () => {
  const lines = render(160).map(strip);
  const worker = lines.find(l => l.includes('Worker'));
  expect(worker).toBeDefined();
  expect(worker!).toContain('Summarizer');
  // Embedder keeps its own full-width row — with a queue tail it reaches 101 columns
  // and a 78-column half would wrap it.
  const embedder = lines.find(l => l.includes('Embedder'));
  expect(embedder!).not.toContain('Disk');
});

test('percentages drop the repeated "of corpus" suffix', () => {
  const out = render(160).map(strip).join('\n');
  expect(out).not.toContain('of corpus');
  expect(out).toContain('(10.5%)');   // Tide Strengthened, 11 662 / 111 399
});
