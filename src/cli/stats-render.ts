import { bold, cyanBold, dim, gold, goldBold, green, red, yellow } from '../shared/ansi.ts';
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

const PANEL_WIDTH = 60;
const BAR_WIDTH = 20;

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

/** "  TITLE ──────…" drawn to PANEL_WIDTH. */
function sectionRule(title: string): string {
  const prefix = `  ${title} `;
  const dashes = '─'.repeat(Math.max(0, PANEL_WIDTH - prefix.length));
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

function headerPanel(version: string): string[] {
  const inner = PANEL_WIDTH - 2;
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

export function renderStats(stats: StatsResponse): string[] {
  const out: string[] = [];
  out.push(...headerPanel(stats.version ?? 'unknown'));
  out.push('');
  out.push(`  ${dim('Project'.padEnd(10))} ${stats.project_id}`);
  out.push(`  ${dim('Indexing'.padEnd(10))} ${statusDot(stats.indexing.status)} ${indexingText(stats.indexing)}`);
  out.push(`  ${dim('Embedder'.padEnd(10))} ${stats.embedder.model} ${dim('·')} ${stats.embedder.endpoint}`);
  if (stats.disk) {
    out.push(`  ${dim('Disk'.padEnd(10))} ${fmtBytes(stats.disk.bytes)}`);
  }
  out.push('');

  // CORPUS
  out.push(sectionRule('CORPUS'));
  const channels = Object.entries(stats.by_channel);
  const maxCount = Math.max(1, ...channels.map(([, c]) => c));
  for (const [channel, count] of channels) {
    const b = gold(bar(count / maxCount, BAR_WIDTH));
    out.push(`   ${channel.padEnd(14)}${fmtCount(count).padStart(9)}   ${b}`);
  }
  out.push(`   ${dim('─'.repeat(23))}`);
  out.push(`   ${'Total'.padEnd(14)}${fmtCount(stats.total_chunks).padStart(9)}`
    + `     ${dim(`${fmtCount(stats.observations.total)} observations`)}`);
  out.push('');

  // EFFICIENCY
  if (stats.efficiency) {
    const { corpus, embedder, dedup } = stats.efficiency;
    out.push(sectionRule('EFFICIENCY'));
    if (corpus.ratio === null || corpus.saved_pct === null) {
      out.push(`   ${'Compression'.padEnd(14)}${dim('— populating… (restart worker)')}`);
    } else {
      const b = green(bar(corpus.saved_pct / 100, BAR_WIDTH));
      out.push(`   ${'Compression'.padEnd(14)}${goldBold(`${corpus.ratio}×`.padEnd(7))}  ${b}  ${corpus.saved_pct}%`);
      out.push(`   ${' '.repeat(14)}${dim(`distilled ${fmtCount(corpus.work_tokens)} → ${fmtCount(corpus.stored_tokens)} tokens`
        + ` · ${corpus.coverage.with_data}/${corpus.coverage.total} obs`)}`);
    }
    out.push(`   ${'Embedder'.padEnd(14)}` + (embedder.calls > 0
      ? `${embedder.calls} calls ${dim('·')} ~${embedder.avg_latency_ms} ms ${dim('·')} ${fmtCount(embedder.tokens_per_s)} tok/s`
      : dim('— no embeds since worker start')));
    out.push(`   ${'Dedup'.padEnd(14)}` + (dedup.docs_seen > 0
      ? `${dedup.skip_pct}%   ${dim(`${fmtCount(dedup.skipped_unchanged)} / ${fmtCount(dedup.docs_seen)} unchanged`)}`
      : dim('— no documents indexed since worker start')));
    out.push('');
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
    out.push(sectionRule('RECALL'));
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
      out.push(`   ${'Surfaced'.padEnd(14)}${goldBold(fmtCount(surfaced_count))} / ${fmtCount(total)}`
        + `   ${dim(`(${sPct}% of corpus)`)}`);
      out.push(`   ${'Recalled'.padEnd(14)}${goldBold(fmtCount(recalled_count))} / ${fmtCount(total)}`
        + `   ${dim(`(${rPct}% of corpus)`)}`);
      out.push(`   ${'Drill-in rate'.padEnd(14)}${goldBold(`${drillRate}%`)}`
        + `   ${dim(`(${recalled_count}/${surfaced_count} recalled out of surfaced)`)}`);

      if (recall.top_surfaced.length > 0) {
        out.push('');
        out.push(`   ${'Top surfaced'.padEnd(14)}`);
        for (const r of recall.top_surfaced) {
          out.push(...renderRecallEntry(r));
        }
      }
      if (recall.top_recalled.length > 0) {
        out.push('');
        out.push(`   ${'Top recalled'.padEnd(14)}`);
        for (const r of recall.top_recalled) {
          out.push(...renderRecallEntry(r));
        }
      }
    }
    out.push('');
  }

  return out;
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

/** Render one top-list entry: count line + provenance breakdown line. */
function renderRecallEntry(r: RecallTopEntry): string[] {
  const titleTrim = r.title.length > 48 ? r.title.slice(0, 47) + '…' : r.title;
  const total = r.from_auto + r.from_search + r.from_drill;
  const count = `${total}×`.padStart(4);
  const breakdown = dim(
    `auto: ${r.from_auto}   search: ${r.from_search}   drill: ${r.from_drill}`,
  );
  return [
    `     ${gold(count)}  ${dim(`[${r.type}]`)} ${titleTrim}`,
    `           ${breakdown}`,
  ];
}
