import { workerGet } from '../client.ts';
import { fmtElapsed } from '../../shared/format.ts';

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
  embedder: { model: string; endpoint: string };
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

export async function statsCommand(): Promise<number> {
  const stats = await workerGet('/stats') as StatsResponse;
  console.log('\x1b[1;36mCaptain Memo — corpus statistics\x1b[0m');
  console.log('───────────────────────────────────');
  console.log(`Project:        ${stats.project_id}`);
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
  return 0;
}
