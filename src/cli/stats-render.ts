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
}

const PANEL_WIDTH = 57;
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
  // ⚓ renders 2 columns but is 1 string char — count one extra display column.
  const plain = `  ⚓  CAPTAIN MEMO        corpus statistics   ·   v${version}`;
  const displayWidth = plain.length + 1;
  const pad = ' '.repeat(Math.max(1, inner - displayWidth));
  const content =
    '  ' + goldBold('⚓  CAPTAIN MEMO')
    + dim('        corpus statistics   ·   ')
    + bold(`v${version}`) + pad;
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
      out.push(`   ${'Compression'.padEnd(14)}${goldBold(`${corpus.ratio}×`).padEnd(8)}  ${b}  ${corpus.saved_pct}%`);
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

  return out;
}
