// tests/support/top-full-stats.ts — a /stats payload (and the data behind every `top` panel) that carries
// EVERY optional block the dashboard can draw (this line has no federation), built from invented names only. Never copy anything from a real
// corpus or the live /stats in here. The width tests (top-frame-clip.test.ts) run the real frame builder over
// it: a fixture with no embedder_usage is how a 170-cell line shipped in 0.58.4 and was never seen.
import type { StatsResponse, HomeworkView } from '../../src/cli/stats-render.ts';
import type { DetailObs, RecallRowView, SessionUsageRow } from '../../src/cli/tui/frame.ts';
import type { InteractiveBudgetUsage } from '../../src/worker/embedder.ts';

export type BudgetState = 'ok' | 'tripped' | 'over' | 'off' | 'off-local' | 'none';

export const LONG_PROJECT = 'north-harbour-telemetry-gateway-service';
export const SHORT_PROJECT = 'qx';

/** The interactive budget in each state the dashboard words differently; `none` = a worker older than the budget. */
export function budgetFor(state: BudgetState, nowS: number): InteractiveBudgetUsage | undefined {
  const base = { limit_tokens: 500_000, window_tokens: 12_345, paused_until_epoch: null as number | null, trips: 0 };
  switch (state) {
    case 'ok': return base;
    case 'tripped': return { ...base, window_tokens: 640_000, paused_until_epoch: nowS + 900, trips: 2 };
    case 'over': return { ...base, window_tokens: 640_000, trips: 1, over_limit: true };
    case 'off': return { ...base, limit_tokens: 0 };
    case 'off-local': return { ...base, limit_tokens: 0, off_reason: 'local-endpoint' };
    case 'none': return undefined;
  }
}

const recallEntry = (id: number, type: string, title: string, nowS: number) => ({
  id, type, title, from_auto: 40 + id, from_search: 7 + id, from_drill: 2, last_surfaced_at: nowS - 90 * id, variants: id % 3 + 1,
});

