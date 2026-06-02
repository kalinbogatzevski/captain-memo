import {
  bold, cyan, cyanBold, dim, gold, goldBold, green, red, yellow,
  padVisibleEnd, visibleWidth,
} from '../shared/ansi.ts';
import { fmtBytes, fmtElapsed } from '../shared/format.ts';
import type { EfficiencyReport } from '../worker/efficiency.ts';

export interface StatsResponse {
  total_chunks: number;
  by_channel: Record<string, number>;
  observations: { total: number; queue_pending: number; queue_processing: number };
  indexing: {
    status: 'idle' | 'indexing' | 'ready' | 'error';
    total: number;
    done: number;
    errors: number;
    started_at_epoch: number;
    finished_at_epoch: number;
    last_error: string | null;
    elapsed_s: number;
    percent: number;
  };
  project_id: string;
  version?: string;
  /** Worker liveness: boot epoch + seconds since boot. Optional — older worker
   *  payloads omit it (the line is simply not shown then). */
  worker?: { started_at_epoch: number; uptime_s: number };
  embedder: { model: string; endpoint: string };
  disk?: { bytes: number; path: string };
  efficiency?: EfficiencyReport | undefined;
  recall?: {
    surfaced_count: number;
    recalled_count: number;
    totals: { auto: number; search: number; drill: number };
    top_surfaced: RecallTopEntry[];
    top_recalled: RecallTopEntry[];
    /** Most-recently-surfaced rows (recency order) for the live pulse. Optional
     *  for back-compat with pre-v0.1.16 worker payloads. */
    recent_surfaced?: RecentSurfacedEntry[];
  };
  dream?: DreamStatsBlock;
}

interface RecallTopEntry {
  id: number;
  type: string;
  title: string;
  from_auto: number;
  from_search: number;
  from_drill: number;
  last_surfaced_at: number | null;
  /** Number of near-duplicate rows collapsed into this entry (>1 ⇒ summed).
   *  Optional: legacy payloads and the back-compat shim omit it. */
  variants?: number;
}

interface RecentSurfacedEntry {
  id: number;
  type: string;
  title: string;
  last_surfaced_at: number;
  source: 'auto' | 'search' | 'drill' | null;
}

export interface DreamStatsBlock {
  audit_log: {
    path: string;
    bytes: number;
    entries: number;
    last_entry_epoch_ms: number | null;
  };
  co_retrieval: {
    pairs: number;
    docs_covered: number;
  };
}

const DEFAULT_PANEL_WIDTH = 60;
const MIN_WIDE_PANEL = 100;     // below this we stick to single-column
const MAX_PANEL_WIDTH = 240;
const BAR_WIDTH = 20;

// COLOR DISCIPLINE (locked roles — change carefully):
//
//   goldBold   — wordmark identity only (line 1 of the panel).
//   cyanBold   — live values that change between refreshes: counts,
//                percentages, sizes, ages, ratios. The "look here" cue.
//   cyan       — section headings (no bold). Quieter than the values.
//   gold/cyan/green — RESERVED for the auto/search/drill provenance triplet
//                in Top-N entries. These three colors carry semantic
//                meaning; they must not appear elsewhere or the meaning
//                degrades into decoration.
//   green/yellow/red — status semantics only (ready/indexing/error/off).
//                Never as accent decoration.
//   dim        — labels, separators, secondary metadata, formatting
//                punctuation. The structural layer.
//   default    — body text, titles, model names, things you read once.
//
// Net effect: structure (dim) → values (cyan-bright) → status (semantic)
// → provenance (mapped triad). Four roles, no overlap.

function resolvePanelWidth(override?: number): number {
  if (typeof override === 'number') return clamp(override, 40, MAX_PANEL_WIDTH);
  const envCols = parseInt(process.env.COLUMNS ?? '', 10);
  if (Number.isFinite(envCols) && envCols > 0) return clamp(envCols, 40, MAX_PANEL_WIDTH);
  const cols = process.stdout.columns;
  if (!process.stdout.isTTY || !cols) return DEFAULT_PANEL_WIDTH;
  return clamp(cols, 40, MAX_PANEL_WIDTH);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function splitColumnWidths(totalWidth: number, gap: number): { left: number; right: number } {
  const budget = totalWidth - gap;
  const left = Math.floor(budget / 2);
  return { left, right: budget - left };
}

function twoColumn(
  left: string[], right: string[], totalWidth: number, gap = 3,
): string[] {
  const { left: lw } = splitColumnWidths(totalWidth, gap);
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const L = padVisibleEnd(left[i] ?? '', lw);
    const R = right[i] ?? '';
    out.push(L + ' '.repeat(gap) + R);
  }
  return out;
}

