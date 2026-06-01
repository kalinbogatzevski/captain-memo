// src/cli/commands/top.ts
//
// `captain-memo top` — interactive, htop-style live stats. The thin impure
// shell around the pure TUI core (keys → state → frame). It owns the terminal
// (alt screen, raw mode, cursor), stdin, the refresh timer, and data fetching;
// every decision lives in the pure modules so the only untested code here is
// I/O wiring.
//
// Replaces the old `watch`-based wrapper: a real TUI can sort, filter, page and
// drill, which `watch` (a dumb reprint loop) never could.

import { workerGet } from '../client.ts';
import { renderStats, type StatsResponse } from '../stats-render.ts';
import { parseKey } from '../tui/keys.ts';
import { initialState, reduce, type TopState, type Event } from '../tui/state.ts';
import { buildFrame, type FrameData, type Dims, type RecallRowView, type DetailObs } from '../tui/frame.ts';

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const HOME = '\x1b[H';
const CLEAR_BELOW = '\x1b[J';
const CLEAR_EOL = '\x1b[K';

const HELP = `captain-memo top — interactive live stats (replaces \`watch\`)

Usage:
  captain-memo top [seconds]

Arguments:
  seconds   Initial auto-refresh interval (default 2). Adjust live with +/-.

In-app: press ? for the full key map and a glossary of terms.
Piped (non-TTY) stdout falls back to a single static stats render.
`;

const FETCH_LIMIT = 300;   // rows pulled for the table; scrolled client-side

