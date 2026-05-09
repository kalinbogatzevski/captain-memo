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
  const ver = stats.version ? ` v${stats.version}` : '';
  const lines: string[] = [
    '',
    '',
    `⚓ Captain Memo${ver}`,
    '─'.repeat(60),
  ];

  const byCh = Object.entries(stats.by_channel)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${fmtNum(v)}`)
    .join(', ');
  const corpusLine = byCh
    ? `${fmtNum(stats.total_chunks)} chunks (${byCh})`
    : `${fmtNum(stats.total_chunks)} chunks`;

  const host = stats.embedder.endpoint.replace(/^https?:\/\//, '').split('/')[0] ?? '?';

  lines.push(`  Project    ${stats.project_id}`);
  lines.push(`  Corpus     ${corpusLine}`);
  lines.push(`  Embedder   ${stats.embedder.model} @ ${host}`);
  lines.push(`  Retrieval  silent envelope on each prompt (top-5)`);

  // Conditional lines — only show when there's something to flag
  const idx = stats.indexing;
  if (idx.status === 'indexing') {
    lines.push(`  Indexing   ${fmtNum(idx.done)}/${fmtNum(idx.total)} (${idx.percent}%)`);
  } else if (idx.status === 'error') {
    lines.push(`  Indexing   error — ${idx.errors} files failed`);
  }
  const o = stats.observations;
  if (o.queue_pending > 0 || o.queue_processing > 0) {
    lines.push(`  Obs queue  pending=${o.queue_pending} processing=${o.queue_processing} (drains every 5s)`);
  }

  lines.push('');
  return lines.join('\n');
}

export async function main(): Promise<void> {
  try { await readStdinJson<SessionStartPayload>(); } catch { /* ignore */ }

  // SessionStart isn't on a hot path — it fires once per session, not per
  // prompt. Use a generous timeout so the banner appears even when the
  // worker is heavily contended. Override via CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS.
  const timeoutMs = Number(
    process.env.CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS
    ?? process.env[ENV_HOOK_TIMEOUT_MS]
    ?? 10_000,
  );

  const stats = await workerFetch<StatsResponse>('/stats', {
    method: 'GET',
    timeoutMs,
  });

  if (stats.ok && stats.body) {
    // Claude Code's SessionStart hook protocol expects a JSON envelope on
    // stdout. The `systemMessage` field becomes the visible banner shown
    // to both user and model under "SessionStart:startup says: …". Plain
    // text on stdout is silently discarded.
    writeStdout(JSON.stringify({
      continue: true,
      systemMessage: formatBanner(stats.body),
    }));
  }
}

if (import.meta.main) {
  main().catch((err) => {
    logHookError('SessionStart', err);
    process.exit(0);
  });
}
