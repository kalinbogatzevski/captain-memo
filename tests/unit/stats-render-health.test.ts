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