export async function topCommand(args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return 0;
  }

  // Non-TTY (piped): degrade to a single static dashboard render.
  if (!process.stdout.isTTY) {
    try {
      const stats = await workerGet('/stats') as StatsResponse;
      for (const line of renderStats(stats)) console.log(line);
      return 0;
    } catch (err) {
      console.error(`captain-memo top: worker unreachable (${(err as Error).message})`);
      return 1;
    }
  }

  const intervalArg = args[0] ? parseFloat(args[0]) : NaN;
  let state = initialState();
  if (Number.isFinite(intervalArg) && intervalArg > 0) {
    state = { ...state, refreshMs: Math.max(500, Math.round(intervalArg * 1000)) };
  }

  const data: FrameData = {};
  let loadedDetailId: number | null = null;
  let lastError: string | null = null;
  // When the last fetch succeeded — drives the "stale since HH:MM:SS" banner so a
  // dead/zombie worker can't keep masquerading as live behind the ticking clock.
  let lastOkAtMs: number | null = null;

  // ── terminal lifecycle ────────────────────────────────────────────────────
  let torn = false;
  const teardown = () => {
    if (torn) return;
    torn = true;
    try {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
    } catch { /* ignore */ }
    process.stdout.write(CURSOR_SHOW + ALT_OFF);
  };
  // Restore the terminal no matter how we leave.
  process.on('exit', teardown);
  process.on('SIGINT', () => { teardown(); process.exit(0); });
  process.on('SIGTERM', () => { teardown(); process.exit(0); });
  process.on('uncaughtException', (err) => {
    teardown();
    console.error(err);
    process.exit(1);
  });

  process.stdout.write(ALT_ON + CURSOR_HIDE);
  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();

  const dims = (): Dims => ({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });
  const tablePageSize = (d: Dims) => Math.max(3, d.rows - 11);

  const dispatch = (ev: Event) => { state = reduce(state, ev); };

  const fetchForMode = async () => {
    // Tag this fetch with the state it was issued for. Concurrent fetches (a
    // keypress while a timer tick is in flight) all run, but we apply results
    // only if the user hasn't navigated away since — last-current-wins, never a
    // torn `data` (e.g. stats from one fetch, page from another).
    const reqSig = snapshot(state);
    try {
      let stats: StatsResponse | undefined;
      let page: { rows: RecallRowView[]; total: number } | undefined;
      let detail: DetailObs | undefined;
      let detailId: number | null = null;

      if (state.mode === 'dashboard' || state.mode === 'help') {
        stats = await workerGet('/stats') as StatsResponse;
      } else if (state.mode === 'table') {
        stats = await workerGet('/stats') as StatsResponse;
        const params = new URLSearchParams({
          view: state.view, sort: state.sort,
          limit: String(FETCH_LIMIT), offset: '0',
          collapse: state.collapse ? '1' : '0',
        });
        if (state.typeFilter) params.set('type', state.typeFilter);
        if (state.query) params.set('q', state.query);
        page = await workerGet(`/recall/list?${params.toString()}`) as { rows: RecallRowView[]; total: number };
      } else if (state.mode === 'detail') {
        // Fetch once per drill-in: /observation/full bumps from_drill, so we
        // must not re-hit it on every render or scroll.
        if (state.detailId !== null && state.detailId !== loadedDetailId) {
          const res = await workerGet(`/observation/full?id=${state.detailId}`) as { observation: DetailObs };
          detail = res.observation;
          detailId = state.detailId;
        }
      }

      if (snapshot(state) !== reqSig) return;   // user navigated away; discard stale result

      if (stats) data.stats = stats;
      if (page) { data.page = page; dispatch({ type: 'data', ids: page.rows.map(r => r.id) }); }
      if (detail) { data.detail = detail; loadedDetailId = detailId; }
      lastError = null;
      lastOkAtMs = Date.now();
    } catch (err) {
      // Strip control chars (incl. ESC) so a corrupted worker message can't
      // inject ANSI sequences into the rendered frame.
      lastError = (err as Error).message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
    }
  };

  const render = () => {
    const d = dims();
    dispatch({ type: 'resize', pageSize: tablePageSize(d) });
    // Feed liveness into the frame so it can show the prominent stale-data banner.
    data.workerUnreachable = lastError !== null;
    data.lastOkAtMs = lastOkAtMs;
    const lines = buildFrame(state, data, d);
    // Keep the raw error as a dim detail line below (the banner is the alarm; this
    // is the "why" — timed out vs. connection refused).
    if (lastError) lines.push('  \x1b[2m(worker: ' + lastError + ')\x1b[0m');
    let buf = HOME;
    for (const line of lines) buf += line + CLEAR_EOL + '\r\n';
    buf += CLEAR_BELOW;
    process.stdout.write(buf);
  };

  await fetchForMode();
  render();

  // ── refresh timer (recreated when the interval changes) ────────────────────
  let timer: ReturnType<typeof setInterval> | null = null;
  let timerMs = 0;
  const ensureTimer = () => {
    if (timerMs === state.refreshMs && timer) return;
    if (timer) clearInterval(timer);
    timerMs = state.refreshMs;
    timer = setInterval(async () => {
      // Auto-refresh only the live views; detail/help/filter-input stay put.
      if ((state.mode === 'dashboard' || state.mode === 'table') && !state.filter.active) {
        await fetchForMode();
        render();
      }
    }, timerMs);
  };
  ensureTimer();

  process.stdout.on('resize', render);

  // ── input loop ──────────────────────────────────────────────────────────────
  await new Promise<void>((resolve) => {
    process.stdin.on('data', async (chunk: string) => {
      let buf = chunk;
      let modeBefore = state.mode;
      let needFetch = false;
      // Snapshot the fetch-affecting fields to decide whether to refetch.
      const before = snapshot(state);
      while (buf.length > 0) {
        const { key, rest } = parseKey(buf);
        buf = rest;
        dispatch({ type: 'key', key });
        if (state.quit) {
          if (timer) clearInterval(timer);
          teardown();
          resolve();
          return;
        }
      }
      const after = snapshot(state);
      needFetch = modeBefore !== state.mode || before !== after;
      if (needFetch) await fetchForMode();
      ensureTimer();
      render();
    });
  });

  return 0;
}

/** A cheap signature of the fetch-affecting state, so we only re-query the
 *  worker when something that changes the data actually changed. */
function snapshot(s: TopState): string {
  return [s.mode, s.view, s.sort, s.typeFilter, s.query, s.collapse, s.detailId].join('|');
}
