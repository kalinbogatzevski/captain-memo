// tests/unit/stats-render-health.test.ts — the Summarizer health line and the
// observation-queue backlog line on the stats page (shared by `stats` and `top`,
// both of which render through renderStats).
//
// Regression origin (2026-07-26): a weekly rate-limit 429 stopped the summarizer
// for 21 hours. `stats` kept printing a GREEN "Summarizer ● claude-oauth" the
// whole time (the dot was driven by `enabled`, i.e. "a provider resolved at boot"),
// and the 2 949 observations piling up behind it were rendered nowhere at all —
// the counts were already in the /stats payload, just never displayed. The outage
// was only visible in journalctl.
import { test, expect } from 'bun:test';
import { renderStats, type StatsResponse } from '../../src/cli/stats-render.ts';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const render = (over: Partial<StatsResponse>): string =>
  renderStats({ ...BASE, ...over } as StatsResponse, { panelWidth: 100 }).map(strip).join('\n');

const BASE: StatsResponse = {
  total_chunks: 10,
  by_channel: { observation: 10 },
  observations: { total: 10, queue_pending: 0, queue_processing: 0 },
  indexing: {
    status: 'ready', total: 1, done: 1, errors: 0,
    started_at_epoch: 0, finished_at_epoch: 0, last_error: null, elapsed_s: 0, percent: 100,
  },
  project_id: 'default',
  embedder: { model: 'voyage-4-lite', endpoint: 'https://example.invalid' },
};

test('a healthy summarizer with an empty queue adds no backlog noise', () => {
  const out = render({ summarizer: { provider: 'claude-oauth', model: 'claude-haiku-4-5', enabled: true } });
  expect(out).toContain('claude-oauth');
  expect(out).not.toContain('Queue');
});

test('a pending backlog is shown, not silently swallowed', () => {
  const out = render({ observations: { total: 10, queue_pending: 2949, queue_processing: 20 } });
  expect(out).toContain('Queue');
  expect(out).toContain('2 949');   // grouped the same way as every other count
  expect(out).toContain('waiting');
});

test('dead-lettered rows are surfaced alongside the backlog', () => {
  const out = render({ observations: { total: 10, queue_pending: 5, queue_processing: 0, queue_failed: 678 } });
  expect(out).toContain('678');
  expect(out).toContain('failed');
});

test('a cooling-down summarizer shows WHY and when it retries — not a green dot', () => {
  const out = render({
    summarizer: {
      provider: 'claude-oauth', model: 'claude-haiku-4-5', enabled: true,
      cooling_down: true,
      cooldown_until_epoch: Math.floor(Date.now() / 1000) + 3600,
      last_error: 'claude-oauth: HTTP 429: rate_limit_error',
      consecutive_failures: 1,
    },
  });
  expect(out).toContain('paused');
  expect(out).toContain('429');           // the actual reason, verbatim
  expect(out).toContain('retries in');
});

test('a permanently-failing summarizer surfaces its last error even when not cooling down', () => {
  const out = render({
    summarizer: {
      provider: 'claude-oauth', model: 'claude-haiku-4-5', enabled: true,
      cooling_down: false,
      last_error: 'claude-oauth: HTTP 400: model: String should have at least 1 character',
    },
  });
  expect(out).toContain('last error');
  expect(out).toContain('HTTP 400');
});

// ---- embed spend line (2026-10-08) ----
const EFF = {
  corpus: { work_tokens: 0, stored_tokens: 0, ratio: null, saved_pct: null, coverage: { with_data: 0, total: 0 } },
  embedder: { calls: 3, avg_latency_ms: 200, tokens_per_s: 500 },
  dedup: { docs_seen: 1, skipped_unchanged: 1, skip_pct: 100 },
};
const USAGE = { since_epoch: 0, calls: 9, tokens: 1_200_000, wasted_tokens: 0, aborted: 0, window_wasted_tokens: 0,
  waste_limit_tokens: 500_000, paused_until_epoch: null, by_source: {} };

test('the efficiency block shows what the embedder sent, and how much of it was wasted', () => {
  const ok = render({ efficiency: EFF, embedder_usage: USAGE });
  expect(ok).toContain('Embed tokens');
  expect(ok).toContain('0 wasted');
  const bad = render({ efficiency: EFF, embedder_usage: { ...USAGE, wasted_tokens: 70_000, aborted: 2 } });
  expect(bad).toContain('in unfinished requests');
});

test('a paused embedder says so on the stats page', () => {
  const out = render({ efficiency: EFF, embedder_usage: { ...USAGE, paused_until_epoch: Math.floor(Date.now() / 1000) + 900 } });
  expect(out).toContain('embedding paused');
});

test('the budget line shows the hour, the per-engine limit and whether an engine tripped', () => {
  const budget = { limit_tokens: 500_000, window_tokens: 12_345, paused_until_epoch: null, trips: 0 };
  const ok = render({ efficiency: EFF, embedder_usage: { ...USAGE, interactive_budget: budget } });
  expect(ok).toContain('Embed budget');
  expect(ok).toContain('12.3 k tok');
  expect(ok).toContain('limit 500.0 k per engine');
  expect(ok).toContain('not tripped');
  const off = render({ efficiency: EFF, embedder_usage: { ...USAGE, interactive_budget: { ...budget, limit_tokens: 0 } } });
  expect(off).toContain('budget off');
  const tripped = render({ efficiency: EFF, embedder_usage: { ...USAGE, interactive_budget: { ...budget, window_tokens: 640_000, paused_until_epoch: Math.floor(Date.now() / 1000) + 900, trips: 1 } } });
  expect(tripped).toContain('TRIPPED');
  expect(tripped).toContain('keyword-only');
  expect(tripped).not.toContain('embedding paused');                      // the waste pause line is its own
});

test('the budget line says why it is off, and says the truth once the pause is over but the hour still holds the spend', () => {
  const budget = { limit_tokens: 500_000, window_tokens: 640_000, paused_until_epoch: null as number | null, trips: 1 };
  const withBudget = (b: NonNullable<NonNullable<StatsResponse['embedder_usage']>['interactive_budget']>) =>
    render({ efficiency: EFF, embedder_usage: { ...USAGE, interactive_budget: b } });
  const local = withBudget({ ...budget, limit_tokens: 0, off_reason: 'local-endpoint' });
  expect(local).toContain('budget off: local endpoint');
  const owner = withBudget({ ...budget, limit_tokens: 0 });                                    // the owner set 0: just off
  expect(owner).toContain('budget off');
  expect(owner).not.toContain('budget off: local');
  const over = withBudget({ ...budget, over_limit: true });
  expect(over).toContain('OVER THE LIMIT');
  expect(over).toContain('500.0 k per engine');
  expect(over).toContain('next search is refused');
  expect(over).not.toContain('not tripped');
  expect(over).not.toContain('TRIPPED');
  // a pause that is running is the state shown, whatever else the flag says
  expect(withBudget({ ...budget, over_limit: true, paused_until_epoch: Math.floor(Date.now() / 1000) + 900 })).toContain('TRIPPED');
  expect(withBudget({ ...budget, window_tokens: 12_345 })).toContain('not tripped');         // unchanged
});

test('an older worker with no budget field renders no budget line', () => {
  expect(render({ efficiency: EFF, embedder_usage: USAGE })).not.toContain('Embed budget');
});

test('an older worker with no usage field renders no spend line', () => {
  expect(render({ efficiency: EFF })).not.toContain('Embed tokens');
});
