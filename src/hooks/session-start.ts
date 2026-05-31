import { readStdinJson, writeStdout, workerFetch, logHookError, workerFailureMessage } from './shared.ts';
import { DEFAULT_HOOK_TIMEOUT_MS, ENV_HOOK_TIMEOUT_MS, DEFAULT_WORKER_PORT } from '../shared/paths.ts';
import { VERSION } from '../shared/version.ts';
import { ensureWorkerHealthy } from '../shared/worker-health.ts';
import { acquireHealLock, releaseHealLock } from '../shared/worker-heal-lock.ts';

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
  disk?: { bytes: number; path: string };
  version?: string;
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[i]}`;
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
  if (stats.disk) {
    lines.push(`  Disk       ${fmtBytes(stats.disk.bytes)}  (${stats.disk.path})`);
  }
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

// Shown instead of falling silent when /stats can't be reached. The original
// v0.2.3 outage was confusing precisely because a missing banner could mean
// EITHER "worker down" OR "hook broken" — this names which it is, and points at
// the log. Memory resumes automatically once the worker answers again.
function formatDegradedBanner(detail: string): string {
  return [
    '',
    '',
    '⚓ Captain Memo — worker unreachable',
    '─'.repeat(60),
    `  Memory is paused this session (${detail}).`,
    '  Search and observation capture resume automatically once the worker is back.',
    '  Details: ~/.captain-memo/logs/hook.log',
    '',
  ].join('\n');
}

export async function main(): Promise<void> {
  // Payload is unused (the banner needs no input) — we only drain stdin. A parse
  // failure is non-fatal but worth a log line so a payload-shape change is visible.
  try { await readStdinJson<SessionStartPayload>(); } catch (err) { logHookError('SessionStart', err); }

  // SessionStart isn't on a hot path — it fires once per session, not per
  // prompt. Use a generous timeout so the banner appears even when the
  // worker is heavily contended. Override via CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS.
  const timeoutMs = Number(
    process.env.CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS
    ?? process.env[ENV_HOOK_TIMEOUT_MS]
    ?? 10_000,
  );

  async function probeStats() {
    return workerFetch<StatsResponse>('/stats', { method: 'GET', timeoutMs });
  }

  let stats = await probeStats();

  // Self-heal: start a dead worker / restart a stale one (running code older than
  // the installed VERSION), then re-probe. Routed through the OS service manager
  // (it owns the process — nothing is orphaned when this short-lived hook exits).
  // We block here, because SessionStart fires once per session and a live worker
  // on entry is worth the wait. Fully fail-open: any error → degraded banner
  // below, never a thrown hook. Opt out with CAPTAIN_MEMO_DISABLE_SELF_HEAL=1.
  const selfHealOff = process.env.CAPTAIN_MEMO_DISABLE_SELF_HEAL === '1';
  const running = stats.ok && !!stats.body;
  const stale = running && stats.body!.version !== undefined && stats.body!.version !== VERSION;
  if (!selfHealOff && (!running || stale)) {
    try {
      const { getServiceManager } = await import('../services/service-manager/index.ts');
      const sm = getServiceManager();
      const WORKER = 'captain-memo-worker';
      const port = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
      const outcome = await ensureWorkerHealthy({
        diskVersion: VERSION,
        probeVersion: async () => (running ? (stats.body!.version ?? null) : null),
        acquireLock: () => acquireHealLock(),
        releaseLock: () => releaseHealLock(),
        start: () => sm.start(WORKER),
        restart: async () => { await sm.stop(WORKER, { graceful: true, port }); await sm.start(WORKER); },
        waitHealthy: async () => {
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            const r = await workerFetch<StatsResponse>('/stats', { method: 'GET', timeoutMs: 1500 });
            if (r.ok) { stats = r; return true; }
            await new Promise((res) => setTimeout(res, 500));
          }
          return false;
        },
      });
      if (outcome.action === 'skipped') {
        // Another session is healing — give it a moment, then re-probe for the banner.
        await new Promise((res) => setTimeout(res, 1500));
        stats = await probeStats();
      } else if (outcome.action === 'failed') {
        logHookError('SessionStart', new Error(`self-heal ${outcome.reason} failed: ${outcome.error}`));
      } else if ((outcome.action === 'started' || outcome.action === 'restarted') && !outcome.healthy) {
        // The supervisor accepted the start/restart, but the worker never answered
        // within the deadline (crash-loop on boot: bad env, port in use, corrupt DB).
        // Without this, that's indistinguishable in the log from "never tried".
        logHookError('SessionStart', new Error(
          `self-heal ${outcome.action} the worker but it did not become healthy within 8s (reason: ${outcome.reason})`,
        ));
      }
    } catch (err) {
      logHookError('SessionStart', err);
    }
  }

  if (stats.ok && stats.body) {
    // Claude Code's SessionStart hook protocol expects a JSON envelope on
    // stdout. The `systemMessage` field becomes the visible banner shown
    // to both user and model under "SessionStart:startup says: …". Plain
    // text on stdout is silently discarded.
    writeStdout(JSON.stringify({
      continue: true,
      systemMessage: formatBanner(stats.body),
    }));
  } else {
    // Worker unreachable / timed out / errored / empty body: log it AND tell the
    // user, rather than emitting nothing (which reads as "memory broke"). We log
    // unconditionally here (not via logWorkerFailure, which no-ops on ok) so the
    // log line and the banner always stay in lockstep — including the near-dead
    // ok-but-no-body corner. Still fail-open: a systemMessage never blocks the session.
    logHookError('SessionStart', new Error(workerFailureMessage('/stats', stats) ?? 'worker /stats returned no body'));
    writeStdout(JSON.stringify({
      continue: true,
      systemMessage: formatDegradedBanner(stats.timedOut ? 'worker timed out' : 'worker not reachable'),
    }));
  }
}

if (import.meta.main) {
  main().catch((err) => {
    logHookError('SessionStart', err);
    process.exit(0);
  });
}
