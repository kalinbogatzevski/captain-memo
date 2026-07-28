// src/cli/tui/frame.ts
//
// Pure frame builder for the `top` TUI: (state, data, dims) → lines. No I/O.
// The shell fetches the right data for the current mode and asks this module
// to render it; selection highlighting, paging windows, and column alignment
// all live here so they can be unit-tested without a terminal.

import {
  bold, boldRed, cyan, cyanBold, dim, gold, green, padVisibleEnd, visibleWidth,
} from '../../shared/ansi.ts';
import { renderStats, renderSourceBars, type StatsResponse } from '../stats-render.ts';
import { LOGS_DIR } from '../../shared/paths.ts';
import type { TopState } from './state.ts';

export interface RecallRowView {
  id: number;
  type: string;
  title: string;
  from_auto: number;
  from_search: number;
  from_drill: number;
  total: number;
  last_surfaced_at: number | null;
  last_surfaced_source: 'auto' | 'search' | 'drill' | null;
  variants: number;
}

export interface DetailObs {
  id: number;
  type: string;
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  from_auto: number;
  from_search: number;
  from_drill: number;
  last_surfaced_at: number | null;
  last_surfaced_source: 'auto' | 'search' | 'drill' | null;
  created_at_epoch: number;
  /** Originating AI tool (codex/agy/gemini/…), or null/absent for legacy rows. */
  origin_agent?: string | null;
}

/** One live session's spend and memory's share of it, as GET /sessions/usage
 *  reports it. `memory_share_pct` is null when the session has no fresh tokens
 *  yet — rendered as '—' rather than 0%, which would claim a measurement. */
export interface SessionUsageRow {
  session_id: string;
  fresh_input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  injected_tokens: number;
  injections: number;
  memory_share_pct: number | null;
  last_activity_epoch_ms: number;
  /** Working directory the session runs in — the only reliable human label. */
  cwd?: string;
}

export interface FrameData {
  stats?: StatsResponse;
  /** Live per-session token flow (the [m] tab). Absent until that tab is opened. */
  sessions?: { window_ms: number; sessions: SessionUsageRow[] };
  page?: { rows: RecallRowView[]; total: number };
  detail?: DetailObs;
  /** The most recent worker fetch failed — everything on screen is the last-good
   *  snapshot, not live. Drives the prominent stale-data banner so a dead/zombie
   *  worker can't masquerade as live (the clock keeps ticking regardless). */
  workerUnreachable?: boolean;
  /** When the last successful fetch landed (epoch ms), shown in the banner. */
  lastOkAtMs?: number | null;
}

export interface Dims {
  cols: number;
  rows: number;
}

const VIEW_LABEL: Record<string, string> = {
  surfaced: 'Surfaced', recalled: 'Recalled', recent: 'Recent',
};

export function buildFrame(state: TopState, data: FrameData, dims: Dims): string[] {
  const frame = (() => {
    switch (state.mode) {
      case 'dashboard':  return dashboardFrame(state, data, dims);
      case 'table':      return tableFrame(state, data, dims);
      case 'detail':     return detailFrame(state, data, dims);
      case 'help':       return helpFrame(state, dims);
      case 'sources':    return sourcesFrame(state, data, dims);
      case 'tokens':     return tokensFrame(state, data, dims);
    }
  })();
  // A dead/zombie worker keeps the last-good stats on screen with a live clock —
  // which reads as "live". Prepend a loud banner on EVERY mode so staleness is
  // impossible to miss (replaces the old easy-to-overlook dim footnote).
  if (data.workerUnreachable) {
    return [...unreachableBanner(dims.cols, data.lastOkAtMs ?? null), ...frame];
  }
  return frame;
}

/** Fit a frame to the terminal, keeping the two header rows and the hint bar pinned
 *  and dropping from the bottom of the body.
 *
 *  Without this the render loop wrote every line from HOME and let the alt-screen
 *  buffer scroll, so a panel taller than the terminal pushed its own wordmark off the
 *  top — the user saw the BOTTOM of the dashboard and had no way to tell. It also made
 *  every row-count change (a queue row appearing when work arrives) move the whole
 *  screen. Pure and exported so the invariant is unit-testable. */