export function fullStats(opts: { project?: string; budget?: BudgetState; paused?: boolean; nowMs?: number } = {}): StatsResponse {
  const nowMs = opts.nowMs ?? Date.now();
  const nowS = Math.floor(nowMs / 1000);
  const budget = budgetFor(opts.budget ?? 'ok', nowS);
  const run = { id: 1, job: 'dedup', startedAt: nowS - 3600, finishedAt: nowS - 3590, rowsScanned: 1840, merges: 12, skippedNoVector: 3, abortedForIngest: false, errored: false };
  return {
    total_chunks: 24_551,
    by_channel: { memory: 279, skill: 41, observation: 24_272 },
    observations: {
      total: 10_593, queue_pending: 2_949, queue_processing: 20, queue_failed: 4,
      by_origin: { 'claude-code': 8_100, codex: 1_450, gemini: 520, agy: 310, opencode: 140, kimi: 38, unknown: 35 },
    },
    indexing: { status: 'indexing', total: 312, done: 279, errors: 2, started_at_epoch: nowS - 600, finished_at_epoch: 0, last_error: null, elapsed_s: 600, percent: 89 },
    project_id: opts.project ?? LONG_PROJECT,
    version: '0.58.4',
    worker: { started_at_epoch: nowS - 3 * 86_400, uptime_s: 3 * 86_400 + 4 * 3600 },
    summarizer: {
      provider: 'claude-oauth', model: 'claude-haiku-4-5', enabled: true, cooling_down: true,
      cooldown_until_epoch: nowS + 1_800, consecutive_failures: 3,
      last_error: 'claude-oauth: HTTP 429: the weekly rate limit for this account has been reached, it resets on Monday at 09:00 UTC and until then no request is answered',
    },
    embedder: { model: 'voyage-4-lite', endpoint: 'https://api.voyageai.com/v1/embeddings' },
    disk: { bytes: 3_400_000_000, path: '/srv/captain-memo/data' },
    efficiency: {
      corpus: { work_tokens: 19_057_556, stored_tokens: 1_536_000, ratio: 12.4, saved_pct: 92, coverage: { with_data: 10_593, total: 24_272 } },
      embedder: { calls: 12_345, avg_latency_ms: 85, tokens_per_s: 123_456 },
      dedup: { docs_seen: 1_234_567, skipped_unchanged: 1_200_000, skip_pct: 97 },
    },
    embedder_usage: {
      since_epoch: nowS - 3 * 86_400, calls: 23_456, tokens: 98_765_432, wasted_tokens: 1_234_567, aborted: 12, window_wasted_tokens: 120_000,
      waste_limit_tokens: 500_000, paused_until_epoch: opts.paused ? nowS + 900 : null, readers: 2,
      by_source: { index: { calls: 20_000, tokens: 90_000_000 }, query: { calls: 3_000, tokens: 8_000_000 }, remember: { calls: 456, tokens: 765_432 } },
      ...(budget ? { interactive_budget: budget } : {}),
      per_minute: [
        { at_epoch: nowS - 120, by_source: { query: { calls: 3, tokens: 2_400 }, other: { calls: 1, tokens: 900 } } },
        { at_epoch: nowS - 60, by_source: { query: { calls: 5, tokens: 4_100 }, remember: { calls: 1, tokens: 300 } } },
      ],
      busiest_interactive_minute: { at_epoch: nowS - 3_000, calls: 14, tokens: 11_800 },
    },
    native_tokens: {
      window: { sessions: 3, window_ms: 18_000_000, window_fresh_tokens: 1_234_567, window_output_tokens: 234_567, window_cache_read_tokens: 98_765_432 },
      all_time: { sessions: 1_234, agents: 456, oldest_epoch_ms: nowMs - 90 * 86_400_000, fresh_tokens: 812_345_678, output_tokens: 91_234_567, cache_read_tokens: 9_876_543_210 },
    },
    recall: {
      surfaced_count: 6_242, recalled_count: 303, totals: { auto: 5_900, search: 312, drill: 303 },
      top_surfaced: [
        recallEntry(1, 'decision', 'Moved the nightly ledger sync to batched upserts after the quarterly import stalled for two hours', nowS),
        recallEntry(2, 'bugfix', 'Harbour gateway dropped heartbeats when the retry queue exceeded its cap', nowS),
        recallEntry(3, 'discovery', 'The tide-table cache key ignored the timezone, so two crews shared one entry', nowS),
        recallEntry(4, 'change', 'Short title', nowS),
      ],
      top_recalled: [
        recallEntry(5, 'feature', 'Added a per-berth override to the mooring schedule exporter with a dry-run flag', nowS),
        recallEntry(6, 'refactor', 'Split the buoy telemetry parser into a reader and a validator', nowS),
        recallEntry(7, 'decision', 'Keep the lighthouse alerts on the old pager until the new route is signed off', nowS),
      ],
      recent_surfaced: [
        { id: 11, type: 'discovery', title: 'Quay crane firmware reports torque in newton-metres on one model and foot-pounds on another', last_surfaced_at: nowS - 20, source: 'auto' },
        { id: 12, type: 'bugfix', title: 'Pilot roster export wrote the wrong week number on the first Monday of January', last_surfaced_at: nowS - 400, source: 'search' },
        { id: 13, type: 'change', title: 'Renamed the shipping-lane table', last_surfaced_at: nowS - 5_000, source: 'drill' },
        { id: 14, type: 'decision', title: 'Customs hold codes stay as strings; the leading zeros carry meaning for the broker', last_surfaced_at: nowS - 90_000, source: null },
      ],
    },
    qm: { enabled: true, dedup_enabled: true, cosine_threshold: 0.93, last_run: run },
    supersede: { enabled: true, cosine_threshold: 0.9, links: 128, last_run: run },
    semantic: { enabled: true, cosine_threshold: 0.88, min_idle_seconds: 1_800, last_run: { ...run, job: 'semantic', abortedForIngest: true, rowsScanned: 0 } },
    theme: { enabled: true, cosine_threshold: 0.85, min_members: 3, live: 17, last_run: { ...run, job: 'theme', rowsScanned: 41, skippedNoVector: 9, errored: true } },
    idle: { seconds_since_activity: 240, min_idle_seconds: 1_800, eligible: false, blocked_by: ['queue', 'co-session'], forced_seconds_left: 0 },
    tide: {
      enabled: true, tiering_enabled: true, relevance_floor: 0.35, strengthened: 3_210,
      by_state: { active: 9_800, dormant: 600, archived: 193 }, folded: 412, anchored: 17, max_stability_days: 182.5,
    },
    dream: {
      audit_log: { path: '/srv/captain-memo/data/recall-audit.jsonl', bytes: 4_200_000, entries: 52_000, last_entry_epoch_ms: nowMs - 30_000 },
      co_retrieval: { pairs: 128_000, docs_covered: 9_400 },
      injected: { tokens: 12_345_678, injections: 5_432, since_epoch_ms: nowMs - 60 * 86_400_000 },
    },
  };
}

