import {
  bold, cyan, cyanBold, dim, gold, goldBold, green, red, yellow,
  padVisibleEnd,
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
  embedder: { model: string; endpoint: string };
  disk?: { bytes: number; path: string };
  efficiency?: EfficiencyReport | undefined;
  recall?: {
    /** Distinct observations bumped by ANY source (auto/search/drill). */
    surfaced_count: number;
    /** Distinct observations bumped by /get_full (drill). */
    recalled_count: number;
    /** Grand totals per source, useful for sanity-checking the breakdown. */
    totals: { auto: number; search: number; drill: number };
    /** Top observations by total bumps across all sources. */
    top_surfaced: RecallTopEntry[];
    /** Top observations by drill-in count — the strongest "actually used" signal. */
    top_recalled: RecallTopEntry[];
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
// MAX_PANEL_WIDTH used to be 132 (legacy "wide screen" limit). Users with
// modern ultra-wide monitors complained the panel left a dead zone on the
// right edge instead of expanding to fill their terminal — exactly the
// behavior `captain-memo watch` was supposed to deliver. Lifted to 240
// which covers any realistic terminal; sanity cap remains to defend
// against the runaway-COLUMNS env-var failure mode.
const MAX_PANEL_WIDTH = 240;
const BAR_WIDTH = 20;

/** Resolve the panel width in order of precedence:
 *   1. Explicit `--width` override (passed via opts.panelWidth)
 *   2. $COLUMNS environment variable (honored even when stdout is piped — lets
 *      users export COLUMNS=140 to force wide rendering in tmux / SSH chains
 *      where TTY detection lies)
 *   3. process.stdout.columns when stdout is a real TTY
 *   4. DEFAULT_PANEL_WIDTH (60) when stdout is piped — keeps log captures
 *      compact and grep-friendly. */
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

/** Compute the (left, right) column widths that exactly add up to
 *  `totalWidth - gap`. When the budget is odd, the EXTRA char goes to the
 *  RIGHT column — that keeps both columns visually identical when paired
 *  with the panel's header border, which always renders to totalWidth. */
function splitColumnWidths(totalWidth: number, gap: number): { left: number; right: number } {
  const budget = totalWidth - gap;
  const left = Math.floor(budget / 2);
  return { left, right: budget - left };
}

/** Render two side-by-side blocks of (possibly ANSI-colored) lines, sized to
 *  `totalWidth` with `gap` spaces between them. Short blocks are padded out;
 *  the longer of the two determines vertical span. Visible-width-aware so
 *  ANSI escapes don't disturb the column boundary. */
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

/** A proportional bar: ▕████░░▏. `fraction` is clamped to [0,1]. */
export function bar(fraction: number, width: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return '▕' + '█'.repeat(filled) + '░'.repeat(width - filled) + '▏';
}

/** Thousands grouping with a plain space separator: 24272 → "24 272". */
function fmtCount(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}

/** "  TITLE ──────…" drawn to the given width. */
function sectionRule(title: string, panelWidth: number): string {
  const prefix = `  ${title} `;
  const dashes = '─'.repeat(Math.max(0, panelWidth - prefix.length));
  return `  ${cyanBold(title)} ${dim(dashes)}`;
}

/** The status dot, coloured by indexing state. */
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

function headerPanel(version: string, panelWidth: number): string[] {
  const inner = panelWidth - 2;
  const border = '─'.repeat(inner);
  // ⚓ is one string char but renders 2 terminal columns — count one extra.
  const wordmark = '⚓  CAPTAIN MEMO';        // 15 chars, 16 columns
  const subtitle = '        corpus statistics   ·   ';
  const ver = `v${version}`;
  const usedCols = 2 /* indent */ + wordmark.length + 1 /* ⚓ extra */
    + subtitle.length + ver.length;
  const pad = ' '.repeat(Math.max(1, inner - usedCols));
  const content = '  ' + goldBold(wordmark) + dim(subtitle) + bold(ver) + pad;
  return [
    cyanBold('╭' + border + '╮'),
    cyanBold('│') + content + cyanBold('│'),
    cyanBold('╰' + border + '╯'),
  ];
}

export interface RenderOpts {
  /** Explicit panel width override — used in tests to lock behavior in a
   *  width-independent way. In production, leave undefined and the terminal
   *  width is auto-detected. */
  panelWidth?: number;
}

export function renderStats(stats: StatsResponse, opts: RenderOpts = {}): string[] {
  const panelWidth = resolvePanelWidth(opts.panelWidth);
  const wide = panelWidth >= MIN_WIDE_PANEL;

  const out: string[] = [];
  out.push(...headerPanel(stats.version ?? 'unknown', panelWidth));
  out.push('');
  out.push(`  ${dim('Project'.padEnd(10))} ${cyan(stats.project_id)}`);
  out.push(`  ${dim('Indexing'.padEnd(10))} ${statusDot(stats.indexing.status)} ${indexingText(stats.indexing)}`);
  out.push(`  ${dim('Embedder'.padEnd(10))} ${cyan(stats.embedder.model)} ${dim('·')} ${dim(stats.embedder.endpoint)}`);
  if (stats.disk) {
    out.push(`  ${dim('Disk'.padEnd(10))} ${gold(fmtBytes(stats.disk.bytes))}`);
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

  // RECALL — how memory actually gets used. Three lenses:
  //   Surfaced    = observation appeared in ANY retrieval response
  //   Recalled    = observation was fetched in full via /get_full
  //   Drill-in %  = recalled / surfaced — how often surfacing converts to use
  // Each top entry also shows its provenance breakdown (auto/search/drill)
  // so a popular row is distinguishable from a passively-matched one.
  //
  // Cross-version compatibility: if the worker is still on the pre-v5 shape
  // (ever_retrieved + top[]), map it forward into the new shape so the CLI
  // never crashes during a half-deployed upgrade window. Old data is treated
  // as from_search bumps since pre-v5 only /search/* and /get_full bumped
  // the legacy counter, with /search/* being the dominant path.
  if (stats.recall) {
    const recall = normalizeRecall(stats.recall);
    out.push(sectionRule('RECALL', panelWidth));
    out.push(`   ${dim('tracks how memory actually gets used')}`);
    const total = stats.observations.total;
    const { surfaced_count, recalled_count } = recall;
    if (surfaced_count === 0 && recalled_count === 0) {
      out.push(`   ${'Surfaced'.padEnd(14)}${dim('0')} / ${fmtCount(total)}`
        + `   ${dim('— no retrievals yet; data accumulates with use')}`);
    } else {
      const sPct = total > 0 ? ((surfaced_count / total) * 100).toFixed(1) : '0.0';
      const rPct = total > 0 ? ((recalled_count / total) * 100).toFixed(2) : '0.00';
      const drillRate = surfaced_count > 0
        ? ((recalled_count / surfaced_count) * 100).toFixed(2)
        : '0.00';
      out.push(`   ${'Surfaced'.padEnd(14)}${goldBold(fmtCount(surfaced_count))}`
        + ` ${dim('/')} ${fmtCount(total)}   ${dim(`(${sPct}% of corpus)`)}`);
      out.push(`   ${'Recalled'.padEnd(14)}${green(fmtCount(recalled_count))}`
        + ` ${dim('/')} ${fmtCount(total)}   ${dim(`(${rPct}% of corpus)`)}`);
      out.push(`   ${'Drill-in rate'.padEnd(14)}${cyanBold(`${drillRate}%`)}`
        + `   ${dim(`(${recalled_count}/${surfaced_count} recalled out of surfaced)`)}`);

      const split = splitColumnWidths(panelWidth, 3);
      const hasSurfaced = recall.top_surfaced.length > 0;
      const hasRecalled = recall.top_recalled.length > 0;

      if (wide && hasSurfaced && hasRecalled) {
        // Both lists populated → side by side.
        const left = renderTopList('Top surfaced', recall.top_surfaced, split.left);
        const right = renderTopList('Top recalled', recall.top_recalled, split.right);
        out.push('');
        out.push(...twoColumn(left, right, panelWidth));
      } else if (wide && (hasSurfaced || hasRecalled)) {
        // Only one list populated → split its entries across two columns so
        // we still consume the available horizontal space. Halves vertical
        // height for the common early-data case where drill is empty.
        const heading = hasSurfaced ? 'Top surfaced' : 'Top recalled';
        const entries = hasSurfaced ? recall.top_surfaced : recall.top_recalled;
        const mid = Math.ceil(entries.length / 2);
        const left = renderTopList(heading, entries.slice(0, mid), split.left);
        const right = renderTopList(' ', entries.slice(mid), split.right);
        out.push('');
        out.push(...twoColumn(left, right, panelWidth));
      } else {
        // Narrow mode (or both empty) → original stacked layout.
        if (hasSurfaced) {
          out.push('');
          out.push(...renderTopList('Top surfaced', recall.top_surfaced, panelWidth));
        }
        if (hasRecalled) {
          out.push('');
          out.push(...renderTopList('Top recalled', recall.top_recalled, panelWidth));
        }
      }
    }
    out.push('');
  }

  // DREAM — cheap precursor diagnostics for the Local Dreaming pipeline.
  // Surfaces the inputs the dry-run depends on (audit log liveness, co-
  // retrieval pair density) WITHOUT running clustering. The actual cluster
  // preview lives in `captain-memo dream --dry-run`.
  if (stats.dream) {
    out.push(sectionRule('DREAM', panelWidth));
    out.push(`   ${dim('tracks the data feeding the Dreams pipeline')}`);
    const d = stats.dream;
    const corpusTotal = stats.observations.total;

    if (d.audit_log.bytes === 0 && d.audit_log.entries === 0) {
      out.push(`   ${'Audit log'.padEnd(14)}${red('— off')}`
        + `   ${dim('(set CAPTAIN_MEMO_RECALL_AUDIT=1 in worker.env)')}`);
    } else {
      const ageStr = d.audit_log.last_entry_epoch_ms !== null
        ? fmtAgo(Math.floor((Date.now() - d.audit_log.last_entry_epoch_ms) / 1000))
        : '—';
      out.push(`   ${'Audit log'.padEnd(14)}`
        + `${gold(fmtBytes(d.audit_log.bytes))} ${dim('·')} ${cyan(fmtCount(d.audit_log.entries))} entries`
        + ` ${dim('·')} ${dim(`last ${ageStr} ago`)}`);
    }

    if (d.co_retrieval.pairs === 0) {
      out.push(`   ${'Co-retrieval'.padEnd(14)}${dim('0 pairs')}`
        + `   ${dim('— no co-occurring observations yet')}`);
    } else {
      const pct = corpusTotal > 0
        ? ((d.co_retrieval.docs_covered / corpusTotal) * 100).toFixed(1)
        : '0.0';
      out.push(`   ${'Co-retrieval'.padEnd(14)}`
        + `${goldBold(fmtCount(d.co_retrieval.pairs))} pairs`
        + ` ${dim('·')} ${green(fmtCount(d.co_retrieval.docs_covered))} observations covered`
        + ` ${dim(`(${pct}% of corpus)`)}`);
    }
    out.push(`   ${'Preview'.padEnd(14)}${cyanBold('captain-memo dream --dry-run')}`);
    out.push('');
  }

  return out;
}

/** Human-readable "N units ago" for an age in seconds. Coarse and tiny —
 *  matches the size profile of fmtElapsed in shared/format.ts. */
function fmtAgo(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

/** Legacy pre-v5 recall shape. Kept here for the back-compat shim only —
 *  new code should never construct one of these. */
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
}

/** Map either the pre-v5 (ever_retrieved/top) shape or the current
 *  (surfaced/recalled/provenance) shape into the current shape. Lets the
 *  CLI render correctly during an upgrade window where the worker is one
 *  version behind. Detection key: presence of `surfaced_count`. */
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

/** CORPUS sub-block: channel bars + total. Block is sized to `blockWidth`
 *  visible columns — the caller decides whether that's full panel or a half. */
function renderCorpusBlock(
  stats: StatsResponse, blockWidth: number, wide: boolean,
): string[] {
  const out: string[] = [];
  out.push(sectionRule('CORPUS', blockWidth));
  const channels = Object.entries(stats.by_channel);
  const maxCount = Math.max(1, ...channels.map(([, c]) => c));
  const barWidth = wide ? 16 : BAR_WIDTH;   // slightly tighter in wide cols
  for (const [channel, count] of channels) {
    const b = gold(bar(count / maxCount, barWidth));
    out.push(`   ${channel.padEnd(14)}${fmtCount(count).padStart(9)}   ${b}`);
  }
  out.push(`   ${dim('─'.repeat(23))}`);
  out.push(`   ${'Total'.padEnd(14)}${goldBold(fmtCount(stats.total_chunks).padStart(9))}`
    + `     ${dim(`${fmtCount(stats.observations.total)} observations`)}`);
  return out;
}

/** EFFICIENCY sub-block: compression bar + embedder + dedup. In wide mode
 *  the detail line under Compression is omitted because the half-width
 *  column can't render the full token counts without overflowing into the
 *  CORPUS column. The secondary numbers stay accessible via --json. */
function renderEfficiencyBlock(
  efficiency: EfficiencyReport, blockWidth: number, wide: boolean,
): string[] {
  const { corpus, embedder, dedup } = efficiency;
  const out: string[] = [];
  out.push(sectionRule('EFFICIENCY', blockWidth));
  const barWidth = wide ? 16 : BAR_WIDTH;
  if (corpus.ratio === null || corpus.saved_pct === null) {
    out.push(`   ${'Compression'.padEnd(14)}${dim('— populating… (restart worker)')}`);
  } else {
    const b = green(bar(corpus.saved_pct / 100, barWidth));
    out.push(`   ${'Compression'.padEnd(14)}${goldBold(`${corpus.ratio}×`.padEnd(7))}  ${b}  ${green(`${corpus.saved_pct}%`)}`);
    if (!wide) {
      // Detail line: full token counts in dim. Verbose — drop it in wide
      // mode where the half-width column can't hold it without overflow.
      out.push(`   ${' '.repeat(14)}${dim(`distilled ${fmtCount(corpus.work_tokens)} → ${fmtCount(corpus.stored_tokens)} tokens`
        + ` · ${corpus.coverage.with_data}/${corpus.coverage.total} obs`)}`);
    }
  }
  out.push(`   ${'Embedder'.padEnd(14)}` + (embedder.calls > 0
    ? `${cyan(String(embedder.calls))} calls ${dim('·')} ~${embedder.avg_latency_ms} ms ${dim('·')} ${fmtCount(embedder.tokens_per_s)} tok/s`
    : dim('— no embeds since worker start')));
  out.push(`   ${'Dedup'.padEnd(14)}` + (dedup.docs_seen > 0
    ? `${cyanBold(`${dedup.skip_pct}%`)}   ${dim(`${fmtCount(dedup.skipped_unchanged)} / ${fmtCount(dedup.docs_seen)} unchanged`)}`
    : dim('— no documents indexed since worker start')));
  return out;
}

/** One Top-N list as a sub-block. Title trim adapts to the column width so
 *  side-by-side mode (narrower) doesn't bleed into the right column. */
function renderTopList(
  heading: string, entries: RecallTopEntry[], colWidth: number,
): string[] {
  const out: string[] = [];
  out.push(`   ${bold(heading.padEnd(14))}`);
  // Reserve room for "     N×  [type] " prefix (~13 chars) + title; trim to fit.
  const titleMax = Math.max(20, colWidth - 16);
  for (const r of entries) {
    out.push(...renderRecallEntry(r, titleMax));
  }
  return out;
}

/** Render one top-list entry: count line + provenance breakdown line. */
function renderRecallEntry(r: RecallTopEntry, titleMax = 48): string[] {
  const titleTrim = r.title.length > titleMax
    ? r.title.slice(0, titleMax - 1) + '…' : r.title;
  const total = r.from_auto + r.from_search + r.from_drill;
  const count = `${total}×`.padStart(4);
  const breakdown =
    `${dim('auto:')} ${gold(String(r.from_auto))}   `
    + `${dim('search:')} ${cyan(String(r.from_search))}   `
    + `${dim('drill:')} ${green(String(r.from_drill))}`;
  return [
    `     ${goldBold(count)}  ${dim(`[${r.type}]`)} ${titleTrim}`,
    `           ${breakdown}`,
  ];
}
