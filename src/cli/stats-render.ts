import {
  bold, cyan, cyanBold, dim, gold, goldBold, green, red, yellow,
  padVisibleEnd, visibleWidth,
} from '../shared/ansi.ts';
import { fmtBytes, fmtElapsed } from '../shared/format.ts';
import type { EfficiencyReport } from '../worker/efficiency.ts';

export interface StatsResponse {
  total_chunks: number;
  by_channel: Record<string, number>;
  observations: {
    total: number; queue_pending: number; queue_processing: number;
    /** Dead-lettered rows (retries exhausted). Optional — pre-0.27.18 payloads omit it. */
    queue_failed?: number;
    /** Observation count per originating AI agent. Optional — pre-0.26.3 payloads omit it. */
    by_origin?: Record<string, number>;
  };
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
  /** The ACTIVE summarizer (resolved provider, post-fallback). Optional — pre-0.25.1 payloads omit it.
   *  `enabled` only means "a provider resolved at boot" — it stays true through an outage, so the
   *  health fields below are what actually answer "is it summarizing right now, and if not why". */
  summarizer?: {
    provider: string; model: string | null; enabled: boolean;
    /** Backing off after a transient failure (429/5xx/network); no batch is attempted until then. */
    cooling_down?: boolean;
    /** When the cooldown lifts. Optional — pre-0.27.18 payloads omit it. */
    cooldown_until_epoch?: number;
    /** Verbatim last summarize failure, so the reason is visible without journalctl. */
    last_error?: string | null;
    /** Consecutive overloaded cycles — drives the exponential backoff. */
    consecutive_failures?: number;
  };
  embedder: { model: string; endpoint: string };
  disk?: { bytes: number; path: string };
  efficiency?: EfficiencyReport | undefined;
  /** Provider-reported token spend on this machine: what the window cost, and what
   *  every transcript on disk has cost. Absent when no transcripts exist. */
  native_tokens?: {
    window?: { sessions: number; window_ms: number; window_fresh_tokens: number;
               window_output_tokens: number; window_cache_read_tokens: number } | undefined;
    all_time?: { sessions: number; agents?: number; oldest_epoch_ms?: number;
                 fresh_tokens: number; output_tokens: number;
                 cache_read_tokens: number } | null | undefined;
  } | undefined;
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
  /** Quartermaster housekeeping. Optional — pre-v0.27.48 payloads omit these. */
  qm?: { enabled: boolean; dedup_enabled: boolean; cosine_threshold: number; last_run: QmRunBlock | null };
  supersede?: { enabled?: boolean; cosine_threshold?: number; links: number; last_run?: QmRunBlock | null };
  semantic?: { enabled: boolean; cosine_threshold: number; min_idle_seconds: number; last_run: QmRunBlock | null };
  theme?: { enabled: boolean; cosine_threshold: number; min_members: number; live: number; last_run: QmRunBlock | null };
  /** Countdown to the next idle window. Optional — pre-v0.27.56 payloads omit it. */
  idle?: {
    seconds_since_activity: number;
    min_idle_seconds: number;
    eligible: boolean;
    /** Live signals holding the pass back right now, e.g. ['queue', 'co-session']. */
    blocked_by: string[];
    /** Seconds left in a forced window (`consolidate --for`), 0 when not forcing. */
    forced_seconds_left?: number;
  };
  /** Tide lifecycle snapshot. Optional — pre-v0.5.3 worker payloads omit it. */
  tide?: {
    enabled: boolean;
    /** Phase 2 auto-tiering. Optional — pre-v0.5.4 payloads omit it. */
    tiering_enabled?: boolean;
    relevance_floor: number;
    strengthened: number;
    by_state: { active: number; dormant: number; archived: number };
    anchored: number;
    max_stability_days: number | null;
  };
  dream?: DreamStatsBlock;
}

/** One persisted Quartermaster run, as /stats reports it. */
interface QmRunBlock {
  id: number; job: string; startedAt: number; finishedAt: number | null;
  rowsScanned: number; merges: number; skippedNoVector: number;
  abortedForIngest: boolean; errored: boolean;
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
  /** Optional so an older worker (pre-0.27.23) still renders — the block just
   *  omits the Injected line rather than showing a fabricated zero. */
  injected?: {
    tokens: number;
    injections: number;
    since_epoch_ms: number | null;
  };
}

