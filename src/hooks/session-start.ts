import { readStdinJson, writeStdout, workerFetch, logHookError } from './shared.ts';
import { DEFAULT_HOOK_TIMEOUT_MS, ENV_HOOK_TIMEOUT_MS } from '../shared/paths.ts';

interface SessionStartPayload {
  session_id?: string;
  cwd?: string;
  source?: 'startup' | 'resume' | 'compact' | string;
}

interface StatsResponse {
  total_chunks: number;
  by_channel: Record<string, number>;
  observations: { total: number; queue_pending: number; queue_processing: number };
  indexing: {
    status: 'idle' | 'indexing' | 'ready' | 'error';
    total: number;
    done: number;
    errors: number;
    percent: number;
  };
  project_id: string;
  embedder: { model: string; endpoint: string };
  version?: string;
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function formatBanner(stats: StatsResponse): string {
  const lines: string[] = [];
  const ver = stats.version ? ` v${stats.version}` : '';
  lines.push(`⚓ Captain Memo${ver} · ${stats.project_id} · ${fmtNum(stats.total_chunks)} chunks indexed`);
  const byCh = Object.entries(stats.by_channel)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${fmtNum(v)}`)
    .join(', ');
  if (byCh) lines.push(`  channels: ${byCh}`);

  const idx = stats.indexing;
  if (idx.status === 'indexing') {
    lines.push(`  indexing: ${fmtNum(idx.done)}/${fmtNum(idx.total)} (${idx.percent}%)`);
  } else if (idx.status === 'error') {
    lines.push(`  indexing: error — ${idx.errors} files failed`);
  }
  // 'ready' / 'idle' don't add a noisy line

  const o = stats.observations;
  if (o.queue_pending > 0 || o.queue_processing > 0) {
    lines.push(`  obs queue: pending=${o.queue_pending} processing=${o.queue_processing} (drains every 5s)`);
  }

  // Embedder line only shows host (not full URL with secrets)
  const host = stats.embedder.endpoint.replace(/^https?:\/\//, '').split('/')[0] ?? '?';
  lines.push(`  embedder: ${stats.embedder.model} @ ${host}`);
  lines.push(`  retrieval: silent envelope on each prompt (top-5)`);
  return lines.join('\n');
}

export async function main(): Promise<void> {
  try { await readStdinJson<SessionStartPayload>(); } catch { /* ignore */ }
  // SessionStart isn't on a hot path — it fires once per session, not per
  // prompt. Use a much more generous timeout than the hook default so the
  // banner appears even when the worker is heavily contended (summarizer
  // draining a backlog, embedder under load, etc.). Override available via
  // CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS for very slow installs.
  const timeoutMs = Number(
    process.env.CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS
    ?? process.env[ENV_HOOK_TIMEOUT_MS]
    ?? 10_000,
  );

  // Fetch corpus stats and print a one-paragraph banner. SessionStart's stdout
  // becomes a system-reminder shown to both user and model.
  const stats = await workerFetch<StatsResponse>('/stats', {
    method: 'GET',
    timeoutMs,
  });
  if (stats.ok && stats.body) {
    writeStdout(formatBanner(stats.body));
  }
}

if (import.meta.main) {
  main().catch((err) => {
    logHookError('SessionStart', err);
    process.exit(0);
  });
}