export function fullHomework(nowMs: number = Date.now()): HomeworkView[] {
  const item = (id: number, over: Partial<HomeworkView>): HomeworkView => ({
    id: String(id), text: `Rework the berth allocation export so the pilots see the same week numbers as the harbour office #${id}`,
    topics: ['berths', 'export'], by: 'night-shift', created_at: nowMs - id * 3_600_000, ...over,
  });
  return [
    item(101, {}),
    item(102, { project: LONG_PROJECT, claimed_by: 'day-shift', claimed_at: nowMs - 600_000 }),
    item(103, { local: true, text: 'Short one' }),
    item(104, { text: 'A very long item. '.repeat(30), topics: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] }),
    item(105, { done_at: nowMs - 86_400_000, done_by: 'day-shift', note: 'Shipped with the Tuesday release; the pilots confirmed the week numbers match now.' }),
  ];
}

export const FULL_PAGE_ROWS = (nowS: number = Math.floor(Date.now() / 1000)): RecallRowView[] =>
  Array.from({ length: 30 }, (_, i) => ({
    id: i + 1, type: ['decision', 'bugfix', 'discovery', 'change', 'feature'][i % 5]!,
    title: i % 2 ? 'Harbour gateway dropped heartbeats when the retry queue exceeded its cap and nobody noticed for a week' : 'Short title',
    from_auto: 40 + i, from_search: 7, from_drill: 2, total: 49 + i, last_surfaced_at: i % 4 ? nowS - 600 * i : null,
    last_surfaced_source: (['auto', 'search', 'drill', null] as const)[i % 4]!, variants: i % 3 + 1,
  }));

export const FULL_DETAIL = (nowS: number = Math.floor(Date.now() / 1000)): DetailObs => ({
  id: 7, type: 'decision', title: 'Moved the nightly ledger sync to batched upserts after the quarterly import stalled for two hours',
  narrative: 'The nightly ledger sync wrote one row at a time and held a table lock for the whole run. '.repeat(6),
  facts: ['Batches of 500 rows keep the lock under a second', 'The import that stalled had 1 200 000 rows and ran for 2 h 10 m'],
  concepts: ['batching', 'locking', 'ledger', 'imports'],
  files_read: ['src/ledger/sync.ts', 'src/ledger/very/deeply/nested/directory/structure/with/long/names/batch-writer.ts'],
  files_modified: ['src/ledger/sync.ts', 'tests/ledger/sync.test.ts'],
  from_auto: 40, from_search: 7, from_drill: 2, last_surfaced_at: nowS - 3_600, last_surfaced_source: 'search',
  created_at_epoch: nowS - 30 * 86_400, origin_agent: 'codex',
});

export const FULL_SESSIONS = (nowMs: number = Date.now()): { window_ms: number; sessions: SessionUsageRow[] } => ({
  window_ms: 18_000_000,
  sessions: Array.from({ length: 12 }, (_, i) => ({
    session_id: `0a1b2c3d-${i}`, fresh_input_tokens: 21_630 * (i + 1), output_tokens: 3_400 * (i + 1), cache_read_tokens: 2_100_000 * (i + 1),
    injected_tokens: 1_900 * i, injections: i % 3, memory_share_pct: i % 4 ? 1.25 * i : null, last_activity_epoch_ms: nowMs - i * 120_000,
    cwd: i % 2 ? '/srv/work/north-harbour-telemetry-gateway-service' : '/srv/work/qx',
  })),
});