const DEFAULT_PANEL_WIDTH = 60;
const MIN_WIDE_PANEL = 100;     // below this we stick to single-column
// Minimum panel width for a side-by-side pair: 2 × the wider block's content plus
// the 3-column gap, so a paired block is never squeezed below its natural width —
// it stacks instead. Measured 2026-07-27: Tide 71 and Dream 68, after the
// percentages dropped their "of corpus" suffix.
const PAIR_TIDE_DREAM = 145;
// The status block pairs on the same principle, minus the Embedder row: its
// widest halves are Indexing (~39) and Summarizer (~49), but a paused summarizer
// carries a much longer note, so the threshold stays generous.
const PAIR_STATUS = 137;
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

/** Short absolute date for a measurement epoch: "27 Jul", or "27 Jul 2025" once
 *  it is no longer the current year. Absolute rather than relative on purpose —
 *  "since 27 Jul" states when a counter started; "since 3 days ago" would drift
 *  every time the panel re-renders and reads as an age, not an origin. */
function fmtSince(epochMs: number): string {
  const d = new Date(epochMs);
  const day = d.getDate();
  const mon = d.toLocaleString('en-US', { month: 'short' });
  const year = d.getFullYear();
  return year === new Date().getFullYear() ? `${day} ${mon}` : `${day} ${mon} ${year}`;
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

  // Status block. Stacked when narrow; at wide widths `head` (Worker, Project,
  // Indexing) pairs with `tail` (Summarizer, Disk) so the labels stay visible but
  // the block is two rows shorter. `embedder` always takes its own full-width row:
  // with a queue tail it reaches ~101 columns and a half-panel would wrap it.
  const st = renderStatusBlock(stats, panelWidth);
  if (wide && panelWidth >= PAIR_STATUS && st.tail.length > 0) {
    out.push(...twoColumn(st.head, st.tail, panelWidth), st.embedder);
  } else {
    out.push(...st.head, st.embedder, ...st.tail);
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

  // TOKENS — what this machine spent with the provider. Sits directly under Efficiency
  // because the two answer adjacent questions: what memory costs to store, and what the
  // work costs to run.
  if (stats.native_tokens) {
    out.push(...renderTokensBlock(stats.native_tokens, panelWidth));
    out.push('');
  }

  // AI sources — observations per originating AI tool (codex/agy/gemini/kimi/
  // opencode/claude-code). Only when the worker reports the breakdown. Built here,
  // emitted at the foot of the panel: it has a dedicated `top` tab ([a]), so it is
  // the right section to lose first when a short terminal clips the frame.
  const byOrigin = stats.observations.by_origin;
  const sourcesBlock = byOrigin != null && Object.keys(byOrigin).length > 0
    ? renderSourcesBlock(byOrigin, panelWidth, wide)
    : [];

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
        + ` ${dim('/')} ${fmtCount(total)}   ${dim(`(${sPct}%)`)}`);
      out.push(`   ${dim('Recalled'.padEnd(14))}${cyanBold(fmtCount(recalled_count))}`
        + ` ${dim('/')} ${fmtCount(total)}   ${dim(`(${rPct}%)`)}`);
      out.push(`   ${dim('Drill-in rate'.padEnd(14))}${cyanBold(`${drillRate}%`)}`
        + `   ${dim(`(${recalled_count}/${surfaced_count} recalled out of surfaced)`)}`);

      // What that surfacing COST. Surfaced/Recalled say how often memory was used;
      // without this they are half an argument — usefulness with no price beside it.
      // The "since" is load-bearing, not decoration: injected_tokens only started
      // being recorded in 0.27.23, so this total is NOT all-time and must never be
      // read as one. It is derived from the first measured entry, so it needs no
      // config and cannot go stale.
      const inj = stats.dream?.injected;
      if (inj && inj.injections > 0) {
        const avg = Math.round(inj.tokens / inj.injections);
        const since = inj.since_epoch_ms !== null ? fmtSince(inj.since_epoch_ms) : '—';
        out.push(`   ${dim('Injected'.padEnd(14))}${cyanBold(fmtCompact(inj.tokens))} ${dim('tok')}`
          + ` ${dim('·')} ${fmtCount(inj.injections)} ${dim('injections')}`
          + ` ${dim('·')} ${dim(`~${fmtCount(avg)} avg`)}`
          + `   ${dim(`since ${since}`)}`);
      }

      const split = splitColumnWidths(panelWidth, 3);
      const hasSurfaced = recall.top_surfaced.length > 0;
      const hasRecalled = recall.top_recalled.length > 0;

      if (wide && hasSurfaced && hasRecalled) {
        const left = renderTopList('Top surfaced', recall.top_surfaced, split.left, totalRank);
        const right = renderTopList('Top recalled', recall.top_recalled, split.right, drillRank);
        out.push('');
        out.push(...twoColumn(left, right, panelWidth));
      } else if (wide && (hasSurfaced || hasRecalled)) {
        const heading = hasSurfaced ? 'Top surfaced' : 'Top recalled';
        const entries = hasSurfaced ? recall.top_surfaced : recall.top_recalled;
        const rank = hasSurfaced ? totalRank : drillRank;
        const mid = Math.ceil(entries.length / 2);
        const left = renderTopList(heading, entries.slice(0, mid), split.left, rank);
        const right = renderTopList(' ', entries.slice(mid), split.right, rank);
        out.push('');
        out.push(...twoColumn(left, right, panelWidth));
      } else {
        if (hasSurfaced) {
          out.push('');
          out.push(...renderTopList('Top surfaced', recall.top_surfaced, panelWidth, totalRank));
        }
        if (hasRecalled) {
          out.push('');
          out.push(...renderTopList('Top recalled', recall.top_recalled, panelWidth, drillRank));
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

  // Housekeeping — full width, above the Tide/Dream pair. These four passes mutate the corpus,
  // so they sit above the sections that merely describe it. Omitted whole on an older worker
  // payload rather than shown as an empty header.
  if (stats.qm || stats.supersede || stats.semantic || stats.theme) {
    out.push(...renderHousekeepingBlock(stats, panelWidth));
    out.push('');
  }

  // Tide │ Dream — side by side when the panel affords it. Both are 5 rows and
  // neither fills half a wide panel on its own, so stacking them cost 6 rows for
  // nothing.
  out.push(...pairBlocks(
    stats.tide ? renderTideBlock(stats.tide, stats.observations.total, pairWidth(panelWidth)) : [],
    stats.dream ? renderDreamBlock(stats.dream, stats.observations.total, pairWidth(panelWidth)) : [],
    stats.tide ? renderTideBlock(stats.tide, stats.observations.total, panelWidth) : [],
    stats.dream ? renderDreamBlock(stats.dream, stats.observations.total, panelWidth) : [],
    panelWidth, PAIR_TIDE_DREAM,
  ));

  if (sourcesBlock.length > 0) out.push(...sourcesBlock, '');

  return out;
}

/** Half of the panel, the width each block in a pair is rendered at. */
function pairWidth(panelWidth: number): number {
  return splitColumnWidths(panelWidth, 3).left;
}

/** Emit two sibling blocks side by side when the panel affords it, stacked otherwise.
 *  Callers pass each block twice — rendered at column width and at full width — because
 *  a block draws its own section rule to whatever width it was handed, so the two forms
 *  are not interchangeable. An empty block (a section this payload doesn't have) makes
 *  its partner render full width rather than sit in a half with a hole beside it. */
function pairBlocks(
  leftCol: string[], rightCol: string[],
  leftFull: string[], rightFull: string[],
  panelWidth: number, minPanel: number,
): string[] {
  if (leftCol.length > 0 && rightCol.length > 0 && panelWidth >= minPanel) {
    return [...twoColumn(leftCol, rightCol, panelWidth), ''];
  }
  const out: string[] = [];
  if (leftFull.length > 0) out.push(...leftFull, '');
  if (rightFull.length > 0) out.push(...rightFull, '');
  return out;
}

/** Housekeeping — the four consolidation passes. Each is invisible without this: they run on
 *  their own timers, and before this block the only way to tell whether one had ever done
 *  anything was to read /stats JSON or query qm_runs by hand. */
function renderHousekeepingBlock(stats: StatsResponse, blockWidth: number): string[] {
  const out: string[] = [];
  out.push(sectionRule('Housekeeping', blockWidth));
  out.push(`   ${dim('consolidation passes — all reversible, none delete')}`);

  const master = stats.qm?.enabled !== false;
  // A pass reads as off when its own switch is off OR the master switch is. Distinguishing
  // "disabled" from "enabled but idle" is the whole point of the block.
  const state = (on: boolean | undefined): string =>
    !master || on === false ? red('off') : green('on');
  const run = (r: QmRunBlock | null | undefined, unit: string): string => {
    if (!r) return dim('never run');
    const ago = fmtAgo(Math.max(0, Math.floor(Date.now() / 1000) - r.startedAt));
    const errored = r.errored ? ' ' + red('errored') : '';
    return `${cyanBold(String(r.merges))} ${unit} ${dim(`· ${r.rowsScanned} scanned · ${ago} ago`)}${errored}`;
  };

  if (stats.qm) {
    out.push(`   ${dim('Dedup'.padEnd(12))}${state(stats.qm.dedup_enabled)}  `
      + `${dim(`cos ${stats.qm.cosine_threshold}`)}   ${run(stats.qm.last_run, 'folded')}`);
  }
  if (stats.supersede) {
    const links = `${cyanBold(fmtCount(stats.supersede.links))} ${dim('link(s)')}`;
    out.push(`   ${dim('Supersede'.padEnd(12))}${state(stats.supersede.enabled)}  `
      + `${dim(`cos ${stats.supersede.cosine_threshold ?? '—'}`)}   ${links}`);
  }
  if (stats.semantic) {
    out.push(`   ${dim('Semantic'.padEnd(12))}${state(stats.semantic.enabled)}  `
      + `${dim(`cos ${stats.semantic.cosine_threshold}`)}   ${run(stats.semantic.last_run, 'folded')}`);
  }
  if (stats.theme) {
    const live = `${cyanBold(String(stats.theme.live))} ${dim('live')}`;
    out.push(`   ${dim('Themes'.padEnd(12))}${state(stats.theme.enabled)}  `
      + `${dim(`cos ${stats.theme.cosine_threshold}`)}   ${live}`
      + (stats.theme.live > 0 ? `   ${dim('→ captain-memo theme list')}` : ''));
  }
  // The countdown. "Runs after 30 min of no activity" states the rule but never how long is
  // left — and because ANY recall resets the clock, the honest answer moves minute to minute.
  // Naming a live blocker instead of counting down matters: a countdown that keeps ticking
  // while a batch is running promises something that cannot happen.
  if (stats.idle) {
    const i = stats.idle;
    let value: string;
    // A forced window outranks both the countdown and the blockers: it says the passes ARE
    // running on every tick, which is neither "waiting" nor "in N minutes".
    if ((i.forced_seconds_left ?? 0) > 0) {
      value = `${gold('forcing')} ${dim('· every tick for the next')} ${cyanBold(fmtLeft(i.forced_seconds_left!))}`;
    } else if (i.blocked_by.length > 0) {
      value = `${yellow('waiting')} ${dim('on')} ${cyanBold(i.blocked_by.join(', '))}`;
    } else if (i.eligible) {
      value = `${green('eligible now')} ${dim('· starts on the next check')}`;
    } else {
      const left = Math.max(0, i.min_idle_seconds - i.seconds_since_activity);
      value = `in ${cyanBold(fmtLeft(left))} ${dim(`· quiet for ${fmtLeft(i.seconds_since_activity)} of ${fmtLeft(i.min_idle_seconds)}`)}`;
    }
    out.push(`   ${dim('Next pass'.padEnd(12))}${value}`);
    out.push(`   ${dim('Any recall resets the clock — the passes only run when you are away.')}`);
  } else if (stats.semantic) {
    const mins = Math.round(stats.semantic.min_idle_seconds / 60);
    out.push(`   ${dim(`Semantic and Themes run only after ${mins} min of no activity.`)}`);
  }
  return out;
}

/** Coarse duration for the countdown: minutes below an hour, then h+m. Seconds would flicker
 *  on every refresh without telling anyone anything useful. */
function fmtLeft(sec: number): string {
  if (sec < 60) return '<1m';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}


function renderDreamBlock(
  dream: DreamStatsBlock, corpusTotal: number, blockWidth: number,
): string[] {
  const out: string[] = [];
  out.push(sectionRule('Dream', blockWidth));
  out.push(`   ${dim('data feeding the Dreams pipeline')}`);
  const d = dream;

  if (d.audit_log.bytes === 0 && d.audit_log.entries === 0) {
    // NOT red "— off" any more: the audit is on by default, so an empty log means "nothing has been
    // retrieved yet", not "you forgot to switch it on". Red on a fresh install read as a fault and sent
    // people looking for a setting to change.
    out.push(`   ${dim('Audit log'.padEnd(14))}${dim('— no retrievals yet')}`
      + `   ${dim('(fills as memory is surfaced; CAPTAIN_MEMO_RECALL_AUDIT=0 disables it)')}`);
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
    // docs_covered counts doc_ids from EVERY channel (memory, skill, observation, remote) — it was
    // labelled "observations" and divided by the OBSERVATION count alone, which both misnames the set and
    // lets the percentage exceed 100%. Clamp: the denominator is a floor, not an exact corpus size.
    const pct = corpusTotal > 0
      ? Math.min(100, (d.co_retrieval.docs_covered / corpusTotal) * 100).toFixed(1)
      : '0.0';
    out.push(`   ${dim('Co-retrieval'.padEnd(14))}`
      + `${cyanBold(fmtCount(d.co_retrieval.pairs))} pairs`
      + ` ${dim('·')} ${cyanBold(fmtCount(d.co_retrieval.docs_covered))} observations`
      + ` ${dim(`(${pct}%)`)}`);
  }
  // Inline command, no "Preview" label — the dim arrow is the affordance.
  out.push(`   ${dim('→')} ${cyan('captain-memo dream --dry-run')}`);
  return out;
}

/** The metadata rows at the top of the panel, grouped by how they lay out rather
 *  than returned as one flat list — the caller can then pair `head` against `tail`
 *  without index arithmetic over an array of pre-rendered strings.
 *
 *  `head`     Worker / Project / Indexing — short rows, the left column.
 *  `embedder` always its own full-width row: with a queue tail it is the widest
 *             row on the panel (~101 columns) and would wrap inside a half.
 *  `tail`     Summarizer (+ its reason line) and Disk — the right column. */
function renderStatusBlock(stats: StatsResponse, panelWidth: number): {
  head: string[]; embedder: string; tail: string[];
} {
  const head: string[] = [];
  // Liveness line. renderStats only runs when /stats actually answered, so the
  // worker IS online here (when it's down, the caller shows the unreachable
  // banner instead). Surfaces uptime so a silently-restarting worker is visible.
  if (stats.worker) {
    head.push(`  ${dim('Worker'.padEnd(10))} ${green('●')} online ${dim('·')} up ${cyanBold(fmtUptime(stats.worker.uptime_s))}`);
  }
  head.push(
    `  ${dim('Project'.padEnd(10))} ${stats.project_id}`,
    `  ${dim('Indexing'.padEnd(10))} ${statusDot(stats.indexing.status)} ${indexingText(stats.indexing)}`,
  );

  const embedder = `  ${dim('Embedder'.padEnd(10))} ${stats.embedder.model} ${dim('·')} ${dim(stats.embedder.endpoint)}`
    + queueTail(stats.observations);

  const tail = renderSummarizerLines(stats.summarizer, panelWidth);
  if (stats.disk) {
    tail.push(`  ${dim('Disk'.padEnd(10))} ${cyanBold(fmtBytes(stats.disk.bytes))}`);
  }
  return { head, embedder, tail };
}

/** Which summarizer is ACTUALLY running (resolved, post-fallback) — the answer to "is it codex
 *  or agy?" that used to require reading the worker log. `enabled:false` means the provider
 *  resolved but no transport was built (e.g. claude-oauth with no login) → nothing is summarized. */
function renderSummarizerLines(
  s: StatsResponse['summarizer'], panelWidth: number,
): string[] {
  if (!s) return [];
  const out: string[] = [];
  const model = s.model ? dim(` · ${s.model}`) : '';
  // Three states, not two. `enabled` alone stayed GREEN through a 21h rate-limit
  // outage (2026-07-26) because it only reports "a provider resolved at boot".
  // A paused summarizer is the state users actually need to see.
  let dot: string;
  let note: string;
  if (!s.enabled) {
    dot = yellow('○');
    note = dim(' (resolved, but NOT summarizing — check its login/config)');
  } else if (s.cooling_down) {
    dot = red('●');
    const left = s.cooldown_until_epoch
      ? Math.max(0, s.cooldown_until_epoch - Math.floor(Date.now() / 1000))
      : 0;
    const when = left > 0 ? `, retries in ${fmtUptime(left)}` : ', retrying now';
    const streak = s.consecutive_failures && s.consecutive_failures > 1
      ? ` after ${s.consecutive_failures} failures`
      : '';
    note = red(` · paused${streak}${when}`);
  } else {
    dot = green('●');
    note = '';
  }
  out.push(`  ${dim('Summarizer'.padEnd(10))} ${dot} ${cyanBold(s.provider)}${model}${note}`);
  // The verbatim reason. Shown whenever one exists — a summarizer that has
  // recovered still explains the gap in the observation timeline.
  if (s.last_error) {
    const label = s.cooling_down ? 'reason' : 'last error';
    const room = Math.max(20, panelWidth - 20 - label.length);
    out.push(`  ${' '.repeat(10)} ${dim('↳')} ${dim(`${label}:`)} ${red(trimTitle(s.last_error, room))}`);
  }
  return out;
}

/** Observation backlog, rendered as a tail on the Embedder line instead of its
 *  own row: under `top` the queue appears and disappears between refreshes, and
 *  a whole extra row shoved the rest of the panel down a line each time it did.
 *  '' when nothing is queued — the counts were always in /stats, so 2 949
 *  observations stuck behind a dead summarizer must never look like idle. */
export interface SummarizerState {
  /** Is a summarizer wired at all? Without one the drain is a no-op (worker index.ts:736) and the
   *  queue can only grow. */
  available: boolean;
  /** Last summarizer failure, already carried on /stats and never rendered until now. */
  last_error: string | null;
  /** Milliseconds until the backoff expires; 0 when not in cooldown. */
  cooldown_ms: number;
}

/** The queue line, WITH the reason it is not draining.
 *
 *  The old comment here said "2 949 observations stuck behind a dead summarizer must never look like
 *  idle", and showing the count achieved half of that. A user looking at 30,000 waiting still could not
 *  tell a backlog being worked through from a queue that will never move — and /stats has carried
 *  summarizer.last_error the whole time with nothing rendering it. A number without its cause reads as
 *  damage; with the cause it reads as a to-do, or as nothing to do at all. */
export function queueTailFor(q: StatsResponse['observations'], sum: SummarizerState): string {
  const failed = q.queue_failed ?? 0;
  if (q.queue_pending <= 0 && q.queue_processing <= 0 && failed <= 0) return '';
  const parts = [`${cyanBold(fmtCount(q.queue_pending))} ${dim('waiting')}`];
  if (q.queue_processing > 0) parts.push(`${cyanBold(fmtCount(q.queue_processing))} ${dim('in flight')}`);
  if (failed > 0) parts.push(`${red(fmtCount(failed))} ${dim('failed')}`);
  let why = '';
  if (!sum.available) {
    why = `   ${red('stalled')} ${dim('— no summarizer configured, so nothing can process this')}`;
  } else if (sum.cooldown_ms > 0) {
    const secs = Math.max(1, Math.round(sum.cooldown_ms / 1000));
    why = `   ${dim(`retry in ${secs}s`)}${sum.last_error ? dim(` — ${sum.last_error.slice(0, 80)}`) : ''}`;
  }
  return `   ${dim('Queue')} ${parts.join(dim(' · '))}${why}`;
}

function queueTail(q: StatsResponse['observations']): string {
  return queueTailFor(q, { available: true, last_error: null, cooldown_ms: 0 });
}

/** Tide sub-block: the memory-lifecycle re-rank state. Meaningful even when off
 *  (then Strengthened stays 0). `strengthened` is the live signal — every recall
 *  that folds the stability strengthening ticks it up, so under `top`/watch it
 *  climbs with use. Colors follow the panel discipline: green ● = on (status),
 *  cyanBold = live counts, dim = labels/metadata. */
function renderTideBlock(
  tide: NonNullable<StatsResponse['tide']>, corpusTotal: number, panelWidth: number,
): string[] {
  const out: string[] = [];
  out.push(sectionRule('Tide', panelWidth));
  out.push(`   ${dim('memory lifecycle — recency × stability re-rank')}`);

  if (tide.enabled) {
    const tiering = tide.tiering_enabled
      ? ` ${dim('·')} ${dim('tiering')} ${green('on')}`
      : ` ${dim('·')} ${dim('tiering off')}`;
    out.push(`   ${dim('Status'.padEnd(14))}${green('●')} on`
      + `   ${dim(`floor ${tide.relevance_floor.toFixed(2)}`)}${tiering}`);
  } else {
    out.push(`   ${dim('Status'.padEnd(14))}${dim('○ off')}`
      + `   ${dim('(flat recency decay; set CAPTAIN_MEMO_TIDE_ENABLED=1)')}`);
  }

  // Strengthened: rows whose stability_days a recall has written. Mirrors the
  // Recall "Surfaced" row typography; max stability rides alongside when present.
  const sPct = corpusTotal > 0 ? ((tide.strengthened / corpusTotal) * 100).toFixed(1) : '0.0';
  let strengthened = `   ${dim('Strengthened'.padEnd(14))}${cyanBold(fmtCount(tide.strengthened))}`
    + ` ${dim('/')} ${fmtCount(corpusTotal)}   ${dim(`(${sPct}%)`)}`;
  if (tide.max_stability_days !== null) {
    strengthened += `   ${dim('· max stability')} ${cyanBold(`${tide.max_stability_days.toFixed(1)} d`)}`;
  }
  out.push(strengthened);

  // Tiers: active/dormant/archived. The MVP holds everything in active; dormant
  // and archived populate once Phase 2 (Tide tiering) lands — shown now so the
  // transition is visible the moment it begins.
  const { active, dormant, archived } = tide.by_state;
  let tiers = `   ${dim('Tiers'.padEnd(14))}`
    + `${cyanBold(fmtCount(active))} ${dim('active')}`
    + ` ${dim('·')} ${cyanBold(fmtCount(dormant))} ${dim('dormant')}`
    + ` ${dim('·')} ${cyanBold(fmtCount(archived))} ${dim('archived')}`;
  if (tide.anchored > 0) {
    tiers += ` ${dim('·')} ${cyanBold(fmtCount(tide.anchored))} ${dim('anchored')}`;
  }
  out.push(tiers);
  return out;
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

const ORIGIN_LABEL: Record<string, string> = { unknown: '(unclassified)' };

/** Origins ordered by count desc, but 'unknown' (legacy/unclassified) always
 *  last so the real AI tools lead. Zero-count origins dropped. */
export function orderedOrigins(byOrigin: Record<string, number>): Array<[string, number]> {
  return Object.entries(byOrigin)
    .filter(([, n]) => n > 0)
    .sort((a, b) => (a[0] === 'unknown' ? 1 : b[0] === 'unknown' ? -1 : b[1] - a[1]));
}

/** The AI-sources bar chart body (no section rule). Cyan bars (the panel's
 *  live-data accent — the reserved gold/cyan/green triad stays for provenance),
 *  scaled to the max count, with count + % of total. Shared by `stats` and the
 *  `top` Sources tab. */
export function renderSourceBars(byOrigin: Record<string, number>, barWidth: number): string[] {
  // Legacy pre-capture observations carry no origin_agent (null → 'unknown'), but
  // Captain Memo was Claude-Code-only before cross-AI capture — so they ARE Claude
  // Code. Fold them in rather than showing a big "(unclassified)" bucket.
  const folded: Record<string, number> = {};
  for (const [o, n] of Object.entries(byOrigin)) {
    const key = o === 'unknown' ? 'claude-code' : o;
    folded[key] = (folded[key] ?? 0) + n;
  }
  const entries = orderedOrigins(folded);
  if (entries.length === 0) return [`   ${dim('— no observations yet')}`];
  const total = entries.reduce((a, [, n]) => a + n, 0);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return entries.map(([origin, n]) => {
    const pct = total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';
    const label = ORIGIN_LABEL[origin] ?? origin;
    return `   ${dim(label.padEnd(14))}${fmtCount(n).padStart(9)}   ${cyan(bar(n / max, barWidth))}  ${dim(`${pct}%`)}`;
  });
}

function renderSourcesBlock(byOrigin: Record<string, number>, blockWidth: number, wide: boolean): string[] {
  return [sectionRule('AI sources', blockWidth), ...renderSourceBars(byOrigin, wide ? 16 : BAR_WIDTH)];
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
    // "since worker start" belongs on BOTH branches. It appeared only when the counter was zero, so
    // the moment there was data to read the window silently vanished and the numbers read as lifetime.
    out.push(`   ${dim('Embedder'.padEnd(14))}` + (embedder.calls > 0
      ? `${cyanBold(String(embedder.calls))} calls ${dim('·')} ~${embedder.avg_latency_ms} ms ${dim('·')} ${fmtCount(embedder.tokens_per_s)} tok/s ${dim('since worker start')}`
      : dim('— no embeds since worker start')));
    out.push(`   ${dim('Dedup'.padEnd(14))}` + (dedup.docs_seen > 0
      ? `${cyanBold(`${dedup.skip_pct}%`)}   ${dim(`${fmtCount(dedup.skipped_unchanged)} / ${fmtCount(dedup.docs_seen)} unchanged since worker start`)}`
      : dim('— no documents indexed since worker start')));
  return out;
}

/** Token spend: what you are CHARGED for, window and all-time, cache reads stated
 *  apart. "Tokens" alone is meaningless when every figure here is tokens — the two
 *  things that distinguish them are the scope and whether they bill at full rate, so
 *  both go in the visible label. Cache reads bill at roughly a tenth of input and on a
 *  real corpus are 95%+ of the raw count, so folding them in would produce a headline
 *  dominated by the cheapest tokens and correlated with nothing anyone pays. */
function renderTokensBlock(
  nt: NonNullable<StatsResponse['native_tokens']>, blockWidth: number,
): string[] {
  const out: string[] = [];
  out.push(sectionRule('Tokens', blockWidth));
  const w = nt.window;
  if (w && (w.window_fresh_tokens + w.window_output_tokens) > 0) {
    const mins = Math.max(1, Math.round(w.window_ms / 60000));
    const billed = w.window_fresh_tokens + w.window_output_tokens;
    out.push(`   ${dim(`Last ${mins}m`.padEnd(14))}${cyanBold(`${fmtCompact(billed)} tok`.padEnd(14))}`
      + dim(`${fmtCompact(w.window_fresh_tokens)} in + ${fmtCompact(w.window_output_tokens)} out`
        + ` · ${Math.round(billed / mins).toLocaleString('en-US')}/min`));
    out.push(`   ${' '.repeat(14)}${dim(`${fmtCompact(w.window_cache_read_tokens)} cache reads, not counted (~1/10 the price)`)}`);
  } else {
    out.push(`   ${dim('Last window'.padEnd(14))}${dim('— no session active in the window')}`);
  }
  const at = nt.all_time;
  if (at) {
    const billed = at.fresh_tokens + at.output_tokens;
    out.push(`   ${dim('All time'.padEnd(14))}${cyanBold(`${fmtCompact(billed)} tok`.padEnd(14))}`
      // Name BOTH producers. The total bills sessions AND agents, but the label said "N sessions"
      // only — so the reader divided a two-population total by one population. And say WHEN "all
      // time" starts: without it the figure has no denominator in time either.
      + dim(`${fmtCompact(at.fresh_tokens)} in + ${fmtCompact(at.output_tokens)} out · ${fmtCount(at.sessions)} sessions`
        + (at.agents ? ` + ${fmtCount(at.agents)} agents` : '')
        + (at.oldest_epoch_ms ? ` since ${new Date(at.oldest_epoch_ms).toISOString().slice(0, 10)}` : '')));
    out.push(`   ${' '.repeat(14)}${dim(`${fmtCompact(at.cache_read_tokens)} cache reads, not counted`)}`);
  } else {
    // Reported null until the first full scan lands, rather than a small wrong number
    // that later jumps — a cold scan over a few thousand transcripts takes ~20s.
    out.push(`   ${dim('All time'.padEnd(14))}${dim('computing…')}`);
  }
  return out;
}

/** The number a top-list is RANKED by, which is therefore the number it must PRINT.
 *  Top surfaced ranks on total bumps; Top recalled ranks on drill bumps alone
 *  (see collapseTop's totalMetric / drillMetric — these must stay in step with it). */
const totalRank = (r: RecallTopEntry): number => r.from_auto + r.from_search + r.from_drill;
const drillRank = (r: RecallTopEntry): number => r.from_drill;

function renderTopList(
  heading: string, entries: RecallTopEntry[], colWidth: number,
  rank: (r: RecallTopEntry) => number = totalRank,
): string[] {
  const out: string[] = [];
  // Heading in cyan (matches section heads), not bold — keeps the live
  // values in the entries below visually heavier.
  out.push(`   ${cyan(heading.padEnd(14))}`);
  for (const r of entries) {
    out.push(...renderRecallEntry(r, colWidth, rank));
  }
  return out;
}

/** Render one top-list entry: count line + provenance breakdown line.
 *  Prefix structure (visible chars): 5 + 4 + 2 + type.length + 1 = 12 + type.
 */
function renderRecallEntry(
  r: RecallTopEntry, colWidth = 64, rank: (e: RecallTopEntry) => number = totalRank,
): string[] {
  const count = `${rank(r)}×`.padStart(4);
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