/** A proportional bar: ▕████░░▏. Cyan so it lines up with the panel's
 *  "live data" accent without competing with the gold wordmark. */
export function bar(fraction: number, width: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return '▕' + '█'.repeat(filled) + '░'.repeat(width - filled) + '▏';
}

/** Thousands grouping with a plain space separator: 24272 → "24 272". */
function fmtCount(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}

/** Compact engineering notation: 19057556 → "19.0 M", 15605 → "15.6 k".
 *  One space before the unit because monospaced engineering tables read
 *  more cleanly with the unit visually detached from the magnitude. */
function fmtCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  return `${(n / 1_000_000_000).toFixed(1)} B`;
}

/** "  Title ──────…" drawn to the given width. Section heads use plain
 *  cyan (no bold) so live values are visually heavier — see color
 *  discipline note at the top of the file. */
function sectionRule(title: string, panelWidth: number): string {
  const prefix = `  ${title} `;
  const dashes = '─'.repeat(Math.max(0, panelWidth - prefix.length));
  return `  ${cyan(title)} ${dim(dashes)}`;
}

function statusDot(status: StatsResponse['indexing']['status']): string {
  if (status === 'ready') return green('●');
  if (status === 'indexing') return yellow('●');
  if (status === 'error') return red('●');
  return dim('●');
}

function indexingText(idx: StatsResponse['indexing']): string {
  if (idx.status === 'idle') return 'idle (no watch paths)';
  if (idx.status === 'indexing') {
    return `indexing · ${idx.done}/${idx.total} (${idx.percent}%)`;
  }
  if (idx.status === 'ready') {
    return `ready · ${idx.done}/${idx.total} in ${fmtElapsed(idx.elapsed_s)}`
      + (idx.errors > 0 ? ` · ${idx.errors} errors` : '');
  }
  return `error · ${idx.last_error ?? 'unknown'}`;
}

/** Two-line title: wordmark on line 1, double-rule on line 2. Replaces
 *  the previous boxed header — the frame fought the content for attention
 *  and added a "decorated dashboard" feel. The double `═` differentiates
 *  the title rule from the single `─` section rules below. */
function headerPanel(version: string, panelWidth: number, headerRight?: string): string[] {
  const wordmark = '⚓  CAPTAIN MEMO';
  const subtitle = 'corpus statistics';
  const ver = `v${version}`;
  const base = `  ${goldBold(wordmark)}   ${dim(subtitle)} ${dim('·')} ${bold(ver)}`;
  // Optional right-aligned status (e.g. the `top` live clock). Reserve the final
  // column: both `base` (⚓ anchor emoji) and `headerRight` (⟳ stamp) can render
  // 1 cell wider than their code-point count, and touching the last column wraps
  // the trailing char onto the next row. Budget to panelWidth-1 to absorb it.
  const titleLine = headerRight
    ? base + ' '.repeat(Math.max(1, panelWidth - 1 - visibleWidth(base) - visibleWidth(headerRight))) + headerRight
    : base;
  // ═ matches the section-rule indent so the eye sees a continuous left
  // rail down the left edge of the panel.
  const rule = '  ' + dim('═'.repeat(Math.max(0, panelWidth - 2)));
  return [titleLine, rule];
}

export interface RenderOpts {
  panelWidth?: number;
  /** Optional right-aligned status on the header line (the `top` live clock). */
  headerRight?: string;
}