export function clipFrame(lines: string[], rows: number): string[] {
  if (rows <= 0) return [];
  if (lines.length <= rows) return lines;
  const HEAD = 2, TAIL = 1;
  // Too short to hold the pinned rows themselves — take what fits from the top rather
  // than emit head+tail and overflow anyway.
  if (rows <= HEAD + TAIL) return lines.slice(0, rows);
  return [
    ...lines.slice(0, HEAD),
    ...lines.slice(HEAD, HEAD + (rows - HEAD - TAIL)),
    ...lines.slice(-TAIL),
  ];
}

/** The prominent "data is stale" banner shown while the worker is unreachable.
 *  Pure + exported so its wording is unit-testable. `lastOkAtMs` is formatted as
 *  a wall-clock time (HH:MM:SS) so the user can see how old the on-screen data is. */
/** Where to actually look when the worker is down — per platform, and naming a file that
 *  EXISTS. This was hardcoded to "~/.captain-memo/logs/worker.log": wrong directory on
 *  macOS (the LaunchAgent wrote to ~/Library/Logs), wrong filename everywhere (the daemon
 *  writes captain-memo-worker.log), and wrong mechanism on Linux, where systemd sends the
 *  worker's output to the journal and no such file is ever created. The first macOS user
 *  went looking for a directory that did not exist while his real logs sat elsewhere. */
export function workerLogHint(): string {
  if (process.platform === 'linux') return 'see `journalctl --user -u captain-memo-worker -n 50`';
  return `see ${LOGS_DIR}/captain-memo-worker.err.log`;
}

