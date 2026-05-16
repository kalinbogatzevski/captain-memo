import { workerGet } from '../client.ts';
import { fmtBytes, fmtElapsed } from '../../shared/format.ts';
import type { EfficiencyReport } from '../../worker/efficiency.ts';

interface StatsResponse {
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
  efficiency?: EfficiencyReport;
}

function indexingLine(idx: StatsResponse['indexing']): string {
  if (idx.status === 'idle') return 'idle (no watch paths configured)';
  if (idx.status === 'indexing') {
    const rate = idx.elapsed_s > 0 ? (idx.done / idx.elapsed_s).toFixed(2) : '?';
    const remaining = (idx.total - idx.done) > 0 && idx.done > 0
      ? fmtElapsed(Math.ceil((idx.total - idx.done) * idx.elapsed_s / idx.done))
      : '?';
    return `\x1b[33mindexing\x1b[0m  ${idx.done}/${idx.total} (${idx.percent}%)  rate=${rate}/s  ETA=${remaining}`;
  }
  if (idx.status === 'ready') {
    return `\x1b[32mready\x1b[0m  indexed ${idx.done}/${idx.total} in ${fmtElapsed(idx.elapsed_s)}${idx.errors > 0 ? `  \x1b[31m${idx.errors} errors\x1b[0m` : ''}`;
  }
  return `\x1b[31merror\x1b[0m  ${idx.last_error ?? 'unknown'}`;
}

/**
 * Render the "Efficiency" block for `captain-memo stats`. Returned as an array
 * of lines (already coloured) so it is unit-testable without capturing stdout.
 */
export function formatEfficiencyLines(eff: EfficiencyReport): string[] {
  const lines: string[] = ['Efficiency', '──────────'];

  const c = eff.corpus;
  if (c.ratio === null || c.saved_pct === null) {
    lines.push(`  Compression:    \x1b[33m— (run 'captain-memo reindex' to populate)\x1b[0m`);
  } else {
    lines.push(
      `  Compression:    ${c.ratio}× — distilled ${c.work_tokens.toLocaleString()} tokens ` +
      `of work into ${c.stored_tokens.toLocaleString()} stored`,
    );
    lines.push(
      `                  (${c.saved_pct}% saved · based on ` +
      `${c.coverage.with_data}/${c.coverage.total} observations)`,
    );
  }

  const e = eff.embedder;
  lines.push(e.calls > 0
    ? `  Embedder:       ${e.calls} calls · ~${e.avg_latency_ms} ms avg · ` +
      `${e.tokens_per_s.toLocaleString()} tok/s   (since worker start)`
    : `  Embedder:       — (no embeds since worker start)`);

  const d = eff.dedup;
  lines.push(d.docs_seen > 0
    ? `  Dedup:          ${d.skip_pct}% of docs skipped re-embed ` +
      `(${d.skipped_unchanged}/${d.docs_seen} unchanged)`
    : `  Dedup:          — (no documents indexed since worker start)`);

  return lines;
}

export async function statsCommand(args: string[] = []): Promise<number> {
  const stats = await workerGet('/stats') as StatsResponse;
  if (args.includes('--json')) {
    console.log(JSON.stringify(stats));
    return 0;
  }
  console.log('\x1b[1;36mCaptain Memo — corpus statistics\x1b[0m');
  console.log('───────────────────────────────────');
  console.log(`Project:        ${stats.project_id}`);
  console.log(`Version:        ${stats.version ?? 'unknown'}`);
  console.log(`Indexing:       ${indexingLine(stats.indexing)}`);
  console.log(`Total chunks:   ${stats.total_chunks}`);
  console.log('By channel:');
  for (const [channel, count] of Object.entries(stats.by_channel)) {
    console.log(`  ${channel.padEnd(14)} ${count}`);
  }
  if (stats.observations) {
    console.log(`Observations:   ${stats.observations.total} total · ${stats.observations.queue_pending} pending · ${stats.observations.queue_processing} processing`);
  }
  console.log(`Embedder:       ${stats.embedder.model} @ ${stats.embedder.endpoint}`);
  if (stats.disk) {
    console.log(`Disk used:      ${fmtBytes(stats.disk.bytes)}  (${stats.disk.path})`);
  }
  if (stats.efficiency) {
    console.log('');
    for (const line of formatEfficiencyLines(stats.efficiency)) console.log(line);
  }
  return 0;
}