export function renderStats(stats: StatsResponse, opts: RenderOpts = {}): string[] {
  const panelWidth = resolvePanelWidth(opts.panelWidth);
  const wide = panelWidth >= MIN_WIDE_PANEL;

  const out: string[] = [];
  out.push(...headerPanel(stats.version ?? 'unknown', panelWidth, opts.headerRight));
  out.push('');

  // Status block. At narrow widths, four labeled rows. At wide widths,
  // pair (Project, Indexing) | (Embedder, Disk) so the labels stay visible
  // but the block is half as tall.
  const statusLines = renderStatusBlock(stats);
  if (wide && statusLines.length === 4) {
    const left = statusLines.slice(0, 2);
    const right = statusLines.slice(2, 4);
    out.push(...twoColumn(left, right, panelWidth));
  } else {
    out.push(...statusLines);
  }
  out.push('');

  // CORPUS + EFFICIENCY: side by side in wide mode, stacked when narrow.
  const cols = splitColumnWidths(panelWidth, 3);
  const corpusBlock = renderCorpusBlock(stats, wide ? cols.left : panelWidth, wide);
  const efficiencyBlock = stats.efficiency
    ? renderEfficiencyBlock(stats.efficiency, wide ? cols.right : panelWidth, wide)
    : [];

  if (wide && efficiencyBlock.length > 0) {
    out.push(...twoColumn(corpusBlock, efficiencyBlock, panelWidth));
    out.push('');
  } else {
    out.push(...corpusBlock);
    out.push('');
    if (efficiencyBlock.length > 0) {
      out.push(...efficiencyBlock);
      out.push('');
    }
  }

  if (stats.recall) {
    const recall = normalizeRecall(stats.recall);
    out.push(sectionRule('Recall', panelWidth));
    out.push(`   ${dim('how memory actually gets used')}`);

    // Live pulse: the single most-recently-surfaced observation. Under `top`
    // (or watch) this ticks every refresh, so the panel shows what Captain is
    // doing right now, not just all-time leaders.
    const recent = recall.recent_surfaced ?? [];
    if (recent.length > 0) {
      const top = recent[0]!;
      const age = fmtAgo(Math.max(0, Math.floor(Date.now() / 1000) - top.last_surfaced_at));
      const title = trimTitle(top.title, panelWidth - 34 - top.type.length);
      out.push(`   ${dim('Last surfaced'.padEnd(14))}${cyanBold(`${age} ago`)}`
        + ` ${dim('·')} ${dim(`[${top.type}]`)} ${title} ${dim('·')} ${sourceColored(top.source)}`);
    }

    const total = stats.observations.total;
    const { surfaced_count, recalled_count } = recall;
    if (surfaced_count === 0 && recalled_count === 0) {
      out.push(`   ${dim('Surfaced'.padEnd(14))}${dim('0')} / ${fmtCount(total)}`
        + `   ${dim('— no retrievals yet; data accumulates with use')}`);
    } else {
      const sPct = total > 0 ? ((surfaced_count / total) * 100).toFixed(1) : '0.0';
      const rPct = total > 0 ? ((recalled_count / total) * 100).toFixed(2) : '0.00';
      const drillRate = surfaced_count > 0
        ? ((recalled_count / surfaced_count) * 100).toFixed(2)
        : '0.00';
      out.push(`   ${dim('Surfaced'.padEnd(14))}${cyanBold(fmtCount(surfaced_count))}`
        + ` ${dim('/')} ${fmtCount(total)}   ${dim(`(${sPct}% of corpus)`)}`);
      out.push(`   ${dim('Recalled'.padEnd(14))}${cyanBold(fmtCount(recalled_count))}`
        + ` ${dim('/')} ${fmtCount(total)}   ${dim(`(${rPct}% of corpus)`)}`);
      out.push(`   ${dim('Drill-in rate'.padEnd(14))}${cyanBold(`${drillRate}%`)}`
        + `   ${dim(`(${recalled_count}/${surfaced_count} recalled out of surfaced)`)}`);

      const split = splitColumnWidths(panelWidth, 3);
      const hasSurfaced = recall.top_surfaced.length > 0;
      const hasRecalled = recall.top_recalled.length > 0;

      if (wide && hasSurfaced && hasRecalled) {
        const left = renderTopList('Top surfaced', recall.top_surfaced, split.left);
        const right = renderTopList('Top recalled', recall.top_recalled, split.right);
        out.push('');
        out.push(...twoColumn(left, right, panelWidth));
      } else if (wide && (hasSurfaced || hasRecalled)) {
        const heading = hasSurfaced ? 'Top surfaced' : 'Top recalled';
        const entries = hasSurfaced ? recall.top_surfaced : recall.top_recalled;
        const mid = Math.ceil(entries.length / 2);
        const left = renderTopList(heading, entries.slice(0, mid), split.left);
        const right = renderTopList(' ', entries.slice(mid), split.right);
        out.push('');
        out.push(...twoColumn(left, right, panelWidth));
      } else {
        if (hasSurfaced) {
          out.push('');
          out.push(...renderTopList('Top surfaced', recall.top_surfaced, panelWidth));
        }
        if (hasRecalled) {
          out.push('');
          out.push(...renderTopList('Top recalled', recall.top_recalled, panelWidth));
        }
      }

      // Recently surfaced — recency-ordered, distinct from the count-ranked Top
      // lists above. Two-up across columns when wide so it stays short.
      if (recent.length > 0) {
        out.push('');
        out.push(`   ${cyan('Recently surfaced'.padEnd(17))}`);
        if (wide) {
          const mid = Math.ceil(recent.length / 2);
          const left = recent.slice(0, mid).flatMap(e => renderRecentRow(e, split.left));
          const right = recent.slice(mid).flatMap(e => renderRecentRow(e, split.right));
          out.push(...twoColumn(left, right, panelWidth));
        } else {
          for (const e of recent) out.push(...renderRecentRow(e, panelWidth));
        }
      }
    }
    out.push('');
  }

  if (stats.dream) {
    out.push(sectionRule('Dream', panelWidth));
    out.push(`   ${dim('data feeding the Dreams pipeline')}`);
    const d = stats.dream;
    const corpusTotal = stats.observations.total;

    if (d.audit_log.bytes === 0 && d.audit_log.entries === 0) {
      out.push(`   ${dim('Audit log'.padEnd(14))}${red('— off')}`
        + `   ${dim('(set CAPTAIN_MEMO_RECALL_AUDIT=1 in worker.env)')}`);
    } else {
      const ageStr = d.audit_log.last_entry_epoch_ms !== null
        ? fmtAgo(Math.floor((Date.now() - d.audit_log.last_entry_epoch_ms) / 1000))
        : '—';
      out.push(`   ${dim('Audit log'.padEnd(14))}`
        + `${cyanBold(fmtBytes(d.audit_log.bytes))} ${dim('·')} ${cyanBold(fmtCount(d.audit_log.entries))} entries`
        + ` ${dim('·')} ${dim(`last ${ageStr} ago`)}`);
    }

    if (d.co_retrieval.pairs === 0) {
      out.push(`   ${dim('Co-retrieval'.padEnd(14))}${dim('0 pairs')}`
        + `   ${dim('— no co-occurring observations yet')}`);
    } else {
      const pct = corpusTotal > 0
        ? ((d.co_retrieval.docs_covered / corpusTotal) * 100).toFixed(1)
        : '0.0';
      out.push(`   ${dim('Co-retrieval'.padEnd(14))}`
        + `${cyanBold(fmtCount(d.co_retrieval.pairs))} pairs`
        + ` ${dim('·')} ${cyanBold(fmtCount(d.co_retrieval.docs_covered))} observations covered`
        + ` ${dim(`(${pct}% of corpus)`)}`);
    }
    // Inline command, no "Preview" label — the dim arrow is the affordance.
    out.push(`   ${dim('→')} ${cyan('captain-memo dream --dry-run')}`);
    out.push('');
  }

  return out;
}