export function unreachableBanner(cols: number, lastOkAtMs: number | null): string[] {
  let when = '';
  if (lastOkAtMs) {
    const d = new Date(lastOkAtMs);
    const p = (n: number) => String(n).padStart(2, '0');
    when = ` · last ok ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  const msg = `⚠ WORKER UNREACHABLE — data below is STALE${when} · ${workerLogHint()}`;
  // Pad across the panel so the colored bar spans the width and dominates the eye.
  return [boldRed(' ' + padVisibleEnd(msg, Math.max(0, cols - 2)))];
}

// ── shared bits ────────────────────────────────────────────────────────────

function fmtAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function sourceColored(source: 'auto' | 'search' | 'drill' | null): string {
  if (source === 'auto') return gold('auto');
  if (source === 'search') return cyan('search');
  if (source === 'drill') return green('drill');
  return dim('—');
}

function trimTo(s: string, max: number): string {
  const m = Math.max(1, max);
  return s.length > m ? s.slice(0, m - 1) + '…' : s;
}

/** Live clock + refresh interval, so the user can SEE the data updating: it
 *  re-renders on every refresh tick. Frozen in paused modes (detail/help),
 *  which is itself a useful "not refreshing right now" signal. */
function liveStamp(refreshMs: number): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const sec = refreshMs % 1000 === 0 ? String(refreshMs / 1000) : (refreshMs / 1000).toFixed(1);
  return `⟳ ${date} ${time} · every ${sec}s`;
}

/** Place `right` flush against the right edge after `left` (both may be
 *  colored). `left` includes its own leading indent. */
function spread(left: string, right: string, cols: number): string {
  // Reserve the final column. `right` (the live stamp) contains ambiguous-width
  // glyphs (⟳, ·) that some terminals/fonts render 1 cell wider than their
  // code-point count; writing into the last column then triggers auto-margin
  // wrap and the trailing char spills onto the next row. Budgeting to cols-1
  // absorbs that single-cell undercount. visibleWidth() is left untouched so
  // alignment elsewhere (rows, separators) is unaffected.
  const pad = Math.max(1, cols - 1 - visibleWidth(left) - visibleWidth(right));
  return left + ' '.repeat(pad) + right;
}

// Fixed table column widths. Shared by the header and every data row so the
// numeric columns line up exactly. Title flexes to fill the remainder.
const COUNT_W = 6;
const TYPE_W = 11;   // widest is "[discovery]" = 11
const NUM_W = 5;
const AGE_W = 6;
function tableTitleWidth(cols: number): number {
  // 2 lead + count + type + 3 numeric + age, plus 6 single-space gaps.
  return Math.max(12, cols - (2 + COUNT_W + TYPE_W + NUM_W * 3 + AGE_W + 6));
}

/** A dim hint bar: "  [k]label  [k]label …". Bracketed keys stay readable. */
function hintBar(parts: string[]): string {
  return '  ' + parts.map(p => dim(p)).join('  ');
}

function ruleLine(cols: number): string {
  return '  ' + dim('─'.repeat(Math.max(0, cols - 2)));
}

// ── dashboard ────────────────────────────────────────────────────────────────

function dashboardFrame(state: TopState, data: FrameData, dims: Dims): string[] {
  const body = data.stats
    ? renderStats(data.stats, {
        panelWidth: dims.cols,
        headerRight: dim(liveStamp(state.refreshMs)),
      })
    : [dim('  (worker unreachable)')];
  return [
    ...body,
    '',
    hintBar(['[s]urfaced', '[r]ecalled', '[n]recent', '[a]I-sources', '[m]tokens', '[+/-]rate', '[?]help', '[q]uit']),
  ];
}

// The AI-sources tab: observations per originating AI tool, as a bar chart.
// Reuses the same renderer as `captain-memo stats`, but full-width and focused.
function sourcesFrame(state: TopState, data: FrameData, dims: Dims): string[] {
  const cols = dims.cols;
  const out: string[] = [];
  out.push(spread(`  ${gold('⚓')} ${cyanBold('AI sources')} ${dim('· observations per AI tool')}`,
    dim(liveStamp(state.refreshMs)), cols));
  out.push(ruleLine(cols));
  out.push('');
  const byOrigin = data.stats?.observations.by_origin;
  if (!byOrigin || Object.keys(byOrigin).length === 0) {
    out.push('  ' + dim('(no observations yet — sessions from codex/agy/gemini/kimi/opencode land here)'));
  } else {
    const barWidth = Math.max(16, Math.min(60, cols - 40));
    out.push(...renderSourceBars(byOrigin, barWidth));
  }
  out.push('');
  out.push(hintBar(['[s]urfaced', '[r]ecalled', '[n]recent', '[a/Esc]back', '[+/-]rate', '[?]help', '[q]uit']));
  return out;
}

// ── live per-session token flow ────────────────────────────────────────────

/** Compact token count for a narrow column: 21630 → "21.6k", 2.1e6 → "2.1M". */
function tok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function tokensFrame(state: TopState, data: FrameData, dims: Dims): string[] {
  const cols = dims.cols;
  const out: string[] = [
    spread(`  ${cyanBold('CAPTAIN MEMO')} ${dim('top — live token flow')}`, dim(liveStamp(state.refreshMs)), cols),
    ruleLine(cols),
    '',
  ];
  const rows = data.sessions?.sessions ?? [];
  if (rows.length === 0) {
    out.push('  ' + dim('(no sessions active in the window — a session appears once it writes a message)'));
    out.push('');
    out.push(hintBar(['[m/Esc]back', '[+/-]rate', '[?]help', '[q]uit']));
    return out;
  }

  const mins = Math.round((data.sessions?.window_ms ?? 0) / 60_000);
  out.push(`  ${dim(`sessions active in the last ${mins} min · fresh = input + cache-write, what actually entered the context`)}`);
  out.push('');
  out.push('  ' + dim('session   ') + dim('    fresh in') + dim('      out') + dim('  cache-read')
    + dim('    memory') + dim('  share') + dim('  last') + dim('  project'));

  for (const r of rows.slice(0, Math.max(3, dims.rows - 10))) {
    // '—' rather than 0% when there is no measurement: a session that has not been
    // injected into is not one where memory cost nothing, it is one with no data.
    const share = r.memory_share_pct === null || r.injections === 0
      ? dim('     —')
      : `${r.memory_share_pct.toFixed(2)}%`.padStart(6);
    const mem = r.injections === 0 ? dim('—'.padStart(9)) : cyanBold(tok(r.injected_tokens).padStart(9));
    const age = fmtAge(Math.max(0, Math.floor((Date.now() - r.last_activity_epoch_ms) / 1000)));
    // Project basename, not the full path — the leaf is what distinguishes sessions,
    // and several panes routinely share a long common prefix.
    const proj = r.cwd ? r.cwd.split('/').filter(Boolean).pop() ?? '' : '';
    out.push('  ' + r.session_id.slice(0, 8) + '  '
      + tok(r.fresh_input_tokens).padStart(12)
      + tok(r.output_tokens).padStart(9)
      + dim(tok(r.cache_read_tokens).padStart(12))
      + mem + '  ' + share + '  ' + dim(age.padStart(5))
      + '  ' + dim(proj.slice(0, Math.max(8, dims.cols - 76))));
  }

  out.push('');
  out.push('  ' + dim('cache-read is the same context re-sent each turn — it dwarfs fresh, so share is of fresh'));
  out.push('');
  out.push(hintBar(['[s]urfaced', '[r]ecalled', '[a]I-sources', '[m/Esc]back', '[+/-]rate', '[?]help', '[q]uit']));
  return out;
}

// ── table ────────────────────────────────────────────────────────────────────

function tableFrame(state: TopState, data: FrameData, dims: Dims): string[] {
  const out: string[] = [];
  const cols = dims.cols;

  // Compact summary header from /stats.
  const r = data.stats?.recall;
  const obsTotal = data.stats?.observations.total ?? 0;
  if (r) {
    const sPct = obsTotal > 0 ? ((r.surfaced_count / obsTotal) * 100).toFixed(1) : '0.0';
    const summary = `  ${cyanBold('CAPTAIN MEMO')} ${dim('top')}   `
      + `${dim('surfaced')} ${cyanBold(String(r.surfaced_count))} ${dim(`(${sPct}%)`)}   `
      + `${dim('recalled')} ${cyanBold(String(r.recalled_count))}   `
      + `${dim('corpus')} ${cyanBold(String(obsTotal))}`;
    out.push(spread(summary, dim(liveStamp(state.refreshMs)), cols));   // clock, right-aligned
    const recent = r.recent_surfaced ?? [];
    if (recent[0]) {
      const top = recent[0];
      const age = fmtAge(Math.max(0, Math.floor(Date.now() / 1000) - top.last_surfaced_at));
      out.push(`  ${dim('last surfaced')} ${cyanBold(`${age} ago`)} ${dim('·')} `
        + `${dim(`[${top.type}]`)} ${trimTo(top.title, cols - 36)} ${dim('·')} ${sourceColored(top.source)}`);
    }
  }
  out.push(ruleLine(cols));

  // Status / controls line.
  const typeLabel = state.typeFilter ?? 'all';
  const filterLabel = state.filter.active
    ? `${bold(state.filter.buffer)}${cyan('▏')}`
    : (state.query ? state.query : dim('—'));
  const total = data.page?.total ?? 0;
  const shown = data.page?.rows.length ?? 0;
  // total = pre-collapse match count; in collapse mode also show group count.
  const rowsLabel = state.collapse ? `${total} rows → ${shown} groups` : `${total} rows`;
  out.push(`  ${dim('VIEW')} ${cyan(VIEW_LABEL[state.view] ?? state.view)}   `
    + `${dim('SORT')} ${cyan(state.sort)}   `
    + `${dim('TYPE')} ${cyan(typeLabel)}   `
    + `${dim('FILTER')} ${filterLabel}   `
    + `${dim(rowsLabel)}`);
  out.push(ruleLine(cols));

  // Column header — shared widths with the data rows so columns line up.
  const titleW = tableTitleWidth(cols);
  out.push('  ' + dim(
    'COUNT'.padStart(COUNT_W) + ' ' + 'TYPE'.padEnd(TYPE_W) + ' '
    + 'TITLE'.padEnd(titleW) + ' '
    + 'AUTO'.padStart(NUM_W) + ' ' + 'SRCH'.padStart(NUM_W) + ' '
    + 'DRL'.padStart(NUM_W) + ' ' + 'AGE'.padStart(AGE_W),
  ));

  // Rows (page window). Plain cells are padded to the fixed widths, then
  // colored — color escapes don't affect the padded visible width.
  const rows = data.page?.rows ?? [];
  const window = rows.slice(state.scroll, state.scroll + state.pageSize);
  for (let i = 0; i < window.length; i++) {
    const row = window[i]!;
    const isSel = (state.scroll + i) === state.selection;
    const marker = isSel ? cyan('▸') : ' ';
    const suffix = row.variants > 1 ? ` (+${row.variants - 1})` : '';
    const titlePlain = (trimTo(row.title, titleW - suffix.length) + suffix).padEnd(titleW);
    const ageStr = row.last_surfaced_at
      ? fmtAge(Math.max(0, Math.floor(Date.now() / 1000) - row.last_surfaced_at))
      : '—';
    const cells =
      cyanBold(`${row.total}×`.padStart(COUNT_W)) + ' '
      + dim(`[${row.type}]`.padEnd(TYPE_W)) + ' '
      + (isSel ? bold(titlePlain) : titlePlain) + ' '
      + gold(String(row.from_auto).padStart(NUM_W)) + ' '
      + cyan(String(row.from_search).padStart(NUM_W)) + ' '
      + green(String(row.from_drill).padStart(NUM_W)) + ' '
      + dim(ageStr.padStart(AGE_W));
    out.push(` ${marker}${cells}`);
  }
  if (window.length === 0) out.push('  ' + dim('(no rows — try [t]ype/[/]filter, or [Tab] another view)'));

  // Pad to push the footer near the bottom, then the hint bar.
  out.push('');
  out.push(hintBar([
    '[↑↓]select', '[⏎]open', '[Tab]view', '[a]I-sources', '[o]sort', '[t]ype', '[/]find',
    '[c]ollapse', '[Esc]back', '[?]help', '[q]uit',
  ]));
  return out;
}

// ── detail ───────────────────────────────────────────────────────────────────

function wrap(text: string, width: number): string[] {
  const w = Math.max(8, width);
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    if (cur === '') { cur = word; continue; }
    if ((cur + ' ' + word).length > w) { lines.push(cur); cur = word; }
    else cur += ' ' + word;
  }
  if (cur) lines.push(cur);
  return lines;
}

function detailFrame(state: TopState, data: FrameData, dims: Dims): string[] {
  const obs = data.detail;
  if (!obs) return ['', '  ' + dim('loading observation…'), '', hintBar(['[Esc]back', '[q]uit'])];

  const cols = dims.cols;
  const out: string[] = [];
  out.push(spread(`  ${dim(`[${obs.type}]`)} ${bold(obs.title)}`, dim(liveStamp(state.refreshMs)), cols));
  out.push(ruleLine(cols));
  const total = obs.from_auto + obs.from_search + obs.from_drill;
  const age = obs.last_surfaced_at
    ? fmtAge(Math.max(0, Math.floor(Date.now() / 1000) - obs.last_surfaced_at)) + ' ago'
    : 'never';
  out.push(`  ${dim('surfaced')} ${cyanBold(`${total}×`)}  ${dim('·')}  `
    + `${dim('auto')} ${gold(String(obs.from_auto))} ${dim('search')} ${cyan(String(obs.from_search))} ${dim('drill')} ${green(String(obs.from_drill))}  ${dim('·')}  `
    + `${dim('last')} ${cyanBold(age)} ${dim('via')} ${sourceColored(obs.last_surfaced_source)}`);
  const created = new Date(obs.created_at_epoch * 1000).toISOString().slice(0, 10);
  const origin = obs.origin_agent && obs.origin_agent !== 'unknown'
    ? `  ${dim('·')}  ${dim('source')} ${cyan(obs.origin_agent)}` : '';
  out.push(`  ${dim('created')} ${created}${origin}`);
  const files = [...obs.files_modified, ...obs.files_read];
  if (files.length > 0) out.push(`  ${dim('files')} ${dim(trimTo(files.join(', '), cols - 10))}`);
  out.push('');

  const bodyLines: string[] = [];
  for (const line of wrap(obs.narrative, cols - 4)) bodyLines.push('  ' + line);
  if (obs.facts.length > 0) {
    bodyLines.push('');
    for (const f of obs.facts) for (const l of wrap(`• ${f}`, cols - 6)) bodyLines.push('  ' + l);
  }
  if (obs.concepts.length > 0) {
    bodyLines.push('');
    bodyLines.push('  ' + dim('concepts: ') + dim(obs.concepts.join(', ')));
  }
  // Scroll window over the body.
  const visible = bodyLines.slice(state.detailScroll);
  out.push(...visible);

  out.push('');
  out.push(hintBar(['[↑↓]scroll', '[Esc]back', '[q]uit']));
  return out;
}

// ── help ─────────────────────────────────────────────────────────────────────

function helpFrame(state: TopState, dims: Dims): string[] {
  const cols = dims.cols;
  const H = (s: string) => `  ${cyan(s)}`;
  const row = (keys: string, desc: string) => `    ${cyanBold(padVisibleEnd(keys, 14))} ${dim(desc)}`;
  const term = (name: string, desc: string) => `    ${gold(padVisibleEnd(name, 14))} ${dim(desc)}`;
  return [
    spread(`  ${cyanBold('CAPTAIN MEMO')} ${dim('top — help')}`, dim(liveStamp(state.refreshMs)), cols),
    ruleLine(cols),
    H('Navigation'),
    row('s / r / n', 'open the Surfaced / Recalled / Recent table'),
    row('↑ ↓  or j k', 'move the selection'),
    row('PgUp PgDn', 'page through the list'),
    row('g / G', 'jump to top / bottom'),
    row('⏎ Enter', 'open the selected observation (counts as a drill)'),
    row('Esc', 'back one level (detail → table → dashboard)'),
    '',
    H('Shape the table'),
    row('Tab', 'cycle view: Surfaced ▸ Recalled ▸ Recent'),
    row('o', 'cycle sort: total ▸ auto ▸ search ▸ drill ▸ recency'),
    row('t', 'cycle the observation-type filter'),
    row('/', 'type to filter by title; Enter applies, Esc cancels'),
    row('c', 'toggle near-duplicate collapse'),
    row('+ / -', 'faster / slower auto-refresh'),
    row('? ', 'this help    ·    q  quit'),
    '',
    H('Reading the stats'),
    term('Compression', 'raw session tokens ÷ stored — how hard the summarizer distilled'),
    term('Dedup', '% of re-indexed docs skipped as unchanged (hash match)'),
    term('AI sources', 'which tool authored each obs (claude/codex/agy/…)'),
    term('Surfaced', 'an observation was shown to Claude (auto/search/drill)'),
    term('Recalled', 'its full text was opened — the strongest "useful" signal'),
    term('Drill-in rate', 'Recalled ÷ Surfaced'),
    term('surfacing', 'auto (hook) · search (/search) · drill (full open)'),
    term('Tide', 'recency×stability re-rank · floor = min relevance kept'),
    term('Strengthened', 'observations whose stability grew from being recalled'),
    term('Dream', 'co-retrieval pairs feeding the Dreams pipeline'),
    `    ${dim('Full glossary →')} ${cyan('captain-memo.ispcq.com/glossary.html')}`,
    '',
    hintBar(['[Esc]back', '[?]close', '[q]uit']),
  ];
}
