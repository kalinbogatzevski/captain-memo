// src/dreaming/report.ts
//
// Plain-text renderer for the dry-run report. Mirrors the section style used
// by stats-render.ts (ANSI dim/gold headings) so the output reads as part of
// the same CLI family. Pure: takes a DreamReport, returns string lines.

import { bold, cyanBold, dim, gold, goldBold } from '../shared/ansi.ts';
import { maxBridgeableGapDays } from './distance.ts';
import type { DreamReport } from './orchestrate.ts';

const RULE = '─'.repeat(60);

function fmtDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function trimTitle(t: string, max = 56): string {
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function renderReport(report: DreamReport): string[] {
  const out: string[] = [];

  out.push('');
  out.push(cyanBold(`  DREAM — DRY RUN `) + dim(RULE.slice(15)));
  out.push(`  ${dim('cluster preview — no writes, no Haiku')}`);
  out.push('');

  // Inputs summary
  out.push(`  ${dim('Observations')}      ${goldBold(String(report.total))}`);
  out.push(`  ${dim('Without co-recall')} ${report.withoutCoRetrieval}`
    + `   ${dim(`(${fmtPct(report.withoutCoRetrieval / Math.max(1, report.total))} of input — high % means audit log is thin)`)}`);
  out.push(`  ${dim('eps / minPts / τ')}  ${report.opts.eps} / ${report.opts.minPts} / ${Math.round(report.opts.tauSeconds / 86400)}d`);
  // Three decimals, not two: the renormalized weights are exact thirds-of-eights
  // (0.375 / 0.625) and toFixed(2) rendered 0.3/0.8 as "0.37" — the float is
  // 0.37499999999999994, so rounding at 2dp lost the value it was reporting.
  out.push(`  ${dim('Signal weights')}    `
    + `semantic=${report.weights.semantic.toFixed(3)}  `
    + `temporal=${report.weights.temporal.toFixed(3)}  `
    + `coRet=${report.weights.coRetrieval.toFixed(3)}`);
  // The eps/τ pair silently caps how far apart two observations can be and still
  // cluster, no matter how strong the co-retrieval. Print it rather than let
  // someone widen --since and wonder why the extra weeks produced nothing.
  const bridge = maxBridgeableGapDays(report.opts.eps, report.opts.tauSeconds, report.weights);
  out.push(`  ${dim('Max pair age gap')}  `
    + (Number.isFinite(bridge)
      ? `${bridge.toFixed(1)}d   ${dim('(pairs further apart cannot cluster at any co-retrieval — raise --tau-days to widen)')}`
      : dim('unbounded (co-retrieval alone clears eps)')));
  out.push('');

  // Cluster summary
  out.push(cyanBold(`  RESULT `) + dim(RULE.slice(8)));
  out.push(`  ${dim('Clusters discovered')}  ${goldBold(String(report.clusters.length))}`);
  const members = report.clusters.reduce((acc, c) => acc + c.members.length, 0);
  out.push(`  ${dim('Would-archive total')}  ${goldBold(String(members))}`);
  out.push(`  ${dim('Noise (singletons)')}   ${report.noise.length}`);
  out.push('');

  if (report.clusters.length === 0) {
    out.push(`  ${dim('No clusters at this eps/minPts. Try --eps 0.45 --min-pts 2 to loosen.')}`);
    out.push('');
    return out;
  }

  // Per-cluster detail. Sort by co-occurrence weight desc so the strongest
  // candidates surface first — gives the reviewer the highest-confidence
  // clusters to validate before scrolling.
  const sorted = [...report.clusters].sort((a, b) => b.coOccurrenceWeight - a.coOccurrenceWeight);

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    const span = `${fmtDate(c.span.from)} → ${fmtDate(c.span.to)}`;
    out.push(bold(`  Cluster ${i + 1}`)
      + `  ${dim('·')}  ${c.members.length} members`
      + `  ${dim('·')}  ${span}`
      + `  ${dim('·')}  ${dim(`coOcc=${c.coOccurrenceWeight}`)}`);

    // Show up to 5 sample titles per cluster — enough to eyeball whether
    // they belong together without flooding the report.
    const samples = c.members.slice(0, 5);
    for (const m of samples) {
      out.push(`     ${gold(`#${m.id}`)}  ${dim(`[${m.type}]`)} ${trimTitle(m.title)}`);
    }
    if (c.members.length > 5) {
      out.push(`     ${dim(`… +${c.members.length - 5} more`)}`);
    }
    out.push('');
  }

  return out;
}