/** The four-row metadata block at the top of the panel. Caller decides
 *  whether to pair them side-by-side via twoColumn. */
function renderStatusBlock(stats: StatsResponse): string[] {
  const lines: string[] = [];
  // Liveness line. renderStats only runs when /stats actually answered, so the
  // worker IS online here (when it's down, the caller shows the unreachable
  // banner instead). Surfaces uptime so a silently-restarting worker is visible.
  if (stats.worker) {
    lines.push(`  ${dim('Worker'.padEnd(10))} ${green('●')} online ${dim('·')} up ${cyanBold(fmtUptime(stats.worker.uptime_s))}`);
  }
  lines.push(
    `  ${dim('Project'.padEnd(10))} ${stats.project_id}`,
    `  ${dim('Indexing'.padEnd(10))} ${statusDot(stats.indexing.status)} ${indexingText(stats.indexing)}`,
    `  ${dim('Embedder'.padEnd(10))} ${stats.embedder.model} ${dim('·')} ${dim(stats.embedder.endpoint)}`,
  );
  if (stats.disk) {
    lines.push(`  ${dim('Disk'.padEnd(10))} ${cyanBold(fmtBytes(stats.disk.bytes))}`);
  }
  return lines;
}

function fmtAgo(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

// Compact two-unit uptime: 45s · 12m · 2h 13m · 3d 4h. Minutes matter early on
// (a worker that just restarted reads "2m", not "0 h"), so keep the finer unit.
export function fmtUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** The provenance triad applied to a surfacing source. auto=gold, search=cyan,
 *  drill=green — same mapping as the Top-N breakdown, so the colors carry the
 *  same meaning wherever a source appears. */
function sourceColored(source: 'auto' | 'search' | 'drill' | null): string {
  if (source === 'auto') return gold('auto');
  if (source === 'search') return cyan('search');
  if (source === 'drill') return green('drill');
  return dim('—');
}

function trimTitle(title: string, max: number): string {
  const m = Math.max(4, max);
  return title.length > m ? title.slice(0, m - 1) + '…' : title;
}

/** One "recently surfaced" row: age · [type] title · source. Recency order,
 *  so this is the live "what Captain is doing now" pulse, not a count ranking. */
function renderRecentRow(e: RecentSurfacedEntry, colWidth: number): string[] {
  const nowS = Math.floor(Date.now() / 1000);
  const age = fmtAgo(Math.max(0, nowS - e.last_surfaced_at)).padStart(6);
  // Visible prefix: 5 indent + 6 age + 3 (" · ") + [type] + 1 + tail " · src".
  const prefixLen = 5 + 6 + 3 + (e.type.length + 2) + 1 + 9;
  const title = trimTitle(e.title, colWidth - prefixLen);
  return [
    `     ${cyanBold(age)} ${dim('·')} ${dim(`[${e.type}]`)} ${title} ${dim('·')} ${sourceColored(e.source)}`,
  ];
}

interface LegacyRecallShape {
  ever_retrieved: number;
  top: Array<{
    id: number; type: string; title: string;
    retrieval_count: number; last_retrieved_at: number;
  }>;
}

interface ModernRecallShape {
  surfaced_count: number;
  recalled_count: number;
  totals: { auto: number; search: number; drill: number };
  top_surfaced: RecallTopEntry[];
  top_recalled: RecallTopEntry[];
  recent_surfaced?: RecentSurfacedEntry[];
}

function normalizeRecall(
  recall: ModernRecallShape | LegacyRecallShape,
): ModernRecallShape {
  if ('surfaced_count' in recall) return recall;
  const legacy = recall as LegacyRecallShape;
  const mapped: RecallTopEntry[] = legacy.top.map(t => ({
    id: t.id, type: t.type, title: t.title,
    from_auto: 0,
    from_search: t.retrieval_count,
    from_drill: 0,
    last_surfaced_at: t.last_retrieved_at,
  }));
  const totalSearch = mapped.reduce((acc, t) => acc + t.from_search, 0);
  return {
    surfaced_count: legacy.ever_retrieved,
    recalled_count: 0,
    totals: { auto: 0, search: totalSearch, drill: 0 },
    top_surfaced: mapped,
    top_recalled: [],
  };
}

/** Corpus sub-block: channel bars + total. The intermediate divider line
 *  is intentionally absent — the Total row's typography (cyanBold count,
 *  dim "observations" subtitle) provides enough separation without the
 *  decorative dash row that used to live above it. */
function renderCorpusBlock(
  stats: StatsResponse, blockWidth: number, wide: boolean,
): string[] {
  const out: string[] = [];
  out.push(sectionRule('Corpus', blockWidth));
  const channels = Object.entries(stats.by_channel);
  const maxCount = Math.max(1, ...channels.map(([, c]) => c));
  const barWidth = wide ? 16 : BAR_WIDTH;
  for (const [channel, count] of channels) {
    const b = cyan(bar(count / maxCount, barWidth));
    out.push(`   ${dim(channel.padEnd(14))}${fmtCount(count).padStart(9)}   ${b}`);
  }
  out.push(`   ${dim('Total'.padEnd(14))}${cyanBold(fmtCount(stats.total_chunks).padStart(9))}`
    + `     ${dim(`${fmtCount(stats.observations.total)} observations`)}`);
  return out;
}

/** Efficiency sub-block: compression bar + embedder + dedup. The compact
 *  `distilled` detail line now appears in BOTH modes because fmtCompact
 *  shrinks "19 057 556 tokens" to "19.0 M tok" which fits any column. */
function renderEfficiencyBlock(
  efficiency: EfficiencyReport, blockWidth: number, wide: boolean,
): string[] {
  const { corpus, embedder, dedup } = efficiency;
  const out: string[] = [];
  out.push(sectionRule('Efficiency', blockWidth));
  const barWidth = wide ? 16 : BAR_WIDTH;
  if (corpus.ratio === null || corpus.saved_pct === null) {
    out.push(`   ${dim('Compression'.padEnd(14))}${dim('— populating… (restart worker)')}`);
  } else {
    const b = green(bar(corpus.saved_pct / 100, barWidth));
    out.push(`   ${dim('Compression'.padEnd(14))}${cyanBold(`${corpus.ratio}×`.padEnd(7))}  ${b}  ${green(`${corpus.saved_pct}%`)}`);
    // Compact detail: fmtCompact keeps this under ~38 chars even at the
    // largest realistic corpus sizes, so it fits in a half-width column
    // without overflowing into the neighbor.
    out.push(`   ${' '.repeat(14)}${dim(`distilled ${fmtCompact(corpus.work_tokens)} → ${fmtCompact(corpus.stored_tokens)} tok`
      + ` · ${fmtCompact(corpus.coverage.with_data)}/${fmtCompact(corpus.coverage.total)} obs`)}`);
  }
  out.push(`   ${dim('Embedder'.padEnd(14))}` + (embedder.calls > 0
    ? `${cyanBold(String(embedder.calls))} calls ${dim('·')} ~${embedder.avg_latency_ms} ms ${dim('·')} ${fmtCount(embedder.tokens_per_s)} tok/s`
    : dim('— no embeds since worker start')));
  out.push(`   ${dim('Dedup'.padEnd(14))}` + (dedup.docs_seen > 0
    ? `${cyanBold(`${dedup.skip_pct}%`)}   ${dim(`${fmtCount(dedup.skipped_unchanged)} / ${fmtCount(dedup.docs_seen)} unchanged`)}`
    : dim('— no documents indexed since worker start')));
  return out;
}

function renderTopList(
  heading: string, entries: RecallTopEntry[], colWidth: number,
): string[] {
  const out: string[] = [];
  // Heading in cyan (matches section heads), not bold — keeps the live
  // values in the entries below visually heavier.
  out.push(`   ${cyan(heading.padEnd(14))}`);
  for (const r of entries) {
    out.push(...renderRecallEntry(r, colWidth));
  }
  return out;
}

/** Render one top-list entry: count line + provenance breakdown line.
 *  Prefix structure (visible chars): 5 + 4 + 2 + type.length + 1 = 12 + type.
 */
function renderRecallEntry(r: RecallTopEntry, colWidth = 64): string[] {
  const total = r.from_auto + r.from_search + r.from_drill;
  const count = `${total}×`.padStart(4);
  // "(+N similar)" when this entry collapsed several near-duplicate rows.
  const similar = (r.variants && r.variants > 1) ? ` (+${r.variants - 1} similar)` : '';
  const prefixLen = 12 + r.type.length + 2;
  const titleMax = Math.max(8, colWidth - prefixLen - similar.length);
  const titleTrim = r.title.length > titleMax
    ? r.title.slice(0, titleMax - 1) + '…' : r.title;

  // Provenance triplet — gold/cyan/green are RESERVED for this triad. Do
  // not borrow them for decoration anywhere else in the panel.
  const longForm =
    `${dim('auto:')} ${gold(String(r.from_auto))}   `
    + `${dim('search:')} ${cyan(String(r.from_search))}   `
    + `${dim('drill:')} ${green(String(r.from_drill))}`;
  const shortForm =
    `${dim('a:')}${gold(String(r.from_auto))} `
    + `${dim('s:')}${cyan(String(r.from_search))} `
    + `${dim('d:')}${green(String(r.from_drill))}`;
  const indent = 11;
  const breakdown = (indent + visibleWidth(longForm)) > colWidth
    ? shortForm
    : longForm;

  // Count uses cyanBold (live value); type stays dim; title is default;
  // the "(+N similar)" collapse hint is dim so it reads as metadata.
  return [
    `     ${cyanBold(count)}  ${dim(`[${r.type}]`)} ${titleTrim}${dim(similar)}`,
    `           ${breakdown}`,
  ];
}
